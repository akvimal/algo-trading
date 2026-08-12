"""A Strategy here is the unit of configuration for a signal source
(external webhook provider, or eventually an in-house engine) - not to be
confused with signal-processing's option-strategy selection (spread /
straddle / etc, a completely different concern living in
signal-processing/app/domain/resolution/strategy.py).

No position-size/capital field here - that's still owned by execution
(capital_per_trade in its settings). Stop-loss/target ARE here, though,
as a deliberate exception: unlike a flat capital figure, stop distance
genuinely varies by strategy/scan/timeframe, so the *method* lives with
"what produces a signal" while execution still owns the actual sizing
arithmetic (capital cap, risk %) and the live exit-monitoring loop. See
docs/architecture.md."""

from datetime import datetime, time
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

SourceType = Literal["chartink", "tradingview", "in_house"]
Horizon = Literal["intraday", "swing", "positional"]
InstrumentType = Literal["spot", "future", "option"]
Status = Literal["draft", "backtesting", "live", "paused"]
Interval = Literal["1min", "3min", "5min", "15min", "30min", "60min", "daily"]
StopLossMethod = Literal["previous_candle", "percent"]
# Matches Dhan's actual supported intraday-candle intervals for the
# charts/intraday API (1/5/15/25/60 - no 30, no daily): a deliberate
# leak of the one provider's capabilities, consistent with this codebase
# already hardcoding to Dhan/NSE elsewhere (see market-data's DhanProvider).
StopLossInterval = Literal["1min", "5min", "15min", "25min", "60min"]
# Which market this strategy trades in - distinct from `exchange` (which
# is still fixed to "NSE" today, the only one actually wired up
# end-to-end in execution/market-data - see docs/architecture.md). Only
# used here to pick a sensible square_off_time default; MCX/CRYPTO can be
# selected as intent even though nothing downstream trades them yet.
Segment = Literal["NSE", "MCX", "CRYPTO"]
# Signal-conflict policy, per-strategy - passed through unchanged on
# resolved-order to execution's position_manager._resolve_signal_conflicts.
# duplicate_signal_policy governs a SAME-direction signal arriving while
# this symbol already has an OPEN position: 'skip' rejects it,
# 'add_position' opens an independent additional position (pyramiding).
# counter_signal_policy governs an OPPOSITE-direction signal arriving:
# 'skip' leaves the existing position untouched, 'close_and_flip' closes
# it (ahead of its own stop-loss/target/square-off) before the new one opens.
DuplicateSignalPolicy = Literal["skip", "add_position"]
CounterSignalPolicy = Literal["skip", "close_and_flip"]
# in_house only. 'symbol': underlying names one traded symbol, as today.
# 'universe': underlying instead names an NSE index-constituent group
# (e.g. "NIFTYBANK", resolved via market-data's GET
# /instruments/universe/constituents) - the engine evaluates this
# strategy's rule against every constituent independently, each with its
# own dedupe state (see signal_generation.engine_runs). Universes are NSE
# cash-equity index membership lists only, so this is only valid combined
# with segment='NSE' and instrument_type='spot' - see
# validate_underlying_type_fields.
UnderlyingType = Literal["symbol", "universe"]

# The 5 sub-conditions app/domain/regime.py's classify_regime combines -
# mirrors regime.REGIME_CHECK_NAMES exactly. When regime_filter_enabled,
# only these named checks must agree to confirm a signal's direction
# (regime.direction_confirmed) - defaults to all 5 below.
RegimeCheckName = Literal["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"]
_ALL_REGIME_CHECK_NAMES: list[RegimeCheckName] = ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"]

# Square-off time defaults by (horizon=='intraday', segment) - MCX runs
# later than NSE cash equity, crypto's cutoff is a fixed business rule
# rather than a real market-close (crypto trades 24/7). No default exists
# for non-intraday horizons - square_off_time must be given explicitly there.
DEFAULT_SQUARE_OFF_TIME_BY_SEGMENT: dict[str, time] = {
    "NSE": time(15, 0),
    "MCX": time(22, 0),
    "CRYPTO": time(17, 25),
}


def default_square_off_time(horizon: str, segment: str) -> Optional[time]:
    if horizon != "intraday":
        return None
    return DEFAULT_SQUARE_OFF_TIME_BY_SEGMENT.get(segment)


IndicatorType = Literal["rsi"]


class RsiParams(BaseModel):
    """`sma_period` is RSI's own signal line (SMA of RSI) - bundled into
    the indicator's own definition rather than a separate rule parameter,
    matching how TradingView's own RSI script bundles "RSI Length" and
    "MA Length" into one indicator's settings, not two."""

    period: int = Field(gt=1)
    sma_period: int = Field(gt=1)


# Union[RsiParams] collapses to RsiParams today - kept as a Union alias so
# a second indicator type later is `Union[RsiParams, MacdParams]` without
# renaming anything that already imports IndicatorParams. Indicators are
# their own entity (signal_generation.indicators) so one definition (e.g.
# "RSI 14") can be reused by any number of strategies - see
# docs/architecture.md.
IndicatorParams = Union[RsiParams]
_indicator_params_adapter = TypeAdapter(IndicatorParams)


def validate_indicator_params(indicator_type: str, raw: dict) -> RsiParams:
    """Raises pydantic.ValidationError (a 422 at the route layer) if `raw`
    doesn't match `indicator_type`'s expected shape. `indicator_type`
    itself isn't validated here (the DB CHECK constraint + IndicatorType
    already constrain it) - this only validates params."""
    return _indicator_params_adapter.validate_python(raw)


class IndicatorCreate(BaseModel):
    name: str = Field(min_length=1)
    type: IndicatorType
    params: dict

    @model_validator(mode="after")
    def _check_params(self) -> "IndicatorCreate":
        validate_indicator_params(self.type, self.params)
        return self


class IndicatorUpdate(BaseModel):
    """PATCH /indicators/{id} - type isn't editable after creation (same
    pattern as Strategy.source_type/exchange). params, if provided, is
    validated against the indicator's EXISTING type by the route handler
    (it doesn't know the type at this model level)."""

    name: Optional[str] = Field(default=None, min_length=1)
    params: Optional[dict] = None


class IndicatorOut(BaseModel):
    id: str
    name: str
    type: IndicatorType
    params: dict
    created_at: datetime
    updated_at: datetime


class CrossoverRuleConfig(BaseModel):
    """The only rule type today: fires when the referenced indicator's own
    value crosses its own signal line on the latest completed bar - both
    series come from the indicator itself (app/domain/indicators.py's
    compute_indicator/compute_indicator_signal), so this rule carries no
    parameters of its own beyond which indicator to use. Deliberately
    generic: "value crosses signal" isn't specific to RSI, it'll work
    unchanged for any future indicator that exposes its own signal line
    (e.g. MACD's own signal line). `type` is a discriminator - adding a
    second rule (or a multi-indicator combination) later means a new
    variant to RuleConfig below and its own evaluate_* function in
    app/domain/rules.py, not a schema migration (rule_config is stored as
    JSONB, not dedicated columns)."""

    type: Literal["crossover"] = "crossover"
    indicator_id: str


class BreakoutRuleConfig(BaseModel):
    """A second, structurally independent rule type: a multi-timeframe
    Donchian breakout - carries no indicator_id at all (no Indicator
    involved). A higher-timeframe (HTF) N-bar high/low breakout arms an
    entry window valid only until the next HTF candle closes; within that
    window, the first lower-timeframe (LTF) candle to itself break its own
    N-bar high/low triggers entry. Optionally also requires the HTF close
    be above/below a single EMA(ema_period). See app/domain/breakout.py
    for the full mechanics (entry, initial stop, and the separate
    reversal-exit condition) - this model only carries the shape,
    deliberately not reusing CrossoverRuleConfig's indicator-based
    machinery, which doesn't fit a two-timeframe, indicator-less rule."""

    type: Literal["breakout"] = "breakout"
    htf_interval: Interval
    htf_breakout_period: int = Field(gt=1)
    ltf_interval: Interval
    ltf_breakout_period: int = Field(gt=1)
    ema_filter_enabled: bool = False
    ema_period: int = Field(default=20, gt=1)


class RangeBreakoutRuleConfig(BaseModel):
    """A third, minimal rule type: a single-timeframe Donchian breakout -
    "close greater than the last N candles' high" (or below their low, for
    a bearish signal), on the strategy's own `interval`. No indicator, no
    higher/lower timeframe split, no rule-intrinsic exit scheme - unlike
    BreakoutRuleConfig (which needs its own bespoke stop-loss/reversal-exit
    handling for the live-enforcement-gap reasons documented in
    app/domain/breakout.py), this behaves like CrossoverRuleConfig for
    everything except how bias is computed: the strategy's own generically
    configured stop_loss_method/target_percent/square_off_time apply as-is.
    See app/domain/range_breakout.py, which reuses breakout.py's
    compute_donchian_high/low directly rather than duplicating that math.
    Named 'range_breakout', not 'breakout' - that type string already
    means the multi-timeframe rule above, in the DB and in existing
    strategies' stored rule_config."""

    type: Literal["range_breakout"] = "range_breakout"
    breakout_period: int = Field(gt=1)


RuleConfig = Union[CrossoverRuleConfig, BreakoutRuleConfig, RangeBreakoutRuleConfig]
_rule_config_adapter = TypeAdapter(RuleConfig)


def validate_rule_config(raw: dict) -> RuleConfig:
    """Raises pydantic.ValidationError (a 422 at the route layer) if `raw`
    doesn't match any known rule type's shape. Only validates shape - it
    does NOT check that a CrossoverRuleConfig's `indicator_id` actually
    refers to an existing Indicator row (that needs a DB session, so it's
    a route-layer check - see app/api/routes/strategies.py)."""
    return _rule_config_adapter.validate_python(raw)


def validate_in_house_fields(
    source_type: str,
    underlying: Optional[str],
    rule_config: Optional[dict],
    interval: Optional[str],
) -> None:
    """source_type='in_house' requires underlying/rule_config/interval all
    set - the engine needs a symbol to watch, a rule to evaluate, and a
    timeframe (interval was "purely descriptive" for webhook strategies;
    this is where it becomes load-bearing, see docs/architecture.md).
    Webhook source types get symbol/timing per-signal from the provider
    payload instead, so underlying/rule_config don't apply there."""
    if source_type == "in_house":
        if underlying is None:
            raise ValueError("source_type='in_house' requires underlying")
        if rule_config is None:
            raise ValueError("source_type='in_house' requires rule_config")
        if interval is None:
            raise ValueError("source_type='in_house' requires interval")
        validate_rule_config(rule_config)
    else:
        if underlying is not None:
            raise ValueError("underlying only applies to source_type='in_house'")
        if rule_config is not None:
            raise ValueError("rule_config only applies to source_type='in_house'")


def validate_underlying_type_fields(underlying_type: str, segment: str, instrument_type: str) -> None:
    """underlying_type='universe' only makes sense for NSE cash-equity
    index membership lists - no MCX/futures universe concept exists."""
    if underlying_type == "universe" and (segment != "NSE" or instrument_type != "spot"):
        raise ValueError("underlying_type='universe' requires segment='NSE' and instrument_type='spot'")


def validate_stop_loss_fields(
    method: Optional[str],
    interval: Optional[str],
    percent: Optional[float],
    trailing_enabled: bool,
) -> None:
    """Shared consistency rule for the stop-loss field group, used by both
    StrategyCreate (all fields always present) and the PATCH route handler
    (validated against the merged post-update row, since PATCH applies
    fields one at a time - see app/api/routes/strategies.py)."""
    if method is None:
        if interval is not None or percent is not None or trailing_enabled:
            raise ValueError("stop_loss_interval/stop_loss_percent/trailing_stop_enabled require a stop_loss_method")
    elif method == "previous_candle":
        if interval is None:
            raise ValueError("stop_loss_method='previous_candle' requires stop_loss_interval")
        if percent is not None:
            raise ValueError("stop_loss_method='previous_candle' must not set stop_loss_percent")
    elif method == "percent":
        if percent is None:
            raise ValueError("stop_loss_method='percent' requires stop_loss_percent")
        if interval is not None:
            raise ValueError("stop_loss_method='percent' must not set stop_loss_interval")


class StrategyCreate(BaseModel):
    name: str = Field(min_length=1)
    source_type: SourceType
    exchange: Literal["NSE"] = "NSE"
    horizon: Horizon
    instrument_type: InstrumentType
    interval: Optional[Interval] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    segment: Segment = "NSE"
    # Only meaningful for horizon='intraday' - square-off doesn't apply to
    # swing/positional strategies (positions aren't closed same-day), so
    # this stays null for them. Auto-defaulted from (horizon, segment)
    # when omitted on an intraday strategy - see default_square_off_time.
    square_off_time: Optional[time] = None
    # in_house only - the logical underlying to watch (e.g. "GOLDM",
    # "NIFTY") and the rule config (which indicator + how to decide from
    # it) to evaluate against it. See validate_in_house_fields.
    underlying: Optional[str] = Field(default=None, min_length=1)
    # in_house only - 'symbol' (default) means `underlying` names one
    # traded symbol as before; 'universe' means it names an NSE
    # index-constituent group instead. See UnderlyingType/
    # validate_underlying_type_fields above.
    underlying_type: UnderlyingType = "symbol"
    rule_config: Optional[dict] = None
    # in_house only (harmlessly ignored for webhook strategies) - see
    # app/domain/regime.py and docs/architecture.md.
    regime_filter_enabled: bool = False
    # Which of the 5 sub-conditions must agree when regime_filter_enabled -
    # defaults to all 5, matching classify_regime's own fixed "regime"
    # label exactly.
    regime_filter_checks: list[RegimeCheckName] = Field(default_factory=lambda: list(_ALL_REGIME_CHECK_NAMES))
    # Every source_type carries these, same as stop_loss_*/square_off_time -
    # see the DuplicateSignalPolicy/CounterSignalPolicy alias comments above.
    duplicate_signal_policy: DuplicateSignalPolicy = "add_position"
    counter_signal_policy: CounterSignalPolicy = "skip"

    @model_validator(mode="after")
    def _check_stop_loss_consistency(self) -> "StrategyCreate":
        validate_stop_loss_fields(
            self.stop_loss_method, self.stop_loss_interval, self.stop_loss_percent, self.trailing_stop_enabled
        )
        return self

    @model_validator(mode="after")
    def _check_in_house_consistency(self) -> "StrategyCreate":
        validate_in_house_fields(self.source_type, self.underlying, self.rule_config, self.interval)
        return self

    @model_validator(mode="after")
    def _check_underlying_type_consistency(self) -> "StrategyCreate":
        validate_underlying_type_fields(self.underlying_type, self.segment, self.instrument_type)
        return self

    @model_validator(mode="after")
    def _fill_square_off_time_default(self) -> "StrategyCreate":
        if self.horizon != "intraday":
            return self
        if self.square_off_time is None:
            default = default_square_off_time(self.horizon, self.segment)
            if default is None:
                raise ValueError(
                    "square_off_time is required (no default exists for this horizon/segment combination)"
                )
            self.square_off_time = default
        return self


class StrategyUpdate(BaseModel):
    """PATCH /strategies/{id} - all fields optional, only what's provided changes.
    source_type and exchange are deliberately not editable: source_type
    determines the webhook shape a provider is already configured against,
    and exchange only has one valid value today - both are set at create
    time only.

    The stop-loss field group (stop_loss_method/_interval/_percent,
    trailing_stop_enabled) is NOT cross-field-validated at this model
    level, since a PATCH may legitimately touch only one of them (e.g.
    just flipping trailing_stop_enabled). If stop_loss_method IS provided,
    the route handler treats stop_loss_interval/stop_loss_percent as the
    complete replacement pair for it (explicitly clearing whichever one
    the new method doesn't use), so switching methods in one PATCH call
    never leaves a stale value from the old method behind. There's no way
    to PATCH stop_loss_method back to NULL (disable SL) - same limitation
    the pre-existing `interval` field already has; delete+recreate the
    strategy if that's needed."""

    name: Optional[str] = Field(default=None, min_length=1)
    status: Optional[Status] = None
    horizon: Optional[Horizon] = None
    instrument_type: Optional[InstrumentType] = None
    interval: Optional[Interval] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: Optional[bool] = None
    segment: Optional[Segment] = None
    square_off_time: Optional[time] = None
    underlying: Optional[str] = Field(default=None, min_length=1)
    underlying_type: Optional[UnderlyingType] = None
    rule_config: Optional[dict] = None
    regime_filter_enabled: Optional[bool] = None
    # Not provided = leave the row's existing value alone (same PATCH
    # semantics as every other field here) - a brand new strategy already
    # gets the full 5-check default from the DB column default, so this
    # only matters once someone has actually customized it.
    regime_filter_checks: Optional[list[RegimeCheckName]] = None
    duplicate_signal_policy: Optional[DuplicateSignalPolicy] = None
    counter_signal_policy: Optional[CounterSignalPolicy] = None


class BacktestGridRequest(BaseModel):
    """POST /strategies/{id}/backtest/grid body - which indicator params to
    sweep and what candidate values to try for each, e.g. {"period": [7,
    14, 21], "sma_period": [5, 9, 14]}. Any indicator param NOT named here
    stays fixed at the strategy's currently-referenced Indicator's own
    value - see app/domain/backtest.py's expand_grid/grid_search. Does not
    mutate the Indicator row; PATCH /indicators/{id} once you've picked a
    winner from the report."""

    param_grid: dict[str, list[int]] = Field(min_length=1)


class StrategyOut(BaseModel):
    id: str
    name: str
    source_type: SourceType
    exchange: str
    horizon: Horizon
    instrument_type: InstrumentType
    interval: Optional[Interval] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    segment: Segment
    square_off_time: Optional[time] = None
    underlying: Optional[str] = None
    underlying_type: UnderlyingType = "symbol"
    rule_config: Optional[dict] = None
    regime_filter_enabled: bool = False
    regime_filter_checks: list[RegimeCheckName] = Field(default_factory=lambda: list(_ALL_REGIME_CHECK_NAMES))
    duplicate_signal_policy: DuplicateSignalPolicy = "add_position"
    counter_signal_policy: CounterSignalPolicy = "skip"
    status: Status
    created_at: datetime
    updated_at: datetime

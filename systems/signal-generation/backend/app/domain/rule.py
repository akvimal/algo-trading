"""A Rule is a saved, reusable, independently-backtestable definition of
*when a signal should fire* - split out of Strategy (app/domain/models.py),
which only decides what happens once it does (instrument/segment to
trade, stop-loss/target, option shape, conflict policies). One Rule can
back many Strategies (e.g. the same crossover backing both a spot
Strategy and an option-spread Strategy on the same underlying) - see
docs/architecture.md's "Rules module" section.

Deliberately the leaf module here: nothing in this file imports from
app.domain.models, so Strategy can freely import Rule-related types
(Segment, RuleSummary) without a circular dependency. app/domain/rules.py/
breakout.py/range_breakout.py/indicators.py import their RuleConfig
variants from here now, unchanged otherwise - this file only relocates
existing shapes/validators, evaluation logic is untouched."""

from datetime import datetime, time
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

Interval = Literal["1min", "3min", "5min", "15min", "30min", "60min", "daily"]
# Which market this rule's condition/universe is evaluated against -
# distinct from a linked Strategy's own `segment` (what gets traded when
# it fires). Shared literal type, defined here (not app/domain/models.py)
# so Strategy can import it without this module depending back on
# Strategy's own module.
Segment = Literal["NSE", "MCX", "CRYPTO"]
# in_house only. 'symbol': underlying names one traded symbol. 'universe':
# underlying instead names an index-constituent group key (e.g.
# "NIFTYBANK", resolved via market-data's GET
# /instruments/universe/constituents) - the engine evaluates this rule
# against every constituent independently, each with its own dedupe state
# (see signal_generation.engine_runs, keyed by (strategy_id, symbol)).
# Universes are NSE cash-equity index membership lists only - see
# validate_rule_universe_fields. 'symbol_list': underlying instead holds a
# comma-separated list of explicit symbols (e.g. "GOLDM,SILVER,CRUDEOIL") -
# added for segments like MCX with no index/universe concept at all, where
# the user still wants one rule to scan a hand-picked set of symbols. Fully
# local to signal-generation (see parse_symbol_list) - unlike 'universe' it
# never calls market-data, so it works for any segment, not just NSE. Not
# coupled to any Strategy's instrument_type - same as 'universe' above, a
# symbol_list scan can back a spot, future, or option Strategy alike.
UnderlyingType = Literal["symbol", "universe", "symbol_list"]

IndicatorType = Literal["rsi", "structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"]

# The 5 IndicatorTypes valid in Rule.regime_indicator_ids - "rsi" is a
# crossover-only slot (CrossoverRuleConfig.indicator_id), never a regime
# one. Shared by app/api/routes/rules.py's route-layer validation and
# app/domain/engine.py/backtest.py's resolution of regime_indicator_ids.
REGIME_INDICATOR_TYPES: frozenset[str] = frozenset({"structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"})


class RsiParams(BaseModel):
    """`sma_period` is RSI's own signal line (SMA of RSI) - bundled into
    the indicator's own definition rather than a separate rule parameter,
    matching how TradingView's own RSI script bundles "RSI Length" and
    "MA Length" into one indicator's settings, not two."""

    period: int = Field(gt=1)
    sma_period: int = Field(gt=1)


# The 5 market-regime checks (formerly Strategy.regime_filter_enabled/
# regime_filter_checks, a single shared RegimeParams bundle - see
# app/domain/regime.py) as independent, creatable, reusable Indicator
# types - a Rule references any number of them via its own
# regime_indicator_ids, the same way CrossoverRuleConfig.indicator_id
# references an "rsi" one. Fields mirror the corresponding regime.check_*
# function's own params (minus `candles`/`bias`, which come from the
# evaluating rule at run time, not the indicator's saved definition).
class StructureParams(BaseModel):
    """Confirmed swing structure (see regime.check_structure) -
    swing_lookback is bars required on each side to confirm a pivot."""

    swing_lookback: int = Field(gt=1)


class EfficiencyRatioParams(BaseModel):
    """Kaufman's Efficiency Ratio (see regime.check_efficiency_ratio) -
    trend_threshold is bias-independent: ER only measures how efficiently
    price is moving, not which way."""

    period: int = Field(gt=1)
    trend_threshold: float = Field(gt=0, lt=1)


class AdxParams(BaseModel):
    """Wilder's ADX (see regime.check_adx) - trend_threshold is
    bias-independent: ADX measures trend strength, not direction."""

    period: int = Field(gt=1)
    trend_threshold: float = Field(gt=0)


class DmiDirectionParams(BaseModel):
    """+DI vs -DI direction (see regime.check_dmi_direction)."""

    period: int = Field(gt=1)


class EmaSlopeParams(BaseModel):
    """ATR-normalized EMA slope (see regime.check_ema_slope) -
    atr_period sizes the normalizing ATR independently of ema_period,
    matching how classify_regime reuses its own adx_period for the same
    purpose rather than ema_period."""

    ema_period: int = Field(gt=1)
    slope_lookback: int = Field(gt=0)
    slope_threshold: float = Field(gt=0)
    atr_period: int = Field(gt=1)


# Strategy.stop_loss_method='indicator' params - a SEPARATE registry from
# _INDICATOR_PARAMS_MODELS below (different concern: a Rule's own
# condition/regime-filter indicators vs. what trails a Strategy's
# stop-loss), but the exact same dispatch-by-type-string shape
# deliberately, so a second stop-loss indicator (e.g. SuperTrend) is just
# a new params model + one registry entry here, matching how a 6th regime
# IndicatorType was added below - not a new stop_loss_method value or any
# schema/contract restructuring. See docs/architecture.md "Generic
# indicator-based trailing stop-loss" and position_manager.py's own
# _STOP_LOSS_COMPUTE_FUNCS in execution (a duplicate registry there -
# execution can't import this module, systems/* are self-contained).
class EmaStopParams(BaseModel):
    """stop_loss_indicator_type='ema' - single EMA period, trailing stop
    is the latest EMA value of closes at the position's own
    stop_loss_interval."""

    period: int = Field(gt=1)


_STOP_LOSS_INDICATOR_PARAMS_MODELS: dict[str, type[BaseModel]] = {
    "ema": EmaStopParams,
}


def validate_stop_loss_indicator_params(indicator_type: str, raw: dict) -> BaseModel:
    """Raises pydantic.ValidationError (a 422 at the route layer) if `raw`
    doesn't match `indicator_type`'s expected shape - same explicit
    {type: model} dispatch as validate_indicator_params below, same
    reasoning (avoids a blind union adapter silently resolving an
    ambiguous shape to the wrong type). Unrecognized indicator_type raises
    ValueError, not KeyError - the DB CHECK constraint on
    stop_loss_indicator_type is the first line of defense, but must be
    widened in lockstep with this dict whenever a new type is added (the
    indicators.type CHECK constraint was once left behind when new
    IndicatorTypes were added here - don't repeat that)."""
    model = _STOP_LOSS_INDICATOR_PARAMS_MODELS.get(indicator_type)
    if model is None:
        raise ValueError(f"unknown stop_loss_indicator_type '{indicator_type}'")
    return model.model_validate(raw)


# Indicators are their own entity (signal_generation.indicators) so one
# definition (e.g. "RSI 14", "ADX 14/20") can be reused by any number of
# rules - see docs/architecture.md.
IndicatorParams = Union[RsiParams, StructureParams, EfficiencyRatioParams, AdxParams, DmiDirectionParams, EmaSlopeParams]

_INDICATOR_PARAMS_MODELS: dict[str, type[BaseModel]] = {
    "rsi": RsiParams,
    "structure": StructureParams,
    "efficiency_ratio": EfficiencyRatioParams,
    "adx": AdxParams,
    "dmi_direction": DmiDirectionParams,
    "ema_slope": EmaSlopeParams,
}


def validate_indicator_params(indicator_type: str, raw: dict) -> BaseModel:
    """Raises pydantic.ValidationError (a 422 at the route layer) if `raw`
    doesn't match `indicator_type`'s expected shape. An explicit
    {indicator_type: model} dispatch, not one blind TypeAdapter over the
    whole IndicatorParams union - several of these models are
    structurally similar enough (e.g. AdxParams and EfficiencyRatioParams
    both being {period, trend_threshold}) that a union-wide adapter could
    silently resolve an ambiguous shape to the wrong type; keying off
    `indicator_type` explicitly removes the ambiguity. `indicator_type`
    itself isn't validated here (the DB CHECK constraint + IndicatorType
    already constrain it at the route layer) - an unrecognized one raises
    ValueError rather than KeyError, defensively."""
    model = _INDICATOR_PARAMS_MODELS.get(indicator_type)
    if model is None:
        raise ValueError(f"unknown indicator_type: {indicator_type!r}")
    return model.model_validate(raw)


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
    pattern as Rule.source_type/Strategy.source_type). params, if
    provided, is validated against the indicator's EXISTING type by the
    route handler (it doesn't know the type at this model level)."""

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
    a bearish signal), on the rule's own `interval`. No indicator, no
    higher/lower timeframe split, no rule-intrinsic exit scheme - unlike
    BreakoutRuleConfig (which needs its own bespoke stop-loss/reversal-exit
    handling for the live-enforcement-gap reasons documented in
    app/domain/breakout.py), this behaves like CrossoverRuleConfig for
    everything except how bias is computed: whatever exit config the
    caller supplies (a linked Strategy's own fields, or a backtest
    request's overrides) applies as-is. See app/domain/range_breakout.py,
    which reuses breakout.py's compute_donchian_high/low directly rather
    than duplicating that math. Named 'range_breakout', not 'breakout' -
    that type string already means the multi-timeframe rule above, in the
    DB and in existing rules' stored rule_config."""

    type: Literal["range_breakout"] = "range_breakout"
    breakout_period: int = Field(gt=1)


RuleConfig = Union[CrossoverRuleConfig, BreakoutRuleConfig, RangeBreakoutRuleConfig]
_rule_config_adapter = TypeAdapter(RuleConfig)


def validate_rule_config(raw: dict) -> RuleConfig:
    """Raises pydantic.ValidationError (a 422 at the route layer) if `raw`
    doesn't match any known rule type's shape. Only validates shape - it
    does NOT check that a CrossoverRuleConfig's `indicator_id` actually
    refers to an existing Indicator row (that needs a DB session, so it's
    a route-layer check - see app/api/routes/rules.py)."""
    return _rule_config_adapter.validate_python(raw)


def validate_rule_in_house_fields(
    underlying: Optional[str],
    rule_config: Optional[dict],
    interval: Optional[str],
) -> None:
    """A Rule is always in-house now (external/webhook strategies carry
    their own source_type directly and don't reference a Rule at all - see
    docs/architecture.md) - underlying/rule_config/interval are always
    required: the engine needs a symbol to watch, a rule to evaluate, and
    a timeframe."""
    if underlying is None:
        raise ValueError("underlying is required")
    if rule_config is None:
        raise ValueError("rule_config is required")
    if interval is None:
        raise ValueError("interval is required")
    validate_rule_config(rule_config)


def validate_rule_universe_fields(underlying_type: str, segment: str) -> None:
    """underlying_type='universe' only makes sense for NSE cash-equity
    index membership lists - no MCX/futures universe concept exists.
    Unlike the pre-split validate_underlying_type_fields, this no longer
    checks instrument_type at all - that's a Strategy-level trading
    concept now, decoupled from what the rule scans (a universe scan can
    back a spot, future, or option Strategy alike). 'symbol_list' has no
    such restriction - see parse_symbol_list/validate_rule_symbol_list_fields,
    it works on any segment since it never calls market-data at all."""
    if underlying_type == "universe" and segment != "NSE":
        raise ValueError("underlying_type='universe' requires segment='NSE'")


def parse_symbol_list(underlying: Optional[str]) -> list[str]:
    """"GOLDM, SILVER,CRUDEOIL" -> ["GOLDM", "SILVER", "CRUDEOIL"] - shared
    by the live engine (app/domain/engine.py's _target_symbols) and the
    backtest route (app/api/routes/rules.py's _backtest_symbol_list) so
    both parse underlying_type='symbol_list' identically. Whitespace
    around each entry is stripped and empty entries (from a stray comma)
    are dropped; case is left as-is since callers already uppercase on
    entry (see the frontend's underlying input)."""
    if not underlying:
        return []
    return [s.strip() for s in underlying.split(",") if s.strip()]


def validate_rule_symbol_list_fields(underlying_type: str, underlying: Optional[str]) -> None:
    """underlying_type='symbol_list' needs at least one real symbol once
    parsed - catches "underlying=','" or "underlying=' '" at create/update
    time rather than silently producing a rule that never scans anything
    once live (same reasoning as validate_rule_universe_fields catching a
    segment mismatch up front instead of failing later, in the engine)."""
    if underlying_type == "symbol_list" and not parse_symbol_list(underlying):
        raise ValueError("underlying_type='symbol_list' requires at least one comma-separated symbol in underlying")


def validate_breakout_interval_consistency(interval: Optional[str], rule_config: Optional[dict]) -> None:
    """A BreakoutRuleConfig's own top-level `interval` must equal its
    rule_config's ltf_interval - `interval` is what the live engine and
    backtest treat as this rule's actual scanning cadence (candle
    fetch/dedupe granularity), and for a breakout rule that's always the
    lower timeframe, never the higher one. Pre-split this was a
    Strategy-vs-rule_config cross-table check (see
    app/api/routes/strategies.py's old _breakout_stop_loss_fields); now
    it's entirely within Rule. A non-breakout rule_config (or no
    rule_config at all) has no such constraint."""
    if rule_config is None:
        return
    rule = validate_rule_config(rule_config)
    if isinstance(rule, BreakoutRuleConfig) and interval != rule.ltf_interval:
        raise ValueError("interval must equal rule_config.ltf_interval for a breakout rule")


class RuleCreate(BaseModel):
    name: str = Field(min_length=1)
    description: Optional[str] = None
    segment: Segment = "NSE"
    underlying: Optional[str] = Field(default=None, min_length=1)
    underlying_type: UnderlyingType = "symbol"
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None
    # Which regime-type Indicators (see IndicatorType's 5 "structure"/
    # "efficiency_ratio"/"adx"/"dmi_direction"/"ema_slope" entries) must
    # ALL confirm this rule's own bias before it fires - a cross-cutting
    # modifier that applies uniformly regardless of rule_config's own
    # type (crossover/breakout/range_breakout), so it lives here at the
    # top level rather than duplicated inside each RuleConfig variant.
    # Empty (default) means no regime gate at all. IDs are only checked
    # for shape here - that they actually exist and are regime-typed (not
    # "rsi") needs a DB session, see app/api/routes/rules.py.
    regime_indicator_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_in_house_consistency(self) -> "RuleCreate":
        validate_rule_in_house_fields(self.underlying, self.rule_config, self.interval)
        return self

    @model_validator(mode="after")
    def _check_underlying_type_consistency(self) -> "RuleCreate":
        validate_rule_universe_fields(self.underlying_type, self.segment)
        validate_rule_symbol_list_fields(self.underlying_type, self.underlying)
        return self

    @model_validator(mode="after")
    def _check_breakout_interval_consistency(self) -> "RuleCreate":
        validate_breakout_interval_consistency(self.interval, self.rule_config)
        return self


class RuleUpdate(BaseModel):
    """PATCH /rules/{id} - all fields optional, only what's provided
    changes."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    segment: Optional[Segment] = None
    underlying: Optional[str] = Field(default=None, min_length=1)
    underlying_type: Optional[UnderlyingType] = None
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None
    regime_indicator_ids: Optional[list[str]] = None


class RuleOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    segment: Segment
    underlying: Optional[str] = None
    underlying_type: UnderlyingType = "symbol"
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None
    regime_indicator_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class RuleSummary(BaseModel):
    """Lightweight embed on StrategyOut (app/domain/models.py) - avoids an
    N+1 fetch per row in the strategy list/table for the common "which
    rule backs this strategy" display."""

    id: str
    name: str
    segment: Segment


class RuleBacktestRequest(BaseModel):
    """POST /rules/{id}/backtest body (from/to stay query params, matching
    the route's pre-split convention - see app/api/routes/rules.py). A
    Rule alone carries no exit config (stop-loss/target/square-off), no
    instrument_type, and no horizon (all trading concepts, Strategy-owned)
    - all supplied here as optional per-run overrides instead of being
    stored. Omitting the exit-config fields reproduces ExitConfig()'s own
    all-`None` defaults exactly: opposite-signal/end-of-data exits only,
    no stop-loss/target - see app/domain/backtest.py. Rule.
    regime_indicator_ids (if any) always applies - there's no override to
    turn it off here, unlike the exit-config fields; it's a property of
    the rule itself, not a per-run choice."""

    instrument_type: Literal["spot", "future", "option"] = "spot"
    # instrument_type='option' only - WEEK vs MONTH expiry choice, see
    # app/api/routes/rules.py's option backtest path.
    horizon: Literal["intraday", "swing", "positional"] = "intraday"
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    # stop_loss_method='indicator' only - see Strategy's own
    # stop_loss_indicator_type/stop_loss_indicator_params (app/domain/models.py)
    # and validate_stop_loss_indicator_params above. Not cross-validated
    # here (a backtest request's exit-config fields are all optional
    # per-run overrides, same as the other stop_loss_* fields on this
    # model) - an invalid/missing shape surfaces as a 502 from the actual
    # compute dispatch instead of a 422 here.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None
    # instrument_type='option' only.
    option_position_style: Literal["spread", "naked"] = "spread"
    option_strike_moneyness: Literal["ITM2", "ITM1", "ATM", "OTM1", "OTM2"] = "ATM"


class RuleBacktestGridRequest(BaseModel):
    """POST /rules/{id}/backtest/grid body - which indicator params to
    sweep and what candidate values to try for each, e.g. {"period": [7,
    14, 21], "sma_period": [5, 9, 14]}. Any indicator param NOT named here
    stays fixed at the rule's currently-referenced Indicator's own value -
    see app/domain/backtest.py's expand_grid/grid_search. Does not mutate
    the Indicator row; PATCH /indicators/{id} once you've picked a winner
    from the report. Crossover-rule rules only (matches the pre-split
    route's own scope) - no instrument_type/option overrides here, since
    there's no option-backtest variant of grid search. Same exit-config
    field set as RuleBacktestRequest (all 3 stop_loss_method values,
    including 'indicator') - _exit_config_for/_sl_candles_for in
    app/api/routes/rules.py accept either request type interchangeably."""

    param_grid: dict[str, list[int]] = Field(min_length=1)
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    # stop_loss_method='indicator' only - same "not cross-validated here"
    # reasoning as RuleBacktestRequest's own copy of these two fields.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None

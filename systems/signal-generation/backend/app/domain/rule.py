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
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

# 'in_house' is the one reserved value every other backend check compares
# against - anything else names an external webhook provider (e.g.
# "chartink", "tradingview", or any new one) and is otherwise opaque to
# this system. Free-form rather than a fixed enum so a new provider
# doesn't need a code change here. Mirrors Strategy's own SourceType
# exactly - the two must agree at link time, see
# app/domain/models.py's validate_rule_link_consistency.
SourceType = Annotated[str, Field(min_length=1)]
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
# validate_rule_universe_fields. Not coupled to any Strategy's
# instrument_type - a universe scan can back a spot, future, or option
# Strategy alike.
UnderlyingType = Literal["symbol", "universe"]

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
# "RSI 14") can be reused by any number of rules - see
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
    source_type: str,
    underlying: Optional[str],
    rule_config: Optional[dict],
    interval: Optional[str],
) -> None:
    """source_type='in_house' requires underlying/rule_config/interval all
    set - the engine needs a symbol to watch, a rule to evaluate, and a
    timeframe. External (webhook) rules get symbol/timing per-signal from
    the provider payload instead, so underlying/rule_config don't apply
    there - they're purely a saved name/description reference, never
    evaluated by our own engine."""
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


def validate_rule_universe_fields(underlying_type: str, segment: str) -> None:
    """underlying_type='universe' only makes sense for NSE cash-equity
    index membership lists - no MCX/futures universe concept exists.
    Unlike the pre-split validate_underlying_type_fields, this no longer
    checks instrument_type at all - that's a Strategy-level trading
    concept now, decoupled from what the rule scans (a universe scan can
    back a spot, future, or option Strategy alike)."""
    if underlying_type == "universe" and segment != "NSE":
        raise ValueError("underlying_type='universe' requires segment='NSE'")


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
    source_type: SourceType
    # source_type != 'in_house' only - the scan's own name on the
    # provider's side, if `name` above renames it locally.
    provider_rule_name: Optional[str] = Field(default=None, min_length=1)
    segment: Segment = "NSE"
    # in_house only - see validate_rule_in_house_fields.
    underlying: Optional[str] = Field(default=None, min_length=1)
    underlying_type: UnderlyingType = "symbol"
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None

    @model_validator(mode="after")
    def _check_in_house_consistency(self) -> "RuleCreate":
        validate_rule_in_house_fields(self.source_type, self.underlying, self.rule_config, self.interval)
        return self

    @model_validator(mode="after")
    def _check_underlying_type_consistency(self) -> "RuleCreate":
        validate_rule_universe_fields(self.underlying_type, self.segment)
        return self

    @model_validator(mode="after")
    def _check_breakout_interval_consistency(self) -> "RuleCreate":
        validate_breakout_interval_consistency(self.interval, self.rule_config)
        return self

    @model_validator(mode="after")
    def _check_provider_rule_name_scope(self) -> "RuleCreate":
        if self.source_type == "in_house" and self.provider_rule_name is not None:
            raise ValueError("provider_rule_name only applies to source_type != 'in_house'")
        return self


class RuleUpdate(BaseModel):
    """PATCH /rules/{id} - all fields optional, only what's provided
    changes. source_type is deliberately not editable (same reasoning as
    Strategy.source_type: it's a foundational identity fact checked
    against any Strategy currently linked to this Rule, see
    validate_rule_link_consistency) - delete+recreate if it's genuinely
    wrong."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    provider_rule_name: Optional[str] = Field(default=None, min_length=1)
    segment: Optional[Segment] = None
    underlying: Optional[str] = Field(default=None, min_length=1)
    underlying_type: Optional[UnderlyingType] = None
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None


class RuleOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    source_type: SourceType
    provider_rule_name: Optional[str] = None
    segment: Segment
    underlying: Optional[str] = None
    underlying_type: UnderlyingType = "symbol"
    interval: Optional[Interval] = None
    rule_config: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class RuleSummary(BaseModel):
    """Lightweight embed on StrategyOut (app/domain/models.py) - avoids an
    N+1 fetch per row in the strategy list/table for the common "which
    rule backs this strategy" display."""

    id: str
    name: str
    source_type: SourceType
    segment: Segment


class RuleBacktestRequest(BaseModel):
    """POST /rules/{id}/backtest body (from/to stay query params, matching
    the route's pre-split convention - see app/api/routes/rules.py). A
    Rule alone carries no exit config (stop-loss/target/square-off), no
    instrument_type, and no horizon (all trading concepts, Strategy-owned)
    - all supplied here as optional per-run overrides instead of being
    stored. Omitting the exit-config fields reproduces ExitConfig()'s own
    all-`None` defaults exactly: opposite-signal/end-of-data exits only,
    no stop-loss/target - see app/domain/backtest.py. The regime filter
    (Strategy-only, gates a signal on top of the rule's own raw output)
    has no override here at all - a Rule-scoped backtest always runs with
    it off; it's evaluated per-Strategy, not per-Rule."""

    instrument_type: Literal["spot", "future", "option"] = "spot"
    # instrument_type='option' only - WEEK vs MONTH expiry choice, see
    # app/api/routes/rules.py's option backtest path.
    horizon: Literal["intraday", "swing", "positional"] = "intraday"
    stop_loss_method: Optional[Literal["previous_candle", "percent"]] = None
    stop_loss_interval: Optional[Literal["1min", "5min", "15min", "25min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
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
    there's no option-backtest variant of grid search."""

    param_grid: dict[str, list[int]] = Field(min_length=1)
    stop_loss_method: Optional[Literal["previous_candle", "percent"]] = None
    stop_loss_interval: Optional[Literal["1min", "5min", "15min", "25min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None

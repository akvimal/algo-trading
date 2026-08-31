"""A Strategy here is the unit of configuration for a signal source
(external webhook provider, or an in-house engine) - not to be confused
with signal-processing's option-strategy selection (spread / straddle /
etc, a completely different concern living in
signal-processing/app/domain/processing/resolution/option_strategy.py). *What decides a
signal fires* (underlying, rule config, indicator, interval) lives on the
separate Rule entity instead (app/domain/rule.py) - a Strategy just picks
one via rule_id. See docs/architecture.md's "Rules module" section for
the split.

No position-size/capital field here - that's still owned by execution
(capital_per_trade in its settings). Stop-loss/target ARE here, though,
as a deliberate exception: unlike a flat capital figure, stop distance
genuinely varies by strategy/scan/timeframe, so the *method* lives with
"what produces a signal" while execution still owns the actual sizing
arithmetic (capital cap, risk %) and the live exit-monitoring loop. See
docs/architecture.md."""

from datetime import datetime, time
from typing import Literal, Optional

from typing import Annotated

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from app.domain.generation.rule import RuleSummary, Segment, validate_stop_loss_indicator_params

# 'in_house' is the one reserved value every other backend check compares
# against (app/domain/engine.py, app/api/routes/strategies.py) - anything
# else names an external webhook provider (e.g. "chartink", "tradingview",
# or any new one) and is otherwise opaque to this system. Free-form rather
# than a fixed enum so a new provider doesn't need a code change here -
# see app/App.tsx's "External source name" field on the frontend. An
# external Strategy carries no Rule at all (Rule is in-house only, see
# app/domain/rule.py) - the provider decides when a signal fires, not this
# system.
SourceType = Annotated[str, Field(min_length=1)]
Horizon = Literal["intraday", "positional"]  # "swing" merged into these two 2026-08-17 - never had distinct behavior anywhere (see docs/architecture.md)
InstrumentType = Literal["spot", "future", "option"]
# instrument_type='option' only - which fixed template signal-processing's
# choose_option_strategy builds: 'spread' (bull_call_spread/bear_put_spread, Phase
# 4b) or 'naked' (naked_call/naked_put - single BUY leg, no short leg, no
# margin/undefined-risk handling anywhere in this platform so "naked SELL"
# is never a valid template). Harmlessly ignored for spot/future strategies.
OptionPositionStyle = Literal["spread", "naked"]
# instrument_type='option' only - which strike the primary (long) leg
# uses, relative to spot - see signal-processing's option_templates.py
# _MONEYNESS_OFFSETS. 'ATM' default reproduces pre-this-field behavior
# exactly. A spread's short leg still sits SPREAD_WIDTH_STRIKES further
# out from wherever this lands, not from ATM itself - not independently
# configurable. Harmlessly ignored for spot/future strategies.
OptionStrikeMoneyness = Literal["ITM2", "ITM1", "ATM", "OTM1", "OTM2"]
# instrument_type='option' only - whether execution monitors one SL/target
# threshold on the combined (net debit) premium ('combined', the original
# Phase 4d design) or each leg's own threshold computed from its own entry
# premium ('individual'). Either scope still closes the WHOLE group
# together when tripped - this only changes the trigger condition, never
# leaves one leg open while the other closes. Mathematically identical to
# 'combined' for a naked (1-leg) position. Harmlessly ignored for
# spot/future strategies.
OptionSlScope = Literal["combined", "individual"]
# instrument_type in ('future', 'option') only - restricts signals to a
# specific day in the contract's lifecycle. 'any' (default): no
# restriction. 'expiry': only the contract's own expiry day - works for
# both future and option (Dhan's synced data / market-data's live expiry
# list both give this directly). 'start': only the day the current
# expiry/contract became the relevant one - OPTION ONLY, computed from
# the live expiry list (day after the previous expiry); not reliably
# computable for futures (see validate_contract_day_filter_fields) so
# 'start'+'future' is rejected, not silently unenforceable. Never
# enforced for segment='CRYPTO' (daily option expiry makes the
# distinction meaningless there). Harmlessly ignored for 'spot'.
ContractDayFilter = Literal["any", "start", "expiry"]
Status = Literal["draft", "backtesting", "live", "paused"]
# 'indicator': trailing stop is the latest value of a generic, pluggable
# indicator computation (see app/domain/rule.py's
# validate_stop_loss_indicator_params/_STOP_LOSS_INDICATOR_PARAMS_MODELS
# - 'ema'/'supertrend' today, more addable there without touching this
# Literal again). Uses stop_loss_interval (candle timeframe, reused) plus
# the two new stop_loss_indicator_* fields below - never stop_loss_percent.
# 'breakeven': a one-shot variant of 'percent' (added 2026-08-29) - opens
# with the identical initial stop (entry +/- stop_loss_percent%), but once
# price first moves stop_loss_percent% favorably from entry, the stop
# snaps to entry_price itself and freezes there for good (no further
# trailing) - execution.positions.breakeven_triggered records whether
# that snap has already happened. Reuses stop_loss_percent for both the
# initial distance and the trigger threshold rather than adding a second
# field, same as 'percent' otherwise never sets interval/indicator_*.
StopLossMethod = Literal["previous_candle", "percent", "indicator", "breakeven"]
# 1/5/15/25/60 are Dhan's native charts/intraday intervals; 3/30 are
# locally aggregated from 1min bars (any "Nmin" shape works - see
# market-data's resolve_interval_minutes/aggregate_candles) same as
# Rule's own `interval` field already relies on for 3min/30min LTF
# breakout legs. `daily` is deliberately excluded - the intraday
# candle-history endpoints these providers use don't serve it at all
# (resolve_interval_minutes raises for it), so a stop-loss interval of
# 'daily' could never actually fetch a candle.
StopLossInterval = Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]
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

def validate_strategy_rule_requirement(source_type: str, rule_id: Optional[str]) -> None:
    """Rule is in-house-only now (external/webhook strategies carry no
    condition of their own - the provider decides when a signal fires, not
    this system - see app/domain/rule.py). rule_id is therefore required
    exactly when source_type=='in_house', and must be absent otherwise."""
    if source_type == "in_house":
        if rule_id is None:
            raise ValueError("source_type='in_house' requires rule_id")
    elif rule_id is not None:
        raise ValueError("rule_id only applies to source_type='in_house'")


def validate_contract_day_filter_fields(contract_day_filter: str, instrument_type: str) -> None:
    """'start' is only reliably computable for options (market-data's
    live expiry list gives an exact previous-expiry to compute day-after
    from) - futures have no equivalent data (Dhan's instrument master
    never lists an already-expired contract), so this combination is
    rejected outright rather than silently never firing."""
    if contract_day_filter == "start" and instrument_type != "option":
        raise ValueError("contract_day_filter='start' requires instrument_type='option' - not reliably computable for futures")


def validate_segment_instrument_type(segment: str, instrument_type: str) -> None:
    """CRYPTO (Delta Exchange India) and MCX (commodities) have no cash/
    spot market on this platform's providers - Delta only quotes
    perpetual futures, and Dhan's MCX coverage is F&O-only. instrument_
    type='spot' on either segment used to silently pass validation and
    only surface as a permanent execution-side rejection (position_
    manager.open_position sizes 'spot' at lot_size=1, i.e. one full raw-
    price underlying unit - unaffordable for CRYPTO's fractional-lot
    perpetuals, reproduced live 2026-08-21 where a CRYPTO strategy sized
    against $69k+ BTC 'spot' against a few-hundred-dollar account).
    Rejected at strategy save time instead so this can't happen again."""
    if segment in ("CRYPTO", "MCX") and instrument_type == "spot":
        raise ValueError(f"segment='{segment}' has no spot market - use instrument_type='future' or 'option'")


class ActiveWindow(BaseModel):
    """One [start, end) slice of a Strategy's optional signal-acceptance
    window - see Strategy.active_windows below. No overnight wraparound
    support, same limitation the old single from/to pair had - end must
    be strictly after start."""

    start: time
    end: time

    @model_validator(mode="after")
    def _check_range(self) -> "ActiveWindow":
        if self.end <= self.start:
            raise ValueError(f"active window end ({self.end}) must be after start ({self.start})")
        return self


def validate_active_windows(windows: list[dict]) -> list[ActiveWindow]:
    """Re-validates a Strategy row's raw JSONB active_windows (list of
    {"start": "HH:MM:SS", "end": "HH:MM:SS"} dicts) against ActiveWindow's
    own per-window rule - used by the PATCH route handler to re-check the
    merged post-update row, same pattern validate_stop_loss_fields uses
    for its own field group. Multiple windows may overlap; not treated as
    an error (harmless redundancy) - a signal is accepted if it falls in
    ANY of them, see signal-processing's is_within_active_window. Raises
    pydantic.ValidationError (a 422 at the route layer) for a malformed
    or backwards window."""
    return [ActiveWindow(**w) for w in windows]


# Mon-Sun abbreviations, ISO order (Monday first) - matches Python's own
# date.weekday()/datetime.weekday() convention (0=Monday...6=Sunday), so
# every consumer (engine.py, signal-processing's pipeline.py) can index
# straight from date.weekday() without a separate lookup table.
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKDAY_NAMES: tuple[Weekday, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

_active_weekdays_adapter = TypeAdapter(list[Weekday])


def validate_active_weekdays(weekdays: list) -> list[Weekday]:
    """Re-validates a Strategy row's raw JSONB active_weekdays against the
    Weekday literal - used by the PATCH route handler to re-check the
    merged post-update row, same pattern validate_active_windows uses for
    its own field. Raises pydantic.ValidationError (a 422 at the route
    layer) for an unrecognized weekday abbreviation. Duplicates aren't an
    error (harmless redundancy), same as active_windows' own overlap
    tolerance."""
    return _active_weekdays_adapter.validate_python(weekdays)


def validate_stop_loss_fields(
    method: Optional[str],
    interval: Optional[str],
    percent: Optional[float],
    trailing_enabled: bool,
    indicator_type: Optional[str] = None,
    indicator_params: Optional[dict] = None,
) -> None:
    """Shared consistency rule for the stop-loss field group, used by both
    StrategyCreate (all fields always present) and the PATCH route handler
    (validated against the merged post-update row, since PATCH applies
    fields one at a time - see app/api/routes/strategies.py)."""
    if method is None:
        if interval is not None or percent is not None or trailing_enabled or indicator_type is not None or indicator_params is not None:
            raise ValueError(
                "stop_loss_interval/stop_loss_percent/trailing_stop_enabled/stop_loss_indicator_type/"
                "stop_loss_indicator_params require a stop_loss_method"
            )
    elif method == "previous_candle":
        if interval is None:
            raise ValueError("stop_loss_method='previous_candle' requires stop_loss_interval")
        if percent is not None:
            raise ValueError("stop_loss_method='previous_candle' must not set stop_loss_percent")
        if indicator_type is not None or indicator_params is not None:
            raise ValueError("stop_loss_method='previous_candle' must not set stop_loss_indicator_type/stop_loss_indicator_params")
    elif method in ("percent", "breakeven"):
        if percent is None:
            raise ValueError(f"stop_loss_method='{method}' requires stop_loss_percent")
        if interval is not None:
            raise ValueError(f"stop_loss_method='{method}' must not set stop_loss_interval")
        if indicator_type is not None or indicator_params is not None:
            raise ValueError(f"stop_loss_method='{method}' must not set stop_loss_indicator_type/stop_loss_indicator_params")
        # Unlike 'percent' (a flat stop is a valid, if inert-trailing,
        # choice), 'breakeven' does nothing at all without trailing - its
        # one-shot snap-to-entry only happens inside _evaluate_exits'
        # trailing_stop_enabled-gated block (execution's
        # position_manager.py). A breakeven stop with trailing off would
        # silently behave as an ordinary flat percent stop forever.
        if method == "breakeven" and not trailing_enabled:
            raise ValueError("stop_loss_method='breakeven' requires trailing_stop_enabled=true")
    elif method == "indicator":
        if interval is None:
            raise ValueError("stop_loss_method='indicator' requires stop_loss_interval")
        if percent is not None:
            raise ValueError("stop_loss_method='indicator' must not set stop_loss_percent")
        if indicator_type is None or indicator_params is None:
            raise ValueError("stop_loss_method='indicator' requires stop_loss_indicator_type and stop_loss_indicator_params")
        try:
            validate_stop_loss_indicator_params(indicator_type, indicator_params)
        except ValueError as exc:
            raise ValueError(f"invalid stop_loss_indicator_params for '{indicator_type}': {exc}") from exc


class StrategyCreate(BaseModel):
    name: str = Field(min_length=1)
    source_type: SourceType
    # Provider's own name for the thing that fires this strategy's signals
    # (e.g. the Chartink scan's title) - purely descriptive, never matched
    # against by intake/resolution (unlike source_type itself). Optional,
    # external strategies only - in_house has a real Rule name instead.
    source_rule_name: Optional[str] = None
    exchange: Literal["NSE"] = "NSE"
    horizon: Horizon
    instrument_type: InstrumentType
    # Which saved Rule (app/domain/rule.py) decides when this strategy's
    # signals fire - in_house only (Rule is purely an in-house condition
    # definition now). Required when source_type=='in_house', forbidden
    # otherwise - see validate_strategy_rule_requirement.
    rule_id: Optional[str] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    # stop_loss_method='indicator' only - see StopLossMethod's own comment
    # and app/domain/rule.py's validate_stop_loss_indicator_params.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    # instrument_type='option' only - see OptionPositionStyle above.
    option_position_style: OptionPositionStyle = "spread"
    option_strike_moneyness: OptionStrikeMoneyness = "ATM"
    option_sl_scope: OptionSlScope = "combined"
    # Optional, every instrument_type (renamed from option_fixed_lots,
    # which used to be options-only - see docs/architecture.md's
    # "fixed_lots" section for the widening). When set, execution trades
    # exactly this many LOTS instead of auto-sizing off capital/risk% -
    # takes precedence over stop-loss-based sizing entirely, even when a
    # stop-loss is also configured. Number of lots, not raw underlying
    # units - a no-op distinction for spot (lot_size is always 1 there,
    # so this is really "quantity" for spot) but real for futures/options.
    fixed_lots: Optional[int] = Field(default=None, gt=0)
    # horizon='positional'+instrument_type='spot'+segment='NSE' only
    # (harmlessly ignored otherwise). Opts this strategy's orders into
    # execution.accounts' platform-wide NSE leverage (Dhan MTF) + interest
    # when the admin has configured it there - see docs/architecture.md.
    use_margin: bool = False
    contract_day_filter: ContractDayFilter = "any"
    segment: Segment = "NSE"
    # Every source_type carries these, same as stop_loss_* above -
    # see the DuplicateSignalPolicy/CounterSignalPolicy alias comments above.
    duplicate_signal_policy: DuplicateSignalPolicy = "skip"
    counter_signal_policy: CounterSignalPolicy = "close_and_flip"
    # Optional per-strategy signal-acceptance window(s) (e.g. 09:15-11:00,
    # or several - "09:15-10:30" AND "13:00-14:30"), every source_type -
    # see infra/postgres/init/03-signal-generation.sql and ActiveWindow
    # above. Empty list (the default) means unrestricted - a signal is
    # accepted any time. A signal is accepted if it falls within ANY one
    # of them (see signal-processing's is_within_active_window) - the
    # window only gates whether an entry SIGNAL is accepted; an already-open
    # position can still close outside every window via stop-loss/target/
    # square-off/counter-signal, unaffected by this field entirely.
    active_windows: list[ActiveWindow] = Field(default_factory=list)
    # Optional day-of-week filter (e.g. ["Mon","Tue","Wed","Thu","Fri"] for
    # weekdays-only), every source_type, independent of active_windows -
    # both gate signal ACCEPTANCE only, same "doesn't affect closing an
    # already-open position" rule active_windows itself has (stop-loss/
    # target/square-off/counter-signal are all unaffected). Empty list
    # (the default) means unrestricted - every day is accepted. A signal
    # is accepted if today's weekday is in this list at all, no ANY-of-
    # multiple-ranges concept needed since a weekday is already atomic
    # (unlike active_windows' time-of-day ranges).
    active_weekdays: list[Weekday] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_stop_loss_consistency(self) -> "StrategyCreate":
        validate_stop_loss_fields(
            self.stop_loss_method,
            self.stop_loss_interval,
            self.stop_loss_percent,
            self.trailing_stop_enabled,
            self.stop_loss_indicator_type,
            self.stop_loss_indicator_params,
        )
        return self

    @model_validator(mode="after")
    def _check_rule_requirement(self) -> "StrategyCreate":
        validate_strategy_rule_requirement(self.source_type, self.rule_id)
        return self

    @model_validator(mode="after")
    def _check_contract_day_filter_consistency(self) -> "StrategyCreate":
        validate_contract_day_filter_fields(self.contract_day_filter, self.instrument_type)
        return self

    @model_validator(mode="after")
    def _check_segment_instrument_type(self) -> "StrategyCreate":
        validate_segment_instrument_type(self.segment, self.instrument_type)
        return self


class StrategyUpdate(BaseModel):
    """PATCH /strategies/{id} - all fields optional, only what's provided
    changes. source_type and exchange are deliberately not editable:
    source_type determines the webhook shape a provider is already
    configured against, and exchange only has one valid value today - both
    are set at create time only. rule_id IS patchable for an in-house
    strategy - re-pointing it at a different saved Rule doesn't need a
    delete+recreate (validate_strategy_rule_requirement is re-checked
    against the merged post-update row at the route layer, same as at
    create time - a strategy can never end up in-house with no rule_id, or
    external with one).

    The stop-loss field group (stop_loss_method/_interval/_percent,
    trailing_stop_enabled) is NOT cross-field-validated at this model
    level, since a PATCH may legitimately touch only one of them (e.g.
    just flipping trailing_stop_enabled). If stop_loss_method IS provided,
    the route handler treats stop_loss_interval/stop_loss_percent as the
    complete replacement pair for it (explicitly clearing whichever one
    the new method doesn't use), so switching methods in one PATCH call
    never leaves a stale value from the old method behind. There's no way
    to PATCH stop_loss_method back to NULL (disable SL) - same limitation
    the pre-existing `rule_id` field already has for switching a strategy
    from in-house to external; delete+recreate the strategy if that's
    needed."""

    name: Optional[str] = Field(default=None, min_length=1)
    status: Optional[Status] = None
    # Unlike source_type itself, this IS patchable any time (external
    # strategies only) - see StrategyCreate's own comment.
    source_rule_name: Optional[str] = None
    horizon: Optional[Horizon] = None
    instrument_type: Optional[InstrumentType] = None
    rule_id: Optional[str] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: Optional[bool] = None
    option_position_style: Optional[OptionPositionStyle] = None
    option_strike_moneyness: Optional[OptionStrikeMoneyness] = None
    option_sl_scope: Optional[OptionSlScope] = None
    fixed_lots: Optional[int] = Field(default=None, gt=0)
    use_margin: Optional[bool] = None
    contract_day_filter: Optional[ContractDayFilter] = None
    segment: Optional[Segment] = None
    duplicate_signal_policy: Optional[DuplicateSignalPolicy] = None
    counter_signal_policy: Optional[CounterSignalPolicy] = None
    # Optional[...] = None here means "omitted" (leave unchanged), same as
    # every other field on this model - but active_windows=[] is ALSO a
    # meaningful, distinct value (clear back to unrestricted), which plain
    # Optional can't express. The route handler checks model_fields_set
    # (same pattern fixed_lots already established) to tell
    # "omitted" from "explicitly set to []" apart.
    active_windows: Optional[list[ActiveWindow]] = None
    # Same omitted-vs-explicit-empty distinction as active_windows above -
    # the route handler checks model_fields_set for this field too.
    active_weekdays: Optional[list[Weekday]] = None


class StrategyOut(BaseModel):
    id: str
    name: str
    source_type: SourceType
    source_rule_name: Optional[str] = None
    exchange: str
    horizon: Horizon
    instrument_type: InstrumentType
    # None for external (webhook) strategies - Rule is in-house only now.
    rule_id: Optional[str] = None
    # Lightweight embed (app/domain/rule.py's RuleSummary) so the
    # strategy list/table can show which rule backs each row without an
    # N+1 fetch - populated by _to_out from a joined Rule row.
    rule: Optional[RuleSummary] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = None
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    option_position_style: OptionPositionStyle = "spread"
    option_strike_moneyness: OptionStrikeMoneyness = "ATM"
    option_sl_scope: OptionSlScope = "combined"
    fixed_lots: Optional[int] = None
    use_margin: bool = False
    contract_day_filter: ContractDayFilter = "any"
    segment: Segment
    duplicate_signal_policy: DuplicateSignalPolicy = "skip"
    counter_signal_policy: CounterSignalPolicy = "close_and_flip"
    active_windows: list[ActiveWindow] = Field(default_factory=list)
    active_weekdays: list[Weekday] = Field(default_factory=list)
    status: Status
    # MAX(engine_runs.last_checked_at) across every symbol this strategy
    # scans (a universe-scoped one has one EngineRun row per constituent) -
    # None if the engine has never ticked it yet, e.g. just created, or an
    # external strategy (engine_runs is in-house-engine bookkeeping only).
    # Populated by the route layer (app/api/routes/strategies.py), not a
    # real column on this row - EngineRun is keyed by (strategy_id,
    # symbol), not something _to_out can read off `row` directly.
    last_scan_at: Optional[datetime] = None
    # MAX(signal_processing.signals.received_at) for this strategy - the
    # external-strategy counterpart to last_scan_at above: an external
    # (webhook) strategy has no EngineRun at all (nothing here ever
    # "scans"), so last_scan_at is always None for it - this is what the
    # frontend's "Last scan" column shows instead for source_type !=
    # 'in_house'. None if no signal has ever arrived for it yet. Populated
    # by the route layer the same way as last_scan_at, not a real column.
    last_signal_at: Optional[datetime] = None
    # Whoever was logged in (systems/accounts) when this Strategy was
    # created - None for one created with no bearer token at all (e.g.
    # `make test-signal`'s throwaway strategy, or any pre-existing
    # Strategy from before this field existed). Captured once at creation
    # time, never changed afterward - see create_strategy's own comment on
    # why (get_optional_user_id, not require_user_id: signal-engine's
    # backend has no auth of its own to enforce, this is purely
    # attribution). Threaded through to execution as ResolvedOrder's own
    # owner_user_id (see docs/contracts/resolved-order.schema.json) so a
    # Strategy-driven position can size against and be attributed to ITS
    # OWN creator's account instead of always the platform-wide one - see
    # docs/architecture.md.
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

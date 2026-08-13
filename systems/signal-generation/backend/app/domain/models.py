"""A Strategy here is the unit of configuration for a signal source
(external webhook provider, or an in-house engine) - not to be confused
with signal-processing's option-strategy selection (spread / straddle /
etc, a completely different concern living in
signal-processing/app/domain/resolution/strategy.py). *What decides a
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

from pydantic import BaseModel, Field, model_validator

from app.domain.rule import RuleSummary, Segment

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
Horizon = Literal["intraday", "swing", "positional"]
InstrumentType = Literal["spot", "future", "option"]
# instrument_type='option' only - which fixed template signal-processing's
# choose_strategy builds: 'spread' (bull_call_spread/bear_put_spread, Phase
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
StopLossMethod = Literal["previous_candle", "percent"]
# Matches Dhan's actual supported intraday-candle intervals for the
# charts/intraday API (1/5/15/25/60 - no 30, no daily): a deliberate
# leak of the one provider's capabilities, consistent with this codebase
# already hardcoding to Dhan/NSE elsewhere (see market-data's DhanProvider).
StopLossInterval = Literal["1min", "5min", "15min", "25min", "60min"]
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


def validate_active_window_fields(active_from_time: Optional[time], active_to_time: Optional[time]) -> None:
    """Shared consistency rule for the optional signal-acceptance window,
    used by both StrategyCreate (all fields always present) and the PATCH
    route handler (validated against the merged post-update row, same
    pattern as validate_stop_loss_fields). Both-or-neither; no overnight
    wraparound support - active_to_time must be strictly after
    active_from_time."""
    if (active_from_time is None) != (active_to_time is None):
        raise ValueError("active_from_time and active_to_time must both be set, or both left unset")
    if active_from_time is not None and active_to_time is not None and active_to_time <= active_from_time:
        raise ValueError("active_to_time must be after active_from_time")


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
    # Which saved Rule (app/domain/rule.py) decides when this strategy's
    # signals fire - in_house only (Rule is purely an in-house condition
    # definition now). Required when source_type=='in_house', forbidden
    # otherwise - see validate_strategy_rule_requirement.
    rule_id: Optional[str] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: bool = False
    # instrument_type='option' only - see OptionPositionStyle above.
    option_position_style: OptionPositionStyle = "spread"
    option_strike_moneyness: OptionStrikeMoneyness = "ATM"
    option_sl_scope: OptionSlScope = "combined"
    # instrument_type='option' only, harmlessly ignored otherwise (same
    # convention as the other option_* fields above). When set, execution
    # trades exactly this many lots instead of auto-sizing off capital/risk%
    # - takes precedence over stop-loss-based sizing entirely, even when a
    # stop-loss is also configured. See docs/architecture.md § "Why position
    # sizing lives in execution, not signal-generation" for why this is a
    # deliberate, narrow exception.
    option_fixed_lots: Optional[int] = Field(default=None, gt=0)
    contract_day_filter: ContractDayFilter = "any"
    segment: Segment = "NSE"
    # Only meaningful for horizon='intraday' - square-off doesn't apply to
    # swing/positional strategies (positions aren't closed same-day), so
    # this stays null for them. Auto-defaulted from (horizon, segment)
    # when omitted on an intraday strategy - see default_square_off_time.
    square_off_time: Optional[time] = None
    # Every source_type carries these, same as stop_loss_*/square_off_time -
    # see the DuplicateSignalPolicy/CounterSignalPolicy alias comments above.
    duplicate_signal_policy: DuplicateSignalPolicy = "skip"
    counter_signal_policy: CounterSignalPolicy = "close_and_flip"
    # Optional per-strategy signal-acceptance window (e.g. 09:15-11:00),
    # every source_type - see infra/postgres/init/03-signal-generation.sql
    # and validate_active_window_fields.
    active_from_time: Optional[time] = None
    active_to_time: Optional[time] = None

    @model_validator(mode="after")
    def _check_stop_loss_consistency(self) -> "StrategyCreate":
        validate_stop_loss_fields(
            self.stop_loss_method, self.stop_loss_interval, self.stop_loss_percent, self.trailing_stop_enabled
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
    def _check_active_window_consistency(self) -> "StrategyCreate":
        validate_active_window_fields(self.active_from_time, self.active_to_time)
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
    horizon: Optional[Horizon] = None
    instrument_type: Optional[InstrumentType] = None
    rule_id: Optional[str] = None
    stop_loss_method: Optional[StopLossMethod] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    target_percent: Optional[float] = Field(default=None, gt=0, lt=100)
    trailing_stop_enabled: Optional[bool] = None
    option_position_style: Optional[OptionPositionStyle] = None
    option_strike_moneyness: Optional[OptionStrikeMoneyness] = None
    option_sl_scope: Optional[OptionSlScope] = None
    option_fixed_lots: Optional[int] = Field(default=None, gt=0)
    contract_day_filter: Optional[ContractDayFilter] = None
    segment: Optional[Segment] = None
    square_off_time: Optional[time] = None
    duplicate_signal_policy: Optional[DuplicateSignalPolicy] = None
    counter_signal_policy: Optional[CounterSignalPolicy] = None
    active_from_time: Optional[time] = None
    active_to_time: Optional[time] = None


class StrategyOut(BaseModel):
    id: str
    name: str
    source_type: SourceType
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
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    option_position_style: OptionPositionStyle = "spread"
    option_strike_moneyness: OptionStrikeMoneyness = "ATM"
    option_sl_scope: OptionSlScope = "combined"
    option_fixed_lots: Optional[int] = None
    contract_day_filter: ContractDayFilter = "any"
    segment: Segment
    square_off_time: Optional[time] = None
    duplicate_signal_policy: DuplicateSignalPolicy = "skip"
    counter_signal_policy: CounterSignalPolicy = "close_and_flip"
    active_from_time: Optional[time] = None
    active_to_time: Optional[time] = None
    status: Status
    created_at: datetime
    updated_at: datetime

"""Pydantic mirror of docs/contracts/resolved-order.schema.json (consumer
side) plus execution's own domain types. If the contract changes, change
this too."""

from datetime import date, datetime, time
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


# stop_loss_indicator_type params shapes - mirrors signal-generation's own
# EmaStopParams/SupertrendStopParams (app/domain/rule.py) exactly, but
# duplicated rather than imported (systems/* self-contained, see
# docs/architecture.md). A ResolvedOrder's own stop_loss_indicator_params
# never needs shape-checking here - signal-generation already validated it
# before publishing. ManualPositionCreate below is a new entry point with
# no such upstream validator, so execution needs its own copy of this
# dispatch to reject a malformed dict with a 422 instead of a 500 deep
# inside position_manager's _STOP_LOSS_COMPUTE_FUNCS.
class EmaStopParams(BaseModel):
    period: int = Field(gt=1)


class SupertrendStopParams(BaseModel):
    period: int = Field(gt=1)
    multiplier: float = Field(gt=0)


_STOP_LOSS_INDICATOR_PARAMS_MODELS: dict[str, type[BaseModel]] = {
    "ema": EmaStopParams,
    "supertrend": SupertrendStopParams,
}


def validate_stop_loss_indicator_params(indicator_type: str, raw: dict) -> BaseModel:
    """Raises pydantic.ValidationError (a 422 at the route layer, via
    ManualPositionCreate's own model_validator) if `raw` doesn't match
    `indicator_type`'s expected shape. Unrecognized indicator_type raises
    ValueError instead - the DB CHECK constraint on stop_loss_indicator_type
    (infra/postgres/init/02-execution.sql) is the first line of defense,
    but must be widened in lockstep with this dict and signal-generation's
    own identical registry whenever a new type is added."""
    model = _STOP_LOSS_INDICATOR_PARAMS_MODELS.get(indicator_type)
    if model is None:
        raise ValueError(f"unknown stop_loss_indicator_type '{indicator_type}'")
    return model.model_validate(raw)


def _validate_stop_loss_config(
    stop_loss_price: Optional[float],
    stop_loss_method: Optional[str],
    stop_loss_interval: Optional[str],
    stop_loss_percent: Optional[float],
    stop_loss_indicator_type: Optional[str],
    stop_loss_indicator_params: Optional[dict],
    trailing_stop_enabled: bool,
) -> None:
    """Shared by ManualPositionCreate (at order placement) and
    StopLossUpdate (attaching/replacing a stop-loss on an already-open
    position) - both offer the identical choice: a flat, fixed
    `stop_loss_price`, OR `stop_loss_method` + its own sibling fields
    (percent/previous_candle/indicator). Raises ValueError, which Pydantic
    turns into a 422 either way. Whether at least one of stop_loss_price/
    stop_loss_method must be present at all is the ONE thing that differs
    between the two callers (optional for a fresh order - no stop-loss at
    all is valid; required for an explicit "set the stop-loss" edit), so
    that check stays in each model's own validator, not here."""
    if stop_loss_method is not None and stop_loss_price is not None:
        raise ValueError("stop_loss_price and stop_loss_method are mutually exclusive - pick one")
    if stop_loss_method is None:
        if trailing_stop_enabled:
            raise ValueError("trailing_stop_enabled requires a stop_loss_method")
        return
    if stop_loss_method in ("percent", "breakeven") and stop_loss_percent is None:
        raise ValueError(f"stop_loss_method='{stop_loss_method}' requires stop_loss_percent")
    # See signal-generation's identical check (app/domain/generation/models.py's
    # validate_stop_loss_fields) - 'breakeven' does nothing without trailing.
    if stop_loss_method == "breakeven" and not trailing_stop_enabled:
        raise ValueError("stop_loss_method='breakeven' requires trailing_stop_enabled=true")
    if stop_loss_method in ("previous_candle", "indicator") and stop_loss_interval is None:
        raise ValueError(f"stop_loss_method='{stop_loss_method}' requires stop_loss_interval")
    if stop_loss_method == "indicator":
        if stop_loss_indicator_type is None or stop_loss_indicator_params is None:
            raise ValueError("stop_loss_method='indicator' requires stop_loss_indicator_type and stop_loss_indicator_params")
        validate_stop_loss_indicator_params(stop_loss_indicator_type, stop_loss_indicator_params)


class ResolvedOrder(BaseModel):
    """What arrives on the orders.resolved Redis stream. No quantity - see
    ExecutionSettings.capital_per_trade/risk_per_trade_pct; execution
    sizes its own positions rather than being told a number.
    stop_loss_method/_interval/_percent/target_percent/trailing_stop_enabled
    are passed through unchanged from the resolved Strategy
    (signal-generation) - execution never calls signal-generation
    directly to get them."""

    signal_id: str
    strategy_id: str
    symbol: str
    exchange: Literal["NSE", "MCX", "CRYPTO"]
    action: Literal["BUY", "SELL"]
    horizon: Literal["intraday", "positional"]
    instrument_type: Literal["spot", "future", "option"]
    segment: Literal["NSE", "MCX", "CRYPTO"]
    strategy: Optional[dict] = None
    price: float
    resolved_at: datetime
    status: str
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator", "breakeven"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = None
    # stop_loss_method='indicator' only - see
    # position_manager.py's _STOP_LOSS_COMPUTE_FUNCS.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    # Independent of stop_loss_method/target_percent - a single Condition
    # (signal-engine's Term/Condition shape, untyped dict here since
    # signal-engine already validated it before publishing - same
    # reasoning stop_loss_indicator_params gives) evaluated on every
    # exit-monitor tick, see position_manager.py's app.domain.exit_condition
    # and docs/contracts/resolved-order.schema.json.
    exit_condition: Optional[dict] = None
    # Per-strategy signal-conflict policy, also passed through unchanged
    # from the resolved Strategy - see _resolve_signal_conflicts in
    # position_manager.py.
    duplicate_signal_policy: Literal["skip", "add_position"] = "skip"
    counter_signal_policy: Literal["skip", "close_and_flip"] = "close_and_flip"
    # instrument_type='option' only - see docs/contracts/resolved-order.schema.json.
    option_sl_scope: Optional[Literal["combined", "individual"]] = None
    # Every instrument_type - see docs/contracts/resolved-order.schema.json
    # and position_manager.open_position/option_position_manager.open_option_group.
    fixed_lots: Optional[int] = None
    # segment='NSE'+horizon='positional'+instrument_type='spot' only - see
    # docs/contracts/resolved-order.schema.json and
    # position_manager.open_position/_open_delta_fee_fields.
    use_margin: bool = False
    # Whoever was logged in (systems/accounts) when the Strategy was
    # created - null for one created with no bearer token, or any
    # pre-existing Strategy from before this field existed. See
    # docs/contracts/resolved-order.schema.json's own comment and
    # position_manager.open_position.
    owner_user_id: Optional[str] = None


class ExecutionSettings(BaseModel):
    timezone: str
    # CRYPTO only - a manually configured INR-per-USD rate used to convert
    # capital_per_trade/current_balance (INR) into USD-equivalent before
    # sizing a CRYPTO position (Delta Exchange India prices everything in
    # raw USD) - see docs/architecture.md. None until an admin sets one
    # via PUT /settings - CRYPTO positions reject cleanly rather than
    # sizing against an unconverted number until then.
    usdinr_rate: Optional[float] = None


class ExecutionSettingsUpdate(BaseModel):
    """PUT /settings - all fields optional, only what's provided changes."""

    usdinr_rate: Optional[float] = Field(default=None, gt=0)


class AccountOut(BaseModel):
    """One row per segment (NSE/MCX/CRYPTO) - see execution.accounts.
    current_balance moves only on realized P&L (square-off/stop-loss/
    target/manual close), never on open - see docs/architecture.md
    § 'Why paper-trading accounts are per-segment, not per-strategy'."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    starting_balance: float
    current_balance: float
    # current_balance - starting_balance, computed server-side purely for
    # display convenience (the frontend would otherwise compute the exact
    # same subtraction itself). unrealized_pnl is the live mark-to-market
    # sum across this account's own OPEN positions (segment+owner scoped) -
    # see accounts.py's own _unrealized_pnl.
    realized_pnl: float
    unrealized_pnl: float
    capital_per_trade: float
    risk_per_trade_pct: float
    # Manual tab only - see Account.min_reward_risk_ratio's own comment.
    min_reward_risk_ratio: float
    # Manual tab only - see Account.enforce_risk_based_lots's own comment.
    enforce_risk_based_lots: bool
    # CRYPTO and NSE only - a margin multiplier applied to effective_capital
    # before sizing (Delta Exchange India trades perpetual futures on
    # margin; NSE spot uses the same field for BOTH positional MTF -
    # borrowed cash held overnight, with a real interest cost - and
    # intraday MIS margin - no interest, position always flat by end of
    # day). Defaults to 1 (no leverage) - harmlessly present but unused for
    # MCX. See position_manager.open_position/open_manual_position's own
    # sizing branches.
    leverage: float
    # NSE only (both MTF and intraday MIS margin - NOT applied to CRYPTO's
    # own leverage above). Shaves this % off the leveraged effective_capital
    # before sizing - headroom against slippage between the signal/order
    # price and the actual fill price, so a position sized against the
    # leveraged notional doesn't risk exceeding the account's real margin
    # capacity. Default 10 (not 0 - a real account should keep some
    # buffer unless explicitly set to 0). See position_manager.open_position/
    # open_manual_position's own sizing branches.
    leverage_buffer_pct: float
    # NSE MTF only - the manually configured annualized interest rate on
    # the borrowed portion of a leverage > 1 NSE positional position. NULL
    # until set - such a position is REJECTED rather than opened with
    # unmodeled interest cost. See position_manager.open_position.
    mtf_annual_interest_rate_pct: Optional[float] = None
    # The one segment-wide square-off cutoff - any intraday position still
    # OPEN past this local time-of-day gets forcefully closed. NULL means
    # never force-closed (CRYPTO's default - crypto trades 24/7). Used to
    # be a per-Strategy field; moved here since it's a market-hours
    # concept, not a per-strategy one - see docs/architecture.md.
    square_off_time: Optional[time] = None
    # Live-broker-adapter P0/P1 (see docs/architecture.md) - opts THIS
    # account into real Dhan order submission on the Manual tab's spot/
    # future path (app/domain/live_broker.py). Still gated by the
    # platform-wide LIVE_TRADING_KILL_SWITCH env var on top - both must
    # allow it. Defaults false (paper-only). max_order_value/max_daily_loss
    # are optional safety caps, meaningful only once this is true.
    live_trading_enabled: bool
    max_order_value: Optional[float] = None
    max_daily_loss: Optional[float] = None
    updated_at: datetime


class AccountUpdate(BaseModel):
    """PUT /accounts/{segment} - all fields optional, only what's provided
    changes. Setting starting_balance also re-baselines current_balance to
    the same value (a deliberate re-seed, not just "change the number the
    account started at while keeping today's realized P&L standing" -
    those two can't be pulled apart meaningfully, since current_balance
    only ever moved relative to the OLD starting point). See
    POST /accounts/{segment}/reset for resetting current_balance back to
    whatever starting_balance already is, without changing it."""

    starting_balance: Optional[float] = Field(default=None, gt=0)
    capital_per_trade: Optional[float] = Field(default=None, gt=0)
    risk_per_trade_pct: Optional[float] = Field(default=None, gt=0, le=100)
    min_reward_risk_ratio: Optional[float] = Field(default=None, gt=0)
    enforce_risk_based_lots: Optional[bool] = None
    leverage: Optional[float] = Field(default=None, gt=0)
    leverage_buffer_pct: Optional[float] = Field(default=None, ge=0, lt=100)
    # Explicitly settable back to null (disables NSE MTF leverage>1 orders
    # again) - same model_fields_set-distinguished pattern square_off_time
    # below already uses.
    mtf_annual_interest_rate_pct: Optional[float] = Field(default=None, ge=0)
    # Explicitly settable back to null (never force-close) - unlike most
    # other fields here, None is a real, meaningful value for this one, not
    # just "leave unchanged." Route layer uses model_fields_set (same
    # pattern Strategy.fixed_lots' PATCH handler already uses) to
    # distinguish "omitted" from "explicitly cleared."
    square_off_time: Optional[time] = None
    # Live-broker-adapter P0/P1 - see AccountOut's own comment. None here
    # means "leave unchanged" for live_trading_enabled (a plain bool
    # toggle, same convention enforce_risk_based_lots already uses);
    # max_order_value/max_daily_loss follow square_off_time's own
    # model_fields_set-distinguished pattern instead, since an explicit
    # null IS meaningful for them too (removes the cap, not "unchanged").
    live_trading_enabled: Optional[bool] = None
    max_order_value: Optional[float] = Field(default=None, gt=0)
    max_daily_loss: Optional[float] = Field(default=None, gt=0)


class StrategyAccountOut(BaseModel):
    """Optional per-strategy override of a segment's shared account - see
    execution.strategy_accounts. Deliberately no leverage/square_off_time
    (see that table's own comment) - those always come from AccountOut for
    the same segment, never overridden here."""

    strategy_id: str
    segment: Literal["NSE", "MCX", "CRYPTO"]
    starting_balance: float
    current_balance: float
    # See AccountOut's own identical pair - same meaning, scoped to this
    # strategy's own OPEN positions (strategy_id, not owner/segment).
    realized_pnl: float
    unrealized_pnl: float
    capital_per_trade: float
    risk_per_trade_pct: float
    # Live-broker-adapter P3 item 14 (see docs/architecture.md) - the ONLY
    # way an automated Strategy-driven signal can ever place a real order:
    # the platform-wide shared account (execution.accounts, user_id NULL)
    # has no such field at all and can never go live. live_trading_user_id
    # is whose own BYO Dhan credentials execute this strategy's real
    # orders - None until explicitly set via PUT.
    live_trading_user_id: Optional[str] = None
    live_trading_enabled: bool
    max_order_value: Optional[float] = None
    max_daily_loss: Optional[float] = None
    updated_at: datetime


class StrategyAccountCreate(BaseModel):
    """POST /accounts/strategy/{strategy_id} - segment isn't editable
    afterward (same reasoning Account's own segment PK isn't), so it's
    required here and absent from StrategyAccountUpdate below. Live-
    trading fields aren't settable at creation - opted into afterward via
    PUT, same as every other account here (a fresh row is always
    paper-only until someone deliberately changes that)."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    starting_balance: float = Field(gt=0)
    capital_per_trade: float = Field(gt=0)
    risk_per_trade_pct: float = Field(gt=0, le=100)


class StrategyAccountUpdate(BaseModel):
    """PUT /accounts/strategy/{strategy_id} - same shape as AccountUpdate
    minus leverage/square_off_time (not fields on this table at all).
    Doesn't touch current_balance - see the /reset route for that.
    live_trading_user_id/max_order_value/max_daily_loss follow
    AccountUpdate's own model_fields_set-distinguished nullable pattern
    (an explicit null clears the field, omitting it leaves it unchanged);
    live_trading_enabled is a plain bool toggle like Account's own -
    the route enforces DB's own "live_trading_enabled requires
    live_trading_user_id" constraint with a clean 422 before it ever
    reaches the DB CHECK."""

    capital_per_trade: Optional[float] = Field(default=None, gt=0)
    risk_per_trade_pct: Optional[float] = Field(default=None, gt=0, le=100)
    live_trading_user_id: Optional[str] = None
    live_trading_enabled: Optional[bool] = None
    max_order_value: Optional[float] = Field(default=None, gt=0)
    max_daily_loss: Optional[float] = Field(default=None, gt=0)


class ChecklistItemOut(BaseModel):
    """One row of execution.checklist_items - see infra/postgres/init/
    02-execution.sql's own comment on that table."""

    id: str
    label: str
    phase: Literal["plan", "review", "day"]
    # Empty = every segment - see that column's own comment.
    segments: list[Literal["NSE", "MCX", "CRYPTO"]]
    sort_order: int
    active: bool


class ChecklistItemCreate(BaseModel):
    """POST /checklist-items - sort_order defaults to sort after every
    existing item IN THE SAME PHASE (computed in the route, not here) when
    omitted."""

    label: str = Field(min_length=1)
    phase: Literal["plan", "review", "day"] = "plan"
    segments: list[Literal["NSE", "MCX", "CRYPTO"]] = []
    sort_order: Optional[int] = None


class ChecklistItemUpdate(BaseModel):
    """PUT /checklist-items/{id} - all fields optional, only what's
    provided changes. `active=false` hides an item from future trades'
    checklists without deleting it (past trades' plan_checklist/
    review_checklist snapshots are unaffected either way - see those
    columns' own comments). `segments`, if provided at all (even `[]`,
    meaning "clear back to every segment"), replaces the existing list
    wholesale - there's no meaningful "unset" state distinct from `[]` to
    preserve, unlike e.g. Strategy.fixed_lots."""

    label: Optional[str] = Field(default=None, min_length=1)
    phase: Optional[Literal["plan", "review", "day"]] = None
    segments: Optional[list[Literal["NSE", "MCX", "CRYPTO"]]] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class ChecklistAnswer(BaseModel):
    """One item of ManualPositionCreate/ManualOptionPositionCreate's own
    plan_checklist, ReviewSubmit's own checklist, or DailyChecklistSubmit's
    own answers - a full {label, checked} SNAPSHOT of one
    execution.checklist_items row at order/review/day-submission time, not
    a reference by id - see those fields' own comments for why. `label` is
    trusted as sent by the frontend (which always renders from a fresh
    GET /checklist-items first) - validate_plan_checklist
    (position_manager.py) only checks the COUNT against currently-active
    'plan'-phase items and that every `checked` is true, not that labels
    match verbatim; ReviewSubmit.checklist ('review'-phase) and
    DailyChecklistSubmit.answers ('day'-phase) aren't count/all-checked
    validated at all - see those fields' own comments."""

    label: str
    checked: bool


class DailyChecklistSubmit(BaseModel):
    """PUT /daily-checklist - upserts today's (server-computed date,
    `segment`) row. `answers` (plain {label, checked} - same shape as
    ChecklistAnswer, no per-item notes) isn't count/all-checked validated
    against the currently-active 'day'-phase items scoped to `segment`
    (same "record honestly" reasoning as ReviewSubmit.checklist) -
    submitting at all is what clears position_manager.
    find_missing_daily_checklist's gate for this segment for the rest of
    today. `notes`: ONE free-text observation for the whole submission,
    not per item - see execution.daily_checklist_log's own comment."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    answers: list[ChecklistAnswer] = []
    notes: Optional[str] = None


class DailyChecklistOut(BaseModel):
    """GET /daily-checklist response - `answers`/`submitted_at` are None
    when nothing has been submitted yet today for this segment (the gate
    is still active in that case)."""

    log_date: date
    segment: Literal["NSE", "MCX", "CRYPTO"]
    answers: Optional[list[ChecklistAnswer]] = None
    notes: Optional[str] = None
    submitted_at: Optional[datetime] = None


class TradingSessionOut(BaseModel):
    """Response shape for POST /trading-sessions/check-in, /check-out,
    and GET /trading-sessions - one row per session INSTANCE (a
    (log_date, segment) can have several - see execution.trading_sessions'
    own comment). `checked_out_at` None means this session is still
    open."""

    id: str
    log_date: date
    segment: Literal["NSE", "MCX", "CRYPTO"]
    checked_in_at: datetime
    checked_out_at: Optional[datetime] = None


class ReviewSubmit(BaseModel):
    """PUT /positions/{id}/review and PUT /option-groups/{id}/review - the
    Complete step of the discipline checklist, submitted once a manual
    trade closes. `violation`: did this trade deviate from its own plan
    checklist - required `notes` when true. `accepted_loss`: the "I accept
    this loss" acknowledgement - the route computes the trade's actual
    outcome from its own pnl (never trusts a client-supplied label) and
    rejects with a 422 if pnl < 0 and this isn't set. `checklist`: the
    'review'-phase items (self-assessed execution fidelity - e.g. "stayed
    per plan, not adjusted mid-trade") as a {label, checked} snapshot,
    same shape as plan_checklist - deliberately NOT required to be fully
    checked or even present (unlike plan_checklist): an unchecked item
    here IS the useful signal ("I didn't actually do this"), not something
    to gate on."""

    violation: bool
    notes: Optional[str] = None
    accepted_loss: bool = False
    checklist: list[ChecklistAnswer] = []

    @model_validator(mode="after")
    def _check_notes_on_violation(self) -> "ReviewSubmit":
        if self.violation and not (self.notes and self.notes.strip()):
            raise ValueError("notes are required when violation=true")
        return self


class ManualPositionCreate(BaseModel):
    """POST /positions/manual - the Manual tab (signal-generation's
    frontend), spot/future only. Deliberately not a ResolvedOrder - see
    open_manual_position's docstring.

    Two mutually exclusive ways to protect the position: a flat
    `stop_loss_price` (fixed at entry, no re-anchoring - the original
    "enter SL manually" case), OR `stop_loss_method` + its own sibling
    fields (percent/previous_candle/indicator - same shape Strategy-driven
    orders already carry via ResolvedOrder, now reachable from the Manual
    tab too). `trailing_stop_enabled` only means something alongside a
    stop_loss_method - see position_manager._evaluate_exits for how it
    re-anchors (only tightening, never loosening) on each exit-monitor
    tick, exactly like a Strategy's own trailing stop."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    symbol: str
    action: Literal["BUY", "SELL"]
    instrument_type: Literal["spot", "future"]
    price: float = Field(gt=0)
    # Which of ManualTab.tsx's two entry modes placed this trade - stored
    # as-is for future performance review (see execution.positions.order_type's
    # own comment), never used to change how `price` itself is treated here:
    # by the time this reaches the route, ManualTab.tsx has already
    # resolved a concrete price either way (a fresh live LTP for 'market',
    # the caller-typed trigger for 'limit').
    order_type: Literal["market", "limit"] = "market"
    # Bypasses auto-sizing entirely when given - same precedence pattern
    # as Strategy.fixed_lots in open_position. Number of LOTS,
    # not raw underlying units - a no-op distinction for spot (lot_size is
    # always 1 there) but real for future (e.g. CRYPTO BTCUSD lot_size=
    # 0.001) - see open_manual_position's own comment at the multiply.
    quantity: Optional[float] = Field(default=None, gt=0)
    stop_loss_price: Optional[float] = Field(default=None, gt=0)
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator", "breakeven"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0)
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    trailing_stop_enabled: bool = False
    # Per-position override of the segment's own execution.accounts.
    # square_off_time - omitted (the normal case) means this position
    # inherits the segment default exactly as before. Given explicitly,
    # it takes precedence for THIS position only - the segment default
    # itself (and every other position already open) is untouched. Lets a
    # position be squared off ahead of a segment's own cutoff (e.g. MCX's
    # 18:00 volatility-regime change, well before its 22:00-ish full
    # close) while still allowing new positions after that time - see
    # docs/architecture.md § "Square-off redesign" for why this is
    # per-position and not a second segment-wide setting.
    square_off_time: Optional[time] = None
    # Trade discipline checklist (see ChecklistAnswer above) - the row's
    # own snapshot of every currently-active execution.checklist_items row
    # and whether it was checked. validate_plan_checklist (position_
    # manager.py) rejects with a 422 unless every one is checked and the
    # count matches what's currently active - enforced at the route layer,
    # not here, since it needs a DB query. An empty list is valid input
    # (some users delete every 'plan' item) - validate_plan_checklist
    # passes it when there are no active 'plan' items either.
    plan_checklist: list[ChecklistAnswer] = []

    @model_validator(mode="after")
    def _check_stop_loss_config(self) -> "ManualPositionCreate":
        _validate_stop_loss_config(
            self.stop_loss_price,
            self.stop_loss_method,
            self.stop_loss_interval,
            self.stop_loss_percent,
            self.stop_loss_indicator_type,
            self.stop_loss_indicator_params,
            self.trailing_stop_enabled,
        )
        return self

    @model_validator(mode="after")
    def _check_segment_instrument_type(self) -> "ManualPositionCreate":
        # CRYPTO (Delta Exchange India) and MCX have no cash/spot market on
        # this platform's providers - see position_manager.open_position's
        # identical CRYPTO-sizing comment. 'spot' here used to size at
        # lot_size=1 (one full raw-price underlying unit), permanently
        # unaffordable for CRYPTO's fractional-lot perpetuals. Mirrors
        # signal-generation's validate_segment_instrument_type for
        # Strategy-driven orders - this is the Manual tab's equivalent
        # entry point, which bypasses signal-generation entirely.
        if self.segment in ("CRYPTO", "MCX") and self.instrument_type == "spot":
            raise ValueError(f"segment='{self.segment}' has no spot market - use instrument_type='future' (or place an option order instead)")
        return self


class ManualOptionPositionCreate(BaseModel):
    """POST /option-groups/manual - the Manual tab (signal-generation's
    frontend), option orders. Deliberately not a ResolvedOrder, same
    reasoning as ManualPositionCreate above - and deliberately NOT routed
    through an auto-provisioned Strategy either (the pre-2026-08-14 design)
    - see open_manual_option_group's docstring. No price field: option
    legs are always priced off a live quote at open time, never a
    caller-supplied price (mirrors open_option_group, which never reads
    order.price for leg pricing either)."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    symbol: str  # the logical underlying (e.g. "NIFTY", "GOLDM", "BTCUSD"), not a leg's own symbol
    action: Literal["BUY", "SELL"]
    option_position_style: Literal["spread", "naked"] = "spread"
    option_strike_moneyness: Literal["ITM2", "ITM1", "ATM", "OTM1", "OTM2"] = "ATM"
    # Optional override - omitted (the normal case, no Expiry dropdown in
    # the frontend anymore as of 2026-08-14) means open_manual_option_group
    # picks the nearest currently-tradeable expiry itself, matching the
    # pre-2026-08-14 Strategy-mediated path's own always-nearest behavior.
    # A caller-supplied value is still validated against a live
    # GET /options/expiries call in open_manual_option_group, not just
    # format-checked here.
    expiry: Optional[str] = None
    sl_scope: Literal["combined", "individual"] = "combined"
    # Bypasses auto-sizing entirely when given - same precedence pattern
    # as Strategy.fixed_lots in open_option_group.
    option_fixed_lots: Optional[float] = Field(default=None, gt=0)
    # Trade discipline checklist - see ManualPositionCreate.plan_checklist's
    # own comment, identical meaning here (empty list valid, same reasoning).
    plan_checklist: list[ChecklistAnswer] = []
    # Which of ManualTab.tsx's two entry modes placed this trade - see
    # ManualPositionCreate.order_type's own comment. Means the same thing
    # here despite there being no caller-supplied `price` field above:
    # the Limit field is always a SPOT trigger (wait until the underlying
    # crosses it, then resolve legs at whatever premium is live then),
    # never the option's own premium.
    order_type: Literal["market", "limit"] = "market"
    # Per-position override of the segment's own square_off_time - see
    # ManualPositionCreate.square_off_time's own comment, identical
    # meaning here (applied to the group and every one of its legs).
    square_off_time: Optional[time] = None


class StopLossUpdate(BaseModel):
    """PUT /positions/{id}/stop-loss and PUT /option-groups/{id}/stop-loss.
    option-groups only ever uses the flat `stop_loss_price` form (no
    trailing/indicator concept exists for options yet - see
    open_option_group's own 'percent'-only stop-loss) - its route reads
    only that field, the rest are simply ignored there.

    For positions, the same choice ManualPositionCreate offers at order
    placement time is offered again here, for attaching (or replacing) a
    trailing stop-loss AFTER a position is already open - a flat
    `stop_loss_price` (fixed, clears any previously-armed trailing
    method), OR `stop_loss_method` + its own sibling fields (percent/
    previous_candle/indicator). Unlike ManualPositionCreate, at least one
    of the two must be given here - this endpoint's whole purpose is
    setting a stop-loss, not optionally skipping it."""

    stop_loss_price: Optional[float] = Field(default=None, gt=0)
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator", "breakeven"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0)
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    trailing_stop_enabled: bool = False

    @model_validator(mode="after")
    def _check_stop_loss_config(self) -> "StopLossUpdate":
        if self.stop_loss_price is None and self.stop_loss_method is None:
            raise ValueError("must supply either stop_loss_price or stop_loss_method")
        _validate_stop_loss_config(
            self.stop_loss_price,
            self.stop_loss_method,
            self.stop_loss_interval,
            self.stop_loss_percent,
            self.stop_loss_indicator_type,
            self.stop_loss_indicator_params,
            self.trailing_stop_enabled,
        )
        return self


class SquareOffTimeUpdate(BaseModel):
    """PUT /positions/{id}/square-off-time and PUT /option-groups/{id}/
    square-off-time - edits an already-open position's/group's own
    square_off_time (see ManualPositionCreate.square_off_time's own
    comment for what this means). `None` clears the override back to
    "never force-closed by this row's own value" - NOT back to the
    segment's current default, since that was already baked in at open
    time and this endpoint has no way to distinguish "explicitly want no
    time cutoff at all" from "want the segment default"; re-open the
    position to pick up a changed segment default instead."""

    square_off_time: Optional[time] = None


class SpotStopLossUpdate(BaseModel):
    """PUT /option-groups/{id}/spot-stop-loss - a stop expressed on the
    underlying's own price, independent of StopLossUpdate above (which
    only ever moves the combined-PREMIUM stop) - see
    option_position_manager.py's update_group_spot_stop_loss/
    _evaluate_option_group_exits. No trailing/method variants, same
    flat-price-only scope StopLossUpdate has for options."""

    spot_stop_loss_price: float = Field(gt=0)

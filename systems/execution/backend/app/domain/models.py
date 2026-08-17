"""Pydantic mirror of docs/contracts/resolved-order.schema.json (consumer
side) plus execution's own domain types. If the contract changes, change
this too."""

from datetime import datetime, time
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
    if stop_loss_method == "percent" and stop_loss_percent is None:
        raise ValueError("stop_loss_method='percent' requires stop_loss_percent")
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
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = None
    # stop_loss_method='indicator' only - see
    # position_manager.py's _STOP_LOSS_COMPUTE_FUNCS.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
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
    capital_per_trade: float
    risk_per_trade_pct: float
    # CRYPTO only - a margin multiplier applied to effective_capital before
    # sizing (Delta Exchange India trades perpetual futures on margin).
    # Defaults to 1 (no leverage) - harmlessly present but unused for
    # NSE/MCX. See position_manager.open_position.
    leverage: float
    # The one segment-wide square-off cutoff - any intraday position still
    # OPEN past this local time-of-day gets forcefully closed. NULL means
    # never force-closed (CRYPTO's default - crypto trades 24/7). Used to
    # be a per-Strategy field; moved here since it's a market-hours
    # concept, not a per-strategy one - see docs/architecture.md.
    square_off_time: Optional[time] = None
    updated_at: datetime


class AccountUpdate(BaseModel):
    """PUT /accounts/{segment} - all fields optional, only what's provided
    changes. Does not touch current_balance - see POST /accounts/{segment}/reset
    for that."""

    capital_per_trade: Optional[float] = Field(default=None, gt=0)
    risk_per_trade_pct: Optional[float] = Field(default=None, gt=0, le=100)
    leverage: Optional[float] = Field(default=None, gt=0)
    # Explicitly settable back to null (never force-close) - unlike most
    # other fields here, None is a real, meaningful value for this one, not
    # just "leave unchanged." Route layer uses model_fields_set (same
    # pattern Strategy.fixed_lots' PATCH handler already uses) to
    # distinguish "omitted" from "explicitly cleared."
    square_off_time: Optional[time] = None


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
    # Bypasses auto-sizing entirely when given - same precedence pattern
    # as Strategy.fixed_lots in open_position. Number of LOTS,
    # not raw underlying units - a no-op distinction for spot (lot_size is
    # always 1 there) but real for future (e.g. CRYPTO BTCUSD lot_size=
    # 0.001) - see open_manual_position's own comment at the multiply.
    quantity: Optional[float] = Field(default=None, gt=0)
    stop_loss_price: Optional[float] = Field(default=None, gt=0)
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = Field(default=None, gt=0)
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    trailing_stop_enabled: bool = False

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
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
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


class SpotStopLossUpdate(BaseModel):
    """PUT /option-groups/{id}/spot-stop-loss - a stop expressed on the
    underlying's own price, independent of StopLossUpdate above (which
    only ever moves the combined-PREMIUM stop) - see
    option_position_manager.py's update_group_spot_stop_loss/
    _evaluate_option_group_exits. No trailing/method variants, same
    flat-price-only scope StopLossUpdate has for options."""

    spot_stop_loss_price: float = Field(gt=0)

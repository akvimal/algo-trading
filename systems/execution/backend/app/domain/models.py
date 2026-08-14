"""Pydantic mirror of docs/contracts/resolved-order.schema.json (consumer
side) plus execution's own domain types. If the contract changes, change
this too."""

from datetime import datetime, time
from typing import Literal, Optional

from pydantic import BaseModel, Field


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
    horizon: Literal["intraday", "swing", "positional"]
    instrument_type: Literal["spot", "future", "option"]
    segment: Literal["NSE", "MCX", "CRYPTO"]
    strategy: Optional[dict] = None
    price: float
    resolved_at: datetime
    status: str
    stop_loss_method: Optional[Literal["previous_candle", "percent"]] = None
    stop_loss_interval: Optional[Literal["1min", "5min", "15min", "25min", "60min"]] = None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    # Per-strategy signal-conflict policy, also passed through unchanged
    # from the resolved Strategy - see _resolve_signal_conflicts in
    # position_manager.py.
    duplicate_signal_policy: Literal["skip", "add_position"] = "skip"
    counter_signal_policy: Literal["skip", "close_and_flip"] = "close_and_flip"
    # instrument_type='option' only - see docs/contracts/resolved-order.schema.json.
    option_sl_scope: Optional[Literal["combined", "individual"]] = None
    option_fixed_lots: Optional[int] = None


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
    # pattern Strategy.option_fixed_lots' PATCH handler already uses) to
    # distinguish "omitted" from "explicitly cleared."
    square_off_time: Optional[time] = None


class ManualPositionCreate(BaseModel):
    """POST /positions/manual - the Manual tab (signal-generation's
    frontend), spot/future only. Deliberately not a ResolvedOrder - see
    open_manual_position's docstring."""

    segment: Literal["NSE", "MCX", "CRYPTO"]
    symbol: str
    action: Literal["BUY", "SELL"]
    instrument_type: Literal["spot", "future"]
    price: float = Field(gt=0)
    # Bypasses auto-sizing entirely when given - same precedence pattern
    # as Strategy.option_fixed_lots in open_option_group. Number of LOTS,
    # not raw underlying units - a no-op distinction for spot (lot_size is
    # always 1 there) but real for future (e.g. CRYPTO BTCUSD lot_size=
    # 0.001) - see open_manual_position's own comment at the multiply.
    quantity: Optional[float] = Field(default=None, gt=0)
    stop_loss_price: Optional[float] = Field(default=None, gt=0)


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
    # User-picked, not auto-chosen - the whole point of this endpoint over
    # the Strategy-mediated path, which always picked the nearest expiry
    # for horizon='intraday' with no override. Validated against a live
    # GET /options/expiries call in open_manual_option_group, not just
    # format-checked here.
    expiry: str
    sl_scope: Literal["combined", "individual"] = "combined"
    # Bypasses auto-sizing entirely when given - same precedence pattern
    # as Strategy.option_fixed_lots in open_option_group.
    option_fixed_lots: Optional[float] = Field(default=None, gt=0)


class StopLossUpdate(BaseModel):
    """PUT /positions/{id}/stop-loss and PUT /option-groups/{id}/stop-loss."""

    stop_loss_price: float = Field(gt=0)

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
    # Required for horizon='intraday' only (enforced on Strategy) - null
    # for swing/positional, since square-off doesn't apply there.
    # open_position() defensively rejects if this is missing for an
    # otherwise-supported (intraday+spot) order - see there.
    square_off_time: Optional[time] = None
    # Per-strategy signal-conflict policy, also passed through unchanged
    # from the resolved Strategy - see _resolve_signal_conflicts in
    # position_manager.py.
    duplicate_signal_policy: Literal["skip", "add_position"] = "add_position"
    counter_signal_policy: Literal["skip", "close_and_flip"] = "close_and_flip"
    # instrument_type='option' only - see docs/contracts/resolved-order.schema.json.
    option_sl_scope: Optional[Literal["combined", "individual"]] = None


class ExecutionSettings(BaseModel):
    timezone: str


class ExecutionSettingsUpdate(BaseModel):
    """PUT /settings - all fields optional, only what's provided changes."""


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
    updated_at: datetime


class AccountUpdate(BaseModel):
    """PUT /accounts/{segment} - all fields optional, only what's provided
    changes. Does not touch current_balance - see POST /accounts/{segment}/reset
    for that."""

    capital_per_trade: Optional[float] = Field(default=None, gt=0)
    risk_per_trade_pct: Optional[float] = Field(default=None, gt=0, le=100)

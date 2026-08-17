"""Pydantic mirror of docs/contracts/*.schema.json - the two are the same
contract in two forms. If you change one, change the other."""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class SignalIngest(BaseModel):
    """Matches docs/contracts/signal-ingest.schema.json - the canonical
    shape every provider intake route (app/api/routes/webhooks.py)
    normalizes into before calling create_signal_from_ingest."""

    strategy_id: str
    symbol: str
    exchange: Literal["NSE", "MCX", "CRYPTO"]
    action: Literal["BUY", "SELL"]
    price: float = Field(gt=0)
    timestamp: Optional[datetime] = None
    source: str
    source_meta: Optional[dict] = None


class RawIngest(BaseModel):
    """Payload accepted by POST /ingest/raw before normalization."""

    provider: str
    raw_payload: dict


class ResolvedOrderDraft(BaseModel):
    """Output of the resolution pipeline, before it's persisted/published.
    Matches docs/contracts/resolved-order.schema.json minus the fields
    that only exist once persisted (signal_id, resolved_at, status)."""

    horizon: Literal["intraday", "positional"]
    instrument_type: Literal["spot", "future", "option"]
    segment: Literal["NSE", "MCX", "CRYPTO"]
    strategy: Optional[dict] = None
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[Literal["1min", "3min", "5min", "15min", "25min", "30min", "60min"]] = None
    stop_loss_percent: Optional[float] = None
    # stop_loss_method='indicator' only - see docs/contracts/resolved-order.schema.json.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    duplicate_signal_policy: Literal["skip", "add_position"] = "skip"
    counter_signal_policy: Literal["skip", "close_and_flip"] = "close_and_flip"
    # instrument_type='option' only - see docs/contracts/resolved-order.schema.json.
    option_sl_scope: Optional[Literal["combined", "individual"]] = None
    # Every instrument_type - see docs/contracts/resolved-order.schema.json.
    fixed_lots: Optional[int] = None

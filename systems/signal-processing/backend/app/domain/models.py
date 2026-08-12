"""Pydantic mirror of docs/contracts/*.schema.json - the two are the same
contract in two forms. If you change one, change the other."""

from datetime import datetime, time
from typing import Literal, Optional

from pydantic import BaseModel, Field


class SignalIngest(BaseModel):
    """Matches docs/contracts/signal-ingest.schema.json - what n8n posts
    to POST /signals after provider-specific normalization."""

    strategy_id: str
    symbol: str
    exchange: Literal["NSE", "MCX"]
    action: Literal["BUY", "SELL"]
    price: float = Field(gt=0)
    timestamp: Optional[datetime] = None
    source: str
    source_meta: Optional[dict] = None


class RawIngest(BaseModel):
    """What n8n posts to POST /ingest/raw before normalization."""

    provider: str
    raw_payload: dict


class ResolvedOrderDraft(BaseModel):
    """Output of the resolution pipeline, before it's persisted/published.
    Matches docs/contracts/resolved-order.schema.json minus the fields
    that only exist once persisted (signal_id, resolved_at, status)."""

    horizon: Literal["intraday", "swing", "positional"]
    instrument_type: Literal["spot", "future", "option"]
    segment: Literal["NSE", "MCX", "CRYPTO"]
    strategy: Optional[dict] = None
    stop_loss_method: Optional[Literal["previous_candle", "percent"]] = None
    stop_loss_interval: Optional[Literal["1min", "5min", "15min", "25min", "60min"]] = None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    # Required for horizon='intraday' only (enforced on Strategy) - null
    # for swing/positional, since square-off doesn't apply there.
    square_off_time: Optional[time] = None
    duplicate_signal_policy: Literal["skip", "add_position"] = "add_position"
    counter_signal_policy: Literal["skip", "close_and_flip"] = "skip"

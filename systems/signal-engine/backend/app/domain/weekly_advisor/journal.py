"""Save/journal/performance for the Weekly Options Advisor - deliberately
NOT execution integration. Every strategy weekly_advisor recommends
(sell_otm_put/sell_otm_call/short_strangle/iron_condor) is net-short-premium,
and execution's option P&L/sizing/SL math hardcodes a long-premium
assumption in ~8 places (docs/architecture.md "Open questions -> Credit
spreads", deferred 2026-08-18, not started - a sign error there would
silently misreport PnL/SL). So "select/execute" here means: save a
recommendation snapshot, let the user record what they actually did by
hand (a manual trade journal), and compute performance stats off that
journal - never a real execution-opened position.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .contracts import OptionType, WeeklyRecommendation


class TradeLeg(BaseModel):
    """One leg of the journaled trade - independent of the recommendation's
    own StrategyLeg (contracts.py), which carries no quantity/entry_price
    since it's a stateless, per-symbol *plan*. This is per-trade, mutable
    state: a trade is often journaled off-session (a weekend or mid-week
    review) with provisional numbers, then the legs actually fill once the
    market opens - entry_price starts as whatever the user planned against
    and gets overwritten with the real fill via PUT .../trades/{id}/entry,
    without needing to re-create the trade."""

    option_type: OptionType
    strike: float
    side: Literal["sell", "buy"]
    quantity: Optional[float] = Field(default=None, gt=0)
    entry_price: Optional[float] = None


class SaveRecommendationRequest(BaseModel):
    symbol: str = Field(min_length=1)
    as_of: Optional[date] = None


class SavedRecommendationOut(BaseModel):
    id: str
    symbol: str
    as_of: date
    action: str
    saved_at: datetime
    payload: WeeklyRecommendation
    decision: Optional[Literal["execute", "hold", "drop"]] = None
    confidence: Optional[int] = None
    decision_comments: Optional[str] = None
    decided_at: Optional[datetime] = None


class DecisionSet(BaseModel):
    """PUT /weekly-advisor/recommendations/{id}/decision - a lightweight
    "did you act on this" note, independent of whether a trade was ever
    journaled. `confidence` only makes sense for decision='execute' but
    isn't enforced against the others - a caller can leave it unset."""

    decision: Literal["execute", "hold", "drop"]
    confidence: Optional[int] = Field(default=None, ge=1, le=5)
    comments: Optional[str] = Field(default=None, max_length=2000)


class TradeCreate(BaseModel):
    """POST /weekly-advisor/recommendations/{id}/trades - "mark as taken".
    Every field is optional - the user may log this well after the fact,
    or not know the exact numbers yet. funds_needed/margin_needed/pop/
    max_profit/max_loss are plain user-entered figures (typically copied
    from an options-analytics platform like Sensibull) - this module has
    no margin engine or live-Greeks POP model of its own, see the module
    docstring. days_to_expiry_at_entry is NOT accepted here - the route
    derives it from the recommendation's own entry_window.

    actual_bias/actual_strategy record what the user actually traded,
    deliberately independent of the recommendation's own regime.bias/
    strategy.action - a trader reviewing a recommendation is free to (and
    often will) act on a different read. actual_bias mirrors the same
    bullish/bearish/neutral vocabulary as regime.bias for comparability;
    actual_strategy is free text (not constrained to StrategyAction) since
    what someone actually traded can be a shape this engine doesn't model
    at all (e.g. a naked leg instead of the recommended iron condor).

    legs is typically pre-filled by the caller from the recommendation's
    own strategy.legs (scaled by quantity) and is provisional at creation
    time - see TradeLeg and TradeEntryUpdate for why it's editable
    afterward. target_pct_of_max_profit/stop_loss_pct_of_max_loss are the
    close-out thresholds to watch this position against; target defaults
    from the recommendation's own exit_rule if the caller omits it,
    stop_loss has no engine default at all."""

    quantity: Optional[float] = Field(default=None, gt=0)
    entry_credit: Optional[float] = None
    entry_notes: Optional[str] = Field(default=None, max_length=2000)
    funds_needed: Optional[float] = None
    margin_needed: Optional[float] = None
    pop: Optional[float] = Field(default=None, ge=0, le=100)
    max_profit: Optional[float] = None
    max_loss: Optional[float] = None
    actual_bias: Optional[Literal["bullish", "bearish", "neutral"]] = None
    actual_strategy: Optional[str] = Field(default=None, max_length=100)
    legs: Optional[list[TradeLeg]] = None
    target_pct_of_max_profit: Optional[float] = Field(default=None, ge=0, le=100)
    stop_loss_pct_of_max_loss: Optional[float] = Field(default=None, ge=0, le=100)


class TradeEntryUpdate(BaseModel):
    """PUT /weekly-advisor/trades/{id}/entry - overwrite provisional entry
    data with the real thing once the legs actually fill (this is a manual
    paper-trading workflow: a trade is often journaled off-session with
    numbers copied from an options-analytics platform, then the market
    opens and fills at different prices). Every field optional and
    merge-style like DecisionSet - only supplied fields change, everything
    else on the trade is left alone. Entry-side fields only; exit/closing
    a trade is still TradeClose's job, and the route this backs refuses to
    touch a closed trade (its entry is history at that point)."""

    quantity: Optional[float] = Field(default=None, gt=0)
    entry_credit: Optional[float] = None
    entry_notes: Optional[str] = Field(default=None, max_length=2000)
    funds_needed: Optional[float] = None
    margin_needed: Optional[float] = None
    pop: Optional[float] = Field(default=None, ge=0, le=100)
    max_profit: Optional[float] = None
    max_loss: Optional[float] = None
    actual_bias: Optional[Literal["bullish", "bearish", "neutral"]] = None
    actual_strategy: Optional[str] = Field(default=None, max_length=100)
    legs: Optional[list[TradeLeg]] = None
    target_pct_of_max_profit: Optional[float] = Field(default=None, ge=0, le=100)
    stop_loss_pct_of_max_loss: Optional[float] = Field(default=None, ge=0, le=100)


class TradeClose(BaseModel):
    """PUT /weekly-advisor/trades/{id}/close. realized_pnl is a plain
    user-entered number, not derived from entry_credit/exit_debit*lot_size
    - this module deliberately doesn't know real lot sizes/margin (that's
    exactly the piece missing from execution, see module docstring), so it
    never pretends to compute P&L itself."""

    exit_debit: Optional[float] = None
    realized_pnl: Optional[float] = None
    exit_notes: Optional[str] = Field(default=None, max_length=2000)


class TradeOut(BaseModel):
    id: str
    recommendation_id: str
    symbol: str
    action: str
    status: Literal["open", "closed"]
    quantity: Optional[float]
    entry_credit: Optional[float]
    entry_notes: Optional[str]
    taken_at: datetime
    exit_debit: Optional[float]
    realized_pnl: Optional[float]
    exit_notes: Optional[str]
    closed_at: Optional[datetime]
    funds_needed: Optional[float] = None
    margin_needed: Optional[float] = None
    pop: Optional[float] = None
    max_profit: Optional[float] = None
    max_loss: Optional[float] = None
    days_to_expiry_at_entry: Optional[int] = None
    actual_bias: Optional[Literal["bullish", "bearish", "neutral"]] = None
    actual_strategy: Optional[str] = None
    legs: Optional[list[TradeLeg]] = None
    target_pct_of_max_profit: Optional[float] = None
    stop_loss_pct_of_max_loss: Optional[float] = None


class PerformanceSummary(BaseModel):
    open_count: int
    closed_count: int
    win_count: int
    loss_count: int
    win_rate: Optional[float]  # None when closed_count == 0 - no divide-by-zero guess
    total_realized_pnl: float
    by_symbol: dict[str, float]  # symbol -> summed realized_pnl, closed trades only


def compute_performance_summary(trades: list[TradeOut]) -> PerformanceSummary:
    """Pure aggregation over already-fetched trade rows - kept separate
    from the DB-querying route so it's unit-testable without a live
    Session, same "pure core, thin route" split the rest of this backend
    uses. Only trades with a non-null realized_pnl count toward win/loss -
    a closed trade the user never entered a P&L for is excluded from the
    win-rate math rather than silently counted as a loss."""
    open_count = sum(1 for t in trades if t.status == "open")
    scored = [t for t in trades if t.status == "closed" and t.realized_pnl is not None]
    closed_count = sum(1 for t in trades if t.status == "closed")
    win_count = sum(1 for t in scored if t.realized_pnl > 0)
    loss_count = sum(1 for t in scored if t.realized_pnl <= 0)
    win_rate = round(win_count / len(scored), 3) if scored else None
    total_pnl = sum(t.realized_pnl for t in scored)

    by_symbol: dict[str, float] = {}
    for t in scored:
        by_symbol[t.symbol] = by_symbol.get(t.symbol, 0.0) + t.realized_pnl

    return PerformanceSummary(
        open_count=open_count,
        closed_count=closed_count,
        win_count=win_count,
        loss_count=loss_count,
        win_rate=win_rate,
        total_realized_pnl=round(total_pnl, 2),
        by_symbol={k: round(v, 2) for k, v in by_symbol.items()},
    )

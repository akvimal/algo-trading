"""One user's trading for one day, for the post-session Telegram summary (market-data draws the card and writes the message; this only
supplies the numbers, over the internal service route). The same trades the performance page counts: the person's own MANUAL trades (not the
auto-trader's), net of charges and slippage where the account applied them, with paper and live kept apart.

What it answers: how the day went in money and against the account, which trades were good and which were not (judged by whether the PLAN
was followed, not by whether the trade made money), and how that compares with the last 30 days."""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.equity_history import compute_equity_stats, current_curve, to_point
from app.domain.performance import TradeRecord, _has_plan, _realized_r, compute_discipline, compute_performance, day_key, load_manual_trades

STATS_DAYS = 30
MAX_TRADES_LISTED = 8
CURVE_POINTS = 30


def classify(t: TradeRecord) -> dict:
    """Good or bad by the PLAN, not the result: a loss inside the plan is a good trade, a win without one is luck.
    followed = a limit entry with a stop, not closed by hand before the stop or target did the job."""
    planned = _has_plan(t)
    by_hand = t.exit_reason == "manual"
    followed = planned and not by_hand
    issues = []
    if t.stop_loss_price is None:
        issues.append("no stop")
    if t.order_type != "limit":
        issues.append("market entry")
    if by_hand:
        issues.append("closed by hand")
    pnl = t.pnl_inr or 0.0
    if pnl > 0:
        verdict = "good_win" if followed else "lucky_win"
    elif pnl < 0:
        verdict = "good_loss" if followed else "avoidable_loss"
    else:
        verdict = "flat"
    return {"followed": followed, "verdict": verdict, "issues": issues}


def _trade_view(t: TradeRecord) -> dict:
    r = _realized_r(t)
    held = None
    if t.entry_time is not None and t.exit_time is not None:
        held = max(0, int((t.exit_time - t.entry_time).total_seconds() // 60))
    return {
        "symbol": t.symbol, "label": t.label, "side": t.side, "pnl": t.pnl_inr, "r": round(r, 2) if r is not None else None,
        "entry": t.entry_price, "exit": t.exit_price, "held_minutes": held, "exit_reason": t.exit_reason, **classify(t),
    }


@dataclass
class ModeDay:
    trades: int
    wins: int
    losses: int
    net_pnl: float
    charges: float
    with_plan: int  # trades that were a limit order with a stop
    best: Optional[dict]
    worst: Optional[dict]
    followed_count: int
    followed_pnl: float
    broke_count: int
    broke_pnl: float
    items: list  # the trades, newest first, capped
    more: int  # how many were left off `items`


def _leg(t: TradeRecord) -> dict:
    r = _realized_r(t)
    return {"symbol": t.symbol, "pnl": t.pnl_inr, "r": round(r, 2) if r is not None else None, "exit_reason": t.exit_reason}


def _mode_day(trades: list[TradeRecord]) -> Optional[ModeDay]:
    counted = sorted((t for t in trades if t.pnl_inr is not None), key=lambda t: t.exit_time, reverse=True)
    if not counted:
        return None
    followed = [t for t in counted if classify(t)["followed"]]
    broke = [t for t in counted if not classify(t)["followed"]]
    return ModeDay(
        trades=len(counted),
        wins=sum(1 for t in counted if t.pnl_inr > 0),
        losses=sum(1 for t in counted if t.pnl_inr < 0),
        net_pnl=sum(t.pnl_inr for t in counted),
        charges=sum(t.charges for t in counted),
        with_plan=sum(1 for t in counted if _has_plan(t)),
        best=_leg(max(counted, key=lambda t: t.pnl_inr)),
        worst=_leg(min(counted, key=lambda t: t.pnl_inr)),
        followed_count=len(followed),
        followed_pnl=sum(t.pnl_inr for t in followed),
        broke_count=len(broke),
        broke_pnl=sum(t.pnl_inr for t in broke),
        items=[_trade_view(t) for t in counted[:MAX_TRADES_LISTED]],
        more=max(0, len(counted) - MAX_TRADES_LISTED),
    )


def stats_over(trades: list[TradeRecord], day: date, days: int = STATS_DAYS) -> Optional[dict]:
    """How the trades of the last `days` calendar days did: win rate, profit factor, average win and loss, expectancy."""
    since = day - timedelta(days=days - 1)
    window = [t for t in trades if since <= day_key(t.exit_time) <= day]
    perf = compute_performance(window)
    if perf is None:
        return None
    return {
        "days": days, "trades": perf.trades, "win_rate_pct": perf.win_rate_pct, "profit_factor": perf.profit_factor, "avg_win": perf.avg_win,
        "avg_loss": perf.avg_loss, "expectancy": perf.avg_pnl, "avg_r": perf.avg_r, "net_pnl": perf.total_pnl,
        "max_consecutive_losses": perf.max_consecutive_losses,
    }


def open_now(db: Session, user_id: UUID, segment: str) -> int:
    """Manual positions (single, and whole spreads) still open."""
    P, G = db_models.Position, db_models.OptionPositionGroup
    singles = db.query(P).filter(P.user_id == user_id, P.strategy_id.is_(None), P.status == "OPEN", P.segment == segment, P.option_group_id.is_(None), P.horizon != "positional").count()
    groups = db.query(G).filter(G.user_id == user_id, G.strategy_id.is_(None), G.status == "OPEN", G.segment == segment).count()
    return singles + groups


def account_view(db: Session, user_id: UUID, segment: str, day_pnl: float, month_pnl: float) -> Optional[dict]:
    """The paper account: its balance, how much today moved it, how far it is from where it started, and the recent equity curve.
    A day's change is the day's realized net result, because the balance is credited by exactly that when a trade closes."""
    account = db.query(db_models.Account).filter_by(user_id=user_id, segment=segment, book="intraday").first()
    if account is None:
        return None
    balance = float(account.current_balance)
    start = float(account.starting_balance)
    start_of_day = balance - day_pnl
    snaps = db.query(db_models.AccountEquitySnapshot).filter_by(account_id=account.id).order_by(db_models.AccountEquitySnapshot.snapshot_date.asc()).all()
    points = [to_point(r) for r in snaps]
    curve = [p.equity for p in current_curve(points)][-CURVE_POINTS:]
    stats = compute_equity_stats(points)
    return {
        "balance": balance,
        "starting_balance": start,
        "day_change": day_pnl,
        "day_change_pct": (day_pnl / start_of_day * 100.0) if start_of_day else None,
        "since_start_pct": ((balance / start - 1) * 100.0) if start else None,
        "month_pnl": month_pnl,
        "curve": curve + [balance],
        "max_drawdown_pct": stats.max_drawdown_pct if stats is not None else None,
    }


def trader_day(db: Session, user_id: UUID, segment: str, day: date) -> dict:
    """The day's closed trades split into paper and live (each with a verdict per trade), the paper account's change, the last 30 days'
    stats, what is still open, and the 30-day discipline score. `day` is an IST date."""
    everything = load_manual_trades(db, user_id, segment)
    manual = [t for t in everything if not t.auto_traded]
    today = [t for t in manual if day_key(t.exit_time) == day]
    out = {}
    for mode, flag in (("paper", False), ("live", True)):
        d = _mode_day([t for t in today if t.live is flag])
        out[mode] = d.__dict__ if d else None
    paper_all = [t for t in manual if not t.live]
    day_pnl = sum(t.pnl_inr for t in today if not t.live and t.pnl_inr is not None)
    month_pnl = sum(t.pnl_inr for t in paper_all if t.pnl_inr is not None and (day_key(t.exit_time).year, day_key(t.exit_time).month) == (day.year, day.month))
    score = compute_discipline(everything, 30).get("score")
    return {
        "segment": segment,
        "day": day.isoformat(),
        **out,
        "account": account_view(db, user_id, segment, day_pnl, month_pnl),
        "stats": {"paper": stats_over(paper_all, day), "live": stats_over([t for t in manual if t.live], day)},
        "open_now": open_now(db, user_id, segment),
        "discipline_score": score,
    }

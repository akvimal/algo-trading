"""The paper track record a user must earn before real orders can be enabled.

Turning live trading on with real money should follow a demonstrated paper
record, not a beginner's first click. This evaluates six requirements from the
server-side figures (app/domain/performance.py, equity_history.py):

  costs      Indian charges are switched on AND slippage is at least a floor, so
             the record is not flattered by frictionless fills
  trades     enough closed manual trades that were recorded WITH costs applied
             (a trade with no recorded charges was never net of costs and cannot
             count: otherwise someone could graduate on a gross-flattered
             history and only then switch costs on)
  days       enough calendar days on the current equity curve
  discipline the discipline score (the 4-component habit score) is high enough
  drawdown   the close-of-day max drawdown of the current curve is small enough
  profit     the net P&L of those costed trades is positive

The current curve starts at the latest reset, so a reset restarts the clock
rather than hiding earlier results. Every threshold is a setting (see
app/config.py, TRACK_RECORD_*); the defaults are product judgments, not
measurements (confirmed as the starting values by the owner on 2026-09-25) and
should be retuned once real users' records show what is achievable. The gate is off unless
REQUIRE_PAPER_TRACK_RECORD=true.

Applies on the off -> on transition of (1) a user's OWN segment account
(app/api/routes/accounts.py, update_account) and (2) a dedicated STRATEGY account:
turning on unattended automated live trading requires the LIVE USER (the person whose
broker account will execute it, who must be the one switching it on) to have earned the
same manual paper record on that segment. NOT applied to the admin platform account.
KNOWN GAP for (2): the strategy's OWN paper record is not measured, because strategy
trades are not costed (strategy accounts have no apply_charges/slippage) and their
equity is not recorded, so this only proves the person is a demonstrated paper trader,
not that the strategy is any good. An account that is already live is not re-checked
until it is switched off and on again.
"""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings
from app.domain.equity_history import compute_equity_stats, to_point
from app.domain.performance import compute_discipline, compute_performance, epoch_start, load_manual_trades

DISCIPLINE_WINDOW_DAYS = 30


@dataclass(frozen=True)
class Thresholds:
    min_trades: int
    min_days: int
    min_discipline: int
    max_drawdown_pct: float
    min_slippage_bps: float

    @classmethod
    def from_settings(cls) -> "Thresholds":
        return cls(
            min_trades=settings.track_record_min_trades,
            min_days=settings.track_record_min_days,
            min_discipline=settings.track_record_min_discipline,
            max_drawdown_pct=settings.track_record_max_drawdown_pct,
            min_slippage_bps=settings.track_record_min_slippage_bps,
        )


@dataclass(frozen=True)
class Requirement:
    key: str
    label: str
    required: str
    actual: str
    met: bool


def evaluate(
    th: Thresholds,
    *,
    apply_charges: bool,
    slippage_bps: float,
    qualifying_trades: int,
    days_tracked: int,
    discipline_score: Optional[int],
    max_drawdown_pct: Optional[float],
    net_pnl: Optional[float],
) -> list[Requirement]:
    """Pure: every requirement with its required and actual value, met or not."""
    costs_on = apply_charges and slippage_bps >= th.min_slippage_bps
    return [
        Requirement(
            "costs", "Realistic costs switched on", f"charges on and slippage >= {th.min_slippage_bps:g} bps",
            f"charges {'on' if apply_charges else 'off'}, slippage {slippage_bps:g} bps", costs_on,
        ),
        Requirement("trades", "Paper trades recorded with costs", f"{th.min_trades} trades", f"{qualifying_trades} trades", qualifying_trades >= th.min_trades),
        Requirement("days", "Days on the current record", f"{th.min_days} days", f"{days_tracked} days", days_tracked >= th.min_days),
        Requirement(
            "discipline", "Discipline score", f">= {th.min_discipline}",
            "not enough trades yet (needs 5)" if discipline_score is None else str(discipline_score),
            discipline_score is not None and discipline_score >= th.min_discipline,
        ),
        Requirement(
            "drawdown", "Max drawdown (close of day)", f"<= {th.max_drawdown_pct:g}%",
            "no equity history yet" if max_drawdown_pct is None else f"{max_drawdown_pct:.1f}%",
            max_drawdown_pct is not None and max_drawdown_pct <= th.max_drawdown_pct,
        ),
        Requirement(
            "profit", "Net profit after costs", "> 0", "no trades yet" if net_pnl is None else f"{net_pnl:.2f}",
            net_pnl is not None and net_pnl > 0,
        ),
    ]


def unmet_messages(requirements: list[Requirement]) -> list[str]:
    return [f"paper track record: {r.label} is {r.actual}, need {r.required}" for r in requirements if not r.met]


def evaluate_for_user_segment(db: Session, user_id, segment: str, th: Optional[Thresholds] = None) -> list[Requirement]:
    """The requirements for one user on one segment. A user with no account for it yet has
    traded nothing, so every requirement is unmet at zero (an account is created lazily on
    first use, so its absence just means "no record")."""
    account = db.query(db_models.Account).filter_by(user_id=user_id, segment=segment, book="intraday").first()
    if account is None:
        return evaluate(
            th or Thresholds.from_settings(), apply_charges=False, slippage_bps=0.0, qualifying_trades=0, days_tracked=0,
            discipline_score=None, max_drawdown_pct=None, net_pnl=None,
        )
    return evaluate_for_account(db, user_id, account, th)


def evaluate_for_account(db: Session, user_id, account, th: Optional[Thresholds] = None) -> list[Requirement]:
    """Loads the account's current record and evaluates it."""
    th = th or Thresholds.from_settings()
    since = epoch_start(db, account)
    trades = load_manual_trades(db, user_id, account.segment, since)
    costed = [t for t in trades if t.costs_applied and not t.auto_traded]
    perf = compute_performance(costed)
    discipline = compute_discipline(trades, DISCIPLINE_WINDOW_DAYS)
    rows = (
        db.query(db_models.AccountEquitySnapshot)
        .filter_by(account_id=account.id)
        .order_by(db_models.AccountEquitySnapshot.snapshot_date.asc())
        .all()
    )
    stats = compute_equity_stats([to_point(r) for r in rows])
    return evaluate(
        th,
        apply_charges=bool(account.apply_charges),
        slippage_bps=float(account.slippage_bps),
        qualifying_trades=len(costed),
        days_tracked=stats.days_tracked if stats is not None else 0,
        discipline_score=discipline["score"],
        max_drawdown_pct=stats.max_drawdown_pct if stats is not None else None,
        net_pnl=perf.total_pnl if perf is not None else None,
    )

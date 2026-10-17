"""The last N trading sessions as a grid, for the home page.

Two grids from the same closed-trade facts:
  manual - Study / Plan / Trade (execution): in each session, the share of the person's REVIEWED trades that made no mistake at that level.
           A trade the person has not reviewed gives no verdict, so a session with none reviewed is shown as 'unreviewed', never as a pass.
  bot    - Result / Wins / Clean run for what the bots (auto-traded fills) did: a bot has no study or plan to judge, so the questions are
           whether the day made money, how many trades won, and whether it ran by its rules (every trade had a stop at entry, nothing failed).

Pure: facts in, sessions out (newest first, a session with no trade at all never appears). The thresholds are the ones the person asked for: above 80% good,
50 to 80% middling, below 50% poor."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Iterable, Optional

from app.domain.discipline_v2 import TradeFacts
from app.domain.performance import day_key
from app.domain.trade_review import LEVELS, TAG_LEVEL

SESSIONS = 10
# The execution level is called "Trade" on the grid: did the person follow the plan once in the trade.
GRID_LEVELS = {"study": "study", "plan": "plan", "execution": "trade"}


def band(rate: Optional[float]) -> str:
    """good (above 80%), mid (50 to 80%), poor (below 50%), or none when there is nothing to judge."""
    if rate is None:
        return "none"
    if rate > 0.8:
        return "good"
    if rate >= 0.5:
        return "mid"
    return "poor"


def _by_day(facts: Iterable[TradeFacts]) -> dict[date, list[TradeFacts]]:
    days: dict[date, list[TradeFacts]] = defaultdict(list)
    for f in facts:
        days[day_key(f.exit_time)].append(f)
    return days


def manual_sessions(facts: Iterable[TradeFacts], limit: int = SESSIONS) -> list[dict]:
    """Each session: its date, how many trades closed, how many are still unreviewed, and per level `{ok, of, rate, band}` over the reviewed ones."""
    out = []
    for day, rows in sorted(_by_day(facts).items(), reverse=True)[:limit]:
        reviewed = [f for f in rows if f.root_cause]
        cells = {}
        for level in LEVELS:
            if not reviewed:
                cells[GRID_LEVELS[level]] = {"ok": 0, "of": 0, "rate": None, "band": "none"}
                continue
            ok = sum(1 for f in reviewed if not any(TAG_LEVEL.get(t) == level for t in (f.mistake_tags or [])))
            rate = ok / len(reviewed)
            cells[GRID_LEVELS[level]] = {"ok": ok, "of": len(reviewed), "rate": round(rate, 3), "band": band(rate)}
        out.append({"date": day.isoformat(), "trades": len(rows), "unreviewed": len(rows) - len(reviewed), **cells})
    return out


def bot_sessions(facts: Iterable[TradeFacts], failed_by_day: dict[date, int], limit: int = SESSIONS) -> list[dict]:
    """Each session the bots traded: net result, how many won, and whether the day ran by the rules (a stop at entry on every trade, and no failed decision)."""
    out = []
    for day, rows in sorted(_by_day(facts).items(), reverse=True)[:limit]:
        pnl = round(sum(f.pnl or 0.0 for f in rows), 2)
        wins = sum(1 for f in rows if (f.pnl or 0) > 0)
        win_rate = wins / len(rows)
        no_stop = sum(1 for f in rows if f.stop0 is None)
        failed = failed_by_day.get(day, 0)
        # failures are the worst sign, a missing stop the next; both zero is a clean run
        clean = "poor" if failed else ("mid" if no_stop else "good")
        out.append({
            "date": day.isoformat(), "trades": len(rows), "pnl": pnl, "wins": wins, "win_rate": round(win_rate, 3),
            "result": "good" if pnl > 0 else ("poor" if pnl < 0 else "mid"), "wins_band": band(win_rate), "clean": clean,
            "no_stop": no_stop, "failed": failed,
        })
    return out

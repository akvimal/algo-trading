"""The 1-3 day open-interest swing idea, run as a SHADOW: every night it writes down what a bot would have done and, a few days later, what
happened. It places no orders. The point is to learn which criteria matter before any bot trades them (see app/scheduler.py's
_record_oi_swing_shadow, migration 063, GET /oi-swing/shadow).

Why a shadow and not a backtest: the option-premium flow labels (buying / writing) exist only from 2026-10-15 and Dhan has no chain history to
backfill them, so the signal this idea leans on cannot be replayed. Every row here stores the VALUE of each criterion, not just pass/fail, so
the thresholds below can be changed later and re-judged against the same rows.

One candidate per stock per night that has an untested trend-aligned daily zone at price (demand -> LONG, supply -> SHORT). A candidate is
`taken` (would have traded) only when no criterion fails. A criterion that could not be evaluated (too little history) is recorded as None and
does not block - it is shown, so a taken row with unevaluated criteria can be told apart from a fully confirmed one.

Pure computation over stored rows: no database, no provider, so it is testable without either.
"""

from __future__ import annotations

import statistics
from datetime import date, timedelta
from typing import Optional

from app.domain.market_calendar import _last_tuesday, _nse_closed_days, _previous_trading_day

# --- thresholds: starting points, not fitted to outcomes (the rows keep the values, so any of these can be revisited) ---
MIN_OI_Z = 1.0  # the supportive side's OI change must sit this many standard deviations above that stock's own recent changes
MIN_HISTORY_DAYS = 5  # fewer prior snapshots than this and the z-score is not evaluated
MIN_ADX = 20.0
MIN_RISK_PCT, MAX_RISK_PCT = 0.5, 7.0  # distance from the close to the zone's far edge, as % of the close
BREADTH_VETO_LONG, BREADTH_VETO_SHORT = 0.30, 0.70  # share of the day's F&O stocks that rose: a long into a <30% day, a short into a >70% day is vetoed
TARGET_R = 1.5
HOLD_DAYS = 3
EXPIRY_DAYS_BEFORE, EXPIRY_DAYS_AFTER = 4, 1  # a decision this close before (or just after) a monthly expiry is skipped: rollover distorts OI

_BULL = {"call": "buying", "put": "writing"}
_BEAR = {"call": "writing", "put": "buying"}


def near_monthly_expiry(day: date) -> bool:
    """True when `day` falls in the window around that month's (or the next month's) monthly F&O expiry, where rollover distorts open interest."""
    closed = _nse_closed_days()
    for y, m in ((day.year, day.month), (day.year + (day.month == 12), day.month % 12 + 1)):
        expiry = _previous_trading_day(_last_tuesday(y, m), closed)
        if expiry - timedelta(days=EXPIRY_DAYS_BEFORE) <= day <= expiry + timedelta(days=EXPIRY_DAYS_AFTER):
            return True
    return False


def oi_z(value: Optional[float], history: list[float]) -> Optional[float]:
    """How far `value` sits above this stock's own recent OI changes, in standard deviations; None when there is too little history to say."""
    if value is None or len(history) < MIN_HISTORY_DAYS:
        return None
    sd = statistics.pstdev(history)
    if sd == 0:
        return None
    return round((value - statistics.fmean(history)) / sd, 2)


def flow_read(direction: str, call_activity: Optional[str], put_activity: Optional[str], oi_agrees: Optional[bool]) -> dict:
    """Does the option flow back the trade? Uses the measured premium flow (call/put buying or writing) when it exists; before it existed
    (or when it is missing) falls back to the price-based buildup agreement and says so in `source`."""
    want, against = (_BULL, _BEAR) if direction == "LONG" else (_BEAR, _BULL)
    if call_activity is None and put_activity is None:
        return {"source": "price_proxy", "value": oi_agrees, "pass": oi_agrees}
    supportive = call_activity == want["call"] or put_activity == want["put"]
    contrary = call_activity == against["call"] or put_activity == against["put"]
    return {"source": "premium_flow", "value": f"call {call_activity or '-'} / put {put_activity or '-'}", "pass": supportive and not contrary}


def evaluate(direction_zone: dict, oi: Optional[dict], oi_history: list[dict], screener: Optional[dict], turnover_median: Optional[float], breadth: Optional[float], day: date) -> dict:
    """The decision for one stock on one night. `direction_zone` is the stock's zone_scan row (as a dict); `oi` its oi_eod_snapshot row for the day;
    `oi_history` its earlier snapshots (call_oi_change_pct / put_oi_change_pct, any order); `screener` its equity_screener_snapshot row;
    `turnover_median` and `breadth` are the day's universe medians."""
    z = direction_zone
    direction = "LONG" if z["zone_kind"] == "demand" else "SHORT"
    oi = oi or {}
    screener = screener or {}
    criteria: dict[str, dict] = {}

    def add(name: str, value, ok: Optional[bool]) -> None:
        criteria[name] = {"value": value, "pass": ok}

    flow = flow_read(direction, oi.get("call_activity"), oi.get("put_activity"), z.get("oi_agrees"))
    criteria["flow"] = {"value": flow["value"], "pass": flow["pass"], "source": flow["source"]}

    # The size of the OI move on the side that backs the trade, against that stock's own history.
    bull = direction == "LONG"
    side_activity = {"call": oi.get("call_activity"), "put": oi.get("put_activity")}
    want = _BULL if bull else _BEAR
    sides = [s for s in ("call", "put") if side_activity[s] == want[s]] or ["put" if bull else "call"]  # unknown flow: the writing side
    changes = {s: oi.get(f"{s}_oi_change_pct") for s in ("call", "put")}
    zs = [v for v in (oi_z(changes[s], [h[f"{s}_oi_change_pct"] for h in oi_history if h.get(f"{s}_oi_change_pct") is not None]) for s in sides) if v is not None]
    best_z = max(zs) if zs else None
    add("oi_surge", best_z, None if best_z is None else best_z >= MIN_OI_Z)

    trend_ok = z["daily_trend"] == ("up" if bull else "down")
    adx = screener.get("adx")
    add("trend", {"daily": z["daily_trend"], "adx": adx}, trend_ok and (adx is None or adx >= MIN_ADX))
    add("weekly", {"trend": z.get("weekly_trend"), "zone": z.get("weekly_zone")}, bool(z.get("weekly_zone") or z.get("weekly_agrees")))

    turnover = screener.get("avg_turnover_cr")
    add("liquidity", turnover, None if turnover is None or turnover_median is None else turnover >= turnover_median)

    close, distal = float(z["close"]), float(z["zone_distal"])
    risk_pct = round(abs(close - distal) / close * 100, 2)
    right_side = distal < close if bull else distal > close
    add("risk", risk_pct, right_side and MIN_RISK_PCT <= risk_pct <= MAX_RISK_PCT)

    add("expiry", near_monthly_expiry(day), not near_monthly_expiry(day))
    add("market", None if breadth is None else round(breadth, 2), None if breadth is None else (breadth >= BREADTH_VETO_LONG if bull else breadth <= BREADTH_VETO_SHORT))
    criteria["events"] = {"value": None, "pass": None}  # no per-stock earnings feed yet: not evaluated, shown as such

    failed = [k for k, v in criteria.items() if v["pass"] is False]
    passed = sum(1 for v in criteria.values() if v["pass"])
    score = passed + {"A": 2, "B": 1}.get(z.get("tier") or "", 0) + (min(best_z, 3) / 3 if best_z else 0)
    return {
        "direction": direction, "taken": not failed, "skip_reason": None if not failed else "failed: " + ", ".join(failed), "criteria": criteria,
        "score": round(score, 2), "tier": z.get("tier"), "ref_close": close, "stop_price": distal, "risk_pct": risk_pct,
    }


def resolve_outcome(direction: str, stop: float, bars: list[dict]) -> Optional[dict]:
    """What the trade would have done, from the bars AFTER the decision night (oldest first, each with open/high/low/close). Enters at the next
    bar's open, stops on the zone's far edge, targets TARGET_R times the risk, and is out at the HOLD_DAYS-th close at the latest. A bar that
    touches both the stop and the target counts as the stop (the safer assumption). None while the trade is still running (fewer than HOLD_DAYS
    bars and no exit yet)."""
    if not bars:
        return None
    bull = direction == "LONG"
    entry = float(bars[0]["open"])
    risk = (entry - stop) if bull else (stop - entry)
    if risk <= 0:
        return {"result": "invalid", "entry_price": entry, "exit_price": entry, "exit_day": 0, "r_multiple": 0.0, "mfe_r": 0.0, "mae_r": 0.0}  # gapped through its own stop
    target = entry + TARGET_R * risk if bull else entry - TARGET_R * risk
    mfe = mae = 0.0
    for n, b in enumerate(bars[:HOLD_DAYS], start=1):
        hi, lo, cl = float(b["high"]), float(b["low"]), float(b["close"])
        fav, adv = ((hi - entry), (entry - lo)) if bull else ((entry - lo), (hi - entry))
        mfe, mae = max(mfe, fav / risk), max(mae, adv / risk)
        hit_stop = lo <= stop if bull else hi >= stop
        hit_target = hi >= target if bull else lo <= target
        if hit_stop:
            return {"result": "stop", "entry_price": entry, "exit_price": stop, "exit_day": n, "r_multiple": -1.0, "mfe_r": round(mfe, 2), "mae_r": round(mae, 2)}
        if hit_target:
            return {"result": "target", "entry_price": entry, "exit_price": target, "exit_day": n, "r_multiple": TARGET_R, "mfe_r": round(mfe, 2), "mae_r": round(mae, 2)}
        if n == HOLD_DAYS:
            r = ((cl - entry) if bull else (entry - cl)) / risk
            return {"result": "time", "entry_price": entry, "exit_price": cl, "exit_day": n, "r_multiple": round(r, 2), "mfe_r": round(mfe, 2), "mae_r": round(mae, 2)}
    return None

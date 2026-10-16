"""Major open-interest shifts: the few stocks whose option picture really moved today, instead of a fixed top-N list that always sends the same
twenty names. Pure computation over stored rows (oi_eod_snapshot), so it is tested without a database.

A stock is a major shift only when ALL of these hold:
  * the option flow leans one way, in option terms - bullish is call buying, call writers covering or put writing; bearish is put buying, put
    writers covering or call writing (unwinding is neutral) - with nothing leaning the other way;
  * the price agrees (moved at least MIN_PRICE_MOVE_PCT in the same direction);
  * it is liquid enough (total OI at or above the day's 40th percentile);
  * and either the PCR moved a lot for THAT stock (at least MIN_PCR_MOVE and well beyond its own usual daily wobble) or the OI on the leading
    side grew a lot against its own history.
It is scored higher when two flows agree, when the lean FLIPPED from yesterday's, and when the PCR move and the OI move are large; it is marked
(and docked) around the monthly expiry, when rollover distorts open interest.

Premium-flow labels (call_activity / put_activity) exist from 2026-10-15; earlier rows, and any stock without them, fall back to the price-based
buildup labels and are tagged "price-based". Per-stock history is short at first, so the standard-deviation checks are skipped (and the plain size
floors used) until there are MIN_HISTORY_DAYS of it."""

from __future__ import annotations

from datetime import date
from typing import Optional

from app.domain.oi_swing_shadow import near_monthly_expiry, oi_z

MIN_PRICE_MOVE_PCT = 0.5
MIN_PCR_MOVE = 0.15
MIN_PCR_Z = 1.5
MIN_OI_MOVE_PCT = 10.0  # the leading side's OI change, when there is enough history to also test it against the stock's own norm
MIN_OI_MOVE_PCT_NO_HISTORY = 15.0  # ...and when there is not
MIN_OI_Z = 2.0
MIN_HISTORY_DAYS = 5
LIQUIDITY_PERCENTILE = 0.4
DEFAULT_LIMIT = 5

# What each side's activity says about direction. Unwinding is deliberately absent: buyers or sellers just leaving is not a new view.
_BULL = {("call", "buying"), ("call", "writers_covering"), ("put", "writing")}
_BEAR = {("put", "buying"), ("put", "writers_covering"), ("call", "writing")}
# Before premium flow was recorded (and when it is missing) the price-based buildup label stands in for it.
_PROXY = {
    ("call", "long_buildup"): "buying", ("call", "short_covering"): "writers_covering", ("call", "short_buildup"): "writing",
    ("put", "long_buildup"): "writing", ("put", "short_buildup"): "buying", ("put", "long_unwinding"): "writers_covering",
}
WORDS = {"buying": "buying", "writing": "writing", "writers_covering": "short covering"}


def activities(row: dict) -> tuple[dict[str, Optional[str]], str]:
    """({"call": activity, "put": activity}, source): the measured premium flow when the row has it, else the price-based stand-in."""
    if row.get("call_activity") or row.get("put_activity"):
        return {"call": row.get("call_activity"), "put": row.get("put_activity")}, "premium_flow"
    return {s: _PROXY.get((s, row.get(f"{s}_buildup"))) for s in ("call", "put")}, "price_proxy"


def lean(row: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str]], str]:
    """(bullish signals, bearish signals, source) as (side, activity) pairs."""
    acts, source = activities(row)
    pairs = [(s, a) for s, a in acts.items() if a]
    return [p for p in pairs if p in _BULL], [p for p in pairs if p in _BEAR], source


def _direction(bull: list, bear: list) -> Optional[str]:
    if bull and not bear:
        return "bullish"
    if bear and not bull:
        return "bearish"
    return None


def _pcr_moves(history: list[dict]) -> list[float]:
    pcrs = [h["pcr"] for h in sorted(history, key=lambda h: h["snapshot_date"]) if h.get("pcr") is not None]
    return [b - a for a, b in zip(pcrs, pcrs[1:])]


def score_stock(row: dict, history: list[dict], liquidity_floor: Optional[float], day: date) -> Optional[dict]:
    """The shift for one stock tonight, or None when it does not qualify. `history` is its earlier snapshots (any order), each with snapshot_date,
    pcr, call/put_oi_change_pct, call/put_activity and call/put_buildup."""
    bull, bear, source = lean(row)
    direction = _direction(bull, bear)
    price = row.get("price_change_pct")
    if direction is None or price is None or abs(price) < MIN_PRICE_MOVE_PCT or (price > 0) != (direction == "bullish"):
        return None
    total_oi = (row.get("total_call_oi") or 0) + (row.get("total_put_oi") or 0)
    if liquidity_floor is not None and total_oi < liquidity_floor:
        return None

    signals = bull or bear
    ordered = sorted(history, key=lambda h: h["snapshot_date"])
    prev = ordered[-1] if ordered else None

    # the PCR move, against this stock's own usual daily move
    pcr, prev_pcr = row.get("pcr"), (prev or {}).get("pcr")
    dpcr = round(pcr - prev_pcr, 2) if pcr is not None and prev_pcr is not None else None
    pcr_with = dpcr is not None and (dpcr > 0) == (direction == "bullish")  # PCR rising backs a bullish read, falling a bearish one
    pcr_z = oi_z(dpcr, _pcr_moves(ordered)) if dpcr is not None else None
    pcr_ok = bool(dpcr is not None and pcr_with and abs(dpcr) >= MIN_PCR_MOVE and (pcr_z is None or abs(pcr_z) >= MIN_PCR_Z))

    # the OI move on the side(s) backing the read, against its own history
    sides = [s for s, _ in signals]
    changes = {s: row.get(f"{s}_oi_change_pct") for s in sides}
    zs = {s: oi_z(changes[s], [h[f"{s}_oi_change_pct"] for h in ordered if h.get(f"{s}_oi_change_pct") is not None]) for s in sides}
    lead = max((s for s in sides if changes[s] is not None), key=lambda s: abs(changes[s]), default=None)
    lead_change, lead_z = (changes[lead], zs[lead]) if lead else (None, None)
    enough = len(ordered) >= MIN_HISTORY_DAYS
    size_ok = bool(
        lead and lead_change is not None
        and (abs(lead_change) >= (MIN_OI_MOVE_PCT if enough else MIN_OI_MOVE_PCT_NO_HISTORY))
        and (lead_z is None or abs(lead_z) >= MIN_OI_Z)
    )
    if not (pcr_ok or size_ok):
        return None

    # did the lean flip from the last snapshot's? Only said when both nights used the same kind of read: the measured premium flow and the
    # price-based stand-in are different instruments, so a "flip" between them would partly be the change of instrument.
    flipped = False
    if prev is not None:
        pb, pr, prev_source = lean(prev)
        before = _direction(pb, pr)
        flipped = before is not None and before != direction and prev_source == source

    expiry = near_monthly_expiry(day)
    score = 1.5 * len(signals) + (1.0 if flipped else 0.0) + (1.0 if pcr_ok else 0.0) + (1.0 if size_ok else 0.0) + min(max(abs(lead_z or 0), 0), 3) / 3 - (1.5 if expiry else 0.0)

    reasons = [f"{s} {WORDS[a]}" for s, a in signals]
    return {
        "symbol": row["symbol"], "direction": direction, "score": round(score, 2), "source": source, "signals": [{"side": s, "activity": a} for s, a in signals],
        "price_change_pct": price, "pcr": pcr, "prev_pcr": prev_pcr, "pcr_move": dpcr, "pcr_z": pcr_z, "pcr_ok": pcr_ok,
        "lead_side": lead, "lead_oi_change_pct": lead_change, "lead_z": lead_z, "size_ok": size_ok, "flipped": flipped, "expiry_week": expiry,
        "reasons": reasons,
    }


def pick_major_shifts(rows: list[dict], history_by_symbol: dict[str, list[dict]], day: date, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """The day's major shifts, best score first, at most `limit` across both directions. Empty on a quiet day: sending nothing is the point."""
    totals = sorted((r.get("total_call_oi") or 0) + (r.get("total_put_oi") or 0) for r in rows)
    floor = totals[int(len(totals) * LIQUIDITY_PERCENTILE)] if totals else None
    found = [s for r in rows if (s := score_stock(r, history_by_symbol.get(r["symbol"], []), floor, day)) is not None]
    return sorted(found, key=lambda s: (-s["score"], s["symbol"]))[:limit]

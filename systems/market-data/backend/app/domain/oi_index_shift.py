"""The intraday index alert: a drastic shift in NIFTY's or BANKNIFTY's option picture over the last half hour, from the 5-minute strike snapshots
(app/scheduler.py's _record_oi_strikes -> market_data.oi_strike_snapshot). Pure computation, tested without a database.

Compared with half an hour ago, over the strikes both snapshots hold:
  * the PCR (put OI / call OI) moved at least MIN_PCR_MOVE;
  * each side's OI and its near-the-money premium say what happened to it (buying, writing, writers covering, unwinding - the same words the nightly
    stock alert uses), and at least two of those flows lean the same way with none leaning the other way, or one does and the lean FLIPPED from the
    half hour before;
  * the index price agrees (moved at least MIN_SPOT_MOVE_PCT the same way).
A bullish shift is call buying, call writers covering or put writing; bearish is put buying, put writers covering or call writing.
The job sends one alert per index per cooldown, and none in the first and last minutes of the session, where OI is noisy."""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Optional

from app.domain.oi_shifts import WORDS, _BEAR, _BULL, _direction

MIN_PCR_MOVE = 0.08
MIN_SPOT_MOVE_PCT = 0.10
MIN_OI_MOVE_PCT = 1.5  # a side's OI over half an hour, across the ~31 kept strikes
MIN_PREMIUM_MOVE_PCT = 1.0
WINDOW_MINUTES = 30
COOLDOWN_MINUTES = 60
ACTIVE_FROM, ACTIVE_TO = time(9, 30), time(15, 15)
NEAR_MONEY_STRIKES = 2  # either side of the strike nearest the spot, for the premium read


def active_now(now: datetime) -> bool:
    return now.weekday() < 5 and ACTIVE_FROM <= now.time() <= ACTIVE_TO


def _sum(rows: list[dict], key: str, strikes: Optional[set] = None) -> Optional[float]:
    vals = [r[key] for r in rows if r.get(key) is not None and (strikes is None or r["strike"] in strikes)]
    return float(sum(vals)) if vals else None


def pcr(rows: list[dict]) -> Optional[float]:
    ce, pe = _sum(rows, "ce_oi"), _sum(rows, "pe_oi")
    return round(pe / ce, 3) if ce and pe is not None else None


def _near_money(rows: list[dict], spot: float) -> set:
    ordered = sorted((r["strike"] for r in rows))
    if not ordered:
        return set()
    atm = min(range(len(ordered)), key=lambda i: abs(ordered[i] - spot))
    return set(ordered[max(0, atm - NEAR_MONEY_STRIKES) : atm + NEAR_MONEY_STRIKES + 1])


def classify(oi_pct: Optional[float], premium_pct: Optional[float]) -> Optional[str]:
    """OI up with the premium up is buying, with the premium down is writing; OI down with the premium up is writers covering, with it down unwinding."""
    if oi_pct is None or premium_pct is None or abs(oi_pct) < MIN_OI_MOVE_PCT or abs(premium_pct) < MIN_PREMIUM_MOVE_PCT:
        return None
    if oi_pct > 0:
        return "buying" if premium_pct > 0 else "writing"
    return "writers_covering" if premium_pct > 0 else "unwinding"


def _pct(new: Optional[float], old: Optional[float]) -> Optional[float]:
    return round((new - old) / old * 100, 2) if new is not None and old else None


def window(then: dict, now: dict) -> dict:
    """What changed between two snapshots ({"spot": float, "rows": [strike rows]}): the PCR, each side's OI and near-the-money premium, the flow
    each implies, and the spot move. Compared over the strikes both hold."""
    common = {r["strike"] for r in then["rows"]} & {r["strike"] for r in now["rows"]}
    a = [r for r in then["rows"] if r["strike"] in common]
    b = [r for r in now["rows"] if r["strike"] in common]
    near = _near_money(b, now["spot"])
    out: dict = {"pcr_then": pcr(a), "pcr_now": pcr(b), "spot_move_pct": _pct(now["spot"], then["spot"])}
    out["pcr_move"] = round(out["pcr_now"] - out["pcr_then"], 3) if out["pcr_now"] is not None and out["pcr_then"] is not None else None
    acts = {}
    for side, oi_key, ltp_key in (("call", "ce_oi", "ce_ltp"), ("put", "pe_oi", "pe_ltp")):
        oi_pct = _pct(_sum(b, oi_key), _sum(a, oi_key))
        prem_pct = _pct(_sum(b, ltp_key, near), _sum(a, ltp_key, near))
        acts[side] = classify(oi_pct, prem_pct)
        out[f"{side}_oi_pct"], out[f"{side}_premium_pct"] = oi_pct, prem_pct
    out["activity"] = acts
    pairs = [(s, x) for s, x in acts.items() if x]
    out["bull"], out["bear"] = [p for p in pairs if p in _BULL], [p for p in pairs if p in _BEAR]
    out["direction"] = _direction(out["bull"], out["bear"])
    return out


def detect(before: Optional[dict], then: dict, now: dict) -> Optional[dict]:
    """The shift over the last window, or None. `before` (the snapshot a window earlier than `then`) is only used to tell a flip from a continuation."""
    w = window(then, now)
    direction = w["direction"]
    if direction is None or w["pcr_move"] is None or w["spot_move_pct"] is None:
        return None
    bullish = direction == "bullish"
    if abs(w["pcr_move"]) < MIN_PCR_MOVE or (w["pcr_move"] > 0) != bullish:
        return None  # PCR rising backs a bullish read, falling a bearish one
    if abs(w["spot_move_pct"]) < MIN_SPOT_MOVE_PCT or (w["spot_move_pct"] > 0) != bullish:
        return None
    signals = w["bull"] if bullish else w["bear"]
    flipped = False
    if before is not None:
        earlier = window(before, then)["direction"]
        flipped = earlier is not None and earlier != direction
    if len(signals) < 2 and not flipped:
        return None
    w.update({"signals": [{"side": s, "activity": a} for s, a in signals], "flipped": flipped, "reasons": [f"{s} {WORDS.get(a, a)}" for s, a in signals]})
    return w


def pick_snapshots(times: list[datetime], now: datetime) -> Optional[tuple[Optional[int], int, int]]:
    """Indices into `times` (oldest first, one per snapshot) of (before, then, latest): `then` is the snapshot nearest WINDOW_MINUTES before the
    latest, `before` the one nearest a further window back. None when the latest is stale (the recorder stalled) or there is nothing old enough."""
    if not times or now - times[-1] > timedelta(minutes=10):
        return None
    last = len(times) - 1

    def nearest(target: datetime, tolerance_min: int, upto: int) -> Optional[int]:
        best = min(range(upto + 1), key=lambda i: abs(times[i] - target), default=None)
        return best if best is not None and abs(times[best] - target) <= timedelta(minutes=tolerance_min) else None

    then = nearest(times[last] - timedelta(minutes=WINDOW_MINUTES), 8, last - 1)
    if then is None:
        return None
    before = nearest(times[then] - timedelta(minutes=WINDOW_MINUTES), 8, then - 1) if then > 0 else None
    return before, then, last

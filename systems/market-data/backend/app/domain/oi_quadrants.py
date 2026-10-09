"""The four-way reading of a stock's day: price against TOTAL open interest (calls and puts together).

                       OI rising                      OI falling
    price up    LONG BUILDUP   (fresh buyers)     SHORT COVERING (sellers leaving)     <- bullish
    price down  SHORT BUILDUP  (fresh sellers)    LONG UNWINDING (buyers leaving)      <- bearish

Used by the end-of-day OI digest (message and picture) and mirrored by the web Scan page (systems/web/frontend/src/pages/scanModel.ts: the
two are tested against the same cases file, tests/fixtures/oi_quadrant_cases.json, so they cannot drift).

A stock only counts when the day was not noise: the price moved at least MIN_PRICE_MOVE_PCT and total OI changed at least MIN_OI_CHANGE_PCT.
Within a quadrant the biggest OI change comes first. A stock that ALSO had call and put OI both grow at least STRONG_MIN_SHIFT percent the same
way (the older "strong two-sided build") is marked as such, so that signal is not lost."""

from __future__ import annotations

from typing import Optional

MIN_PRICE_MOVE_PCT = 0.5
MIN_OI_CHANGE_PCT = 5.0
STRONG_MIN_SHIFT = 10.0

QUADRANTS = ("long_buildup", "short_covering", "short_buildup", "long_unwinding")
BULLISH = ("long_buildup", "short_covering")
BEARISH = ("short_buildup", "long_unwinding")

LABEL = {"long_buildup": "Long buildup", "short_covering": "Short covering", "short_buildup": "Short buildup", "long_unwinding": "Long unwinding"}
MEANING = {
    "long_buildup": "price up, OI up · fresh buyers",
    "short_covering": "price up, OI down · sellers exiting",
    "short_buildup": "price down, OI up · fresh sellers",
    "long_unwinding": "price down, OI down · buyers exiting",
}


def total_oi_change_pct(row: dict) -> Optional[float]:
    """How much call plus put open interest changed in total, as a percent of yesterday's total. Rebuilt from today's totals and each side's
    change (yesterday = today / (1 + change)). None when either side has no change figure or yesterday had none."""
    tc, tp = row.get("total_call_oi"), row.get("total_put_oi")
    cp, pp = row.get("call_oi_change_pct"), row.get("put_oi_change_pct")
    if None in (tc, tp, cp, pp) or cp <= -100 or pp <= -100:
        return None
    previous = tc / (1 + cp / 100) + tp / (1 + pp / 100)
    if previous <= 0:
        return None
    return ((tc + tp) - previous) / previous * 100


def quadrant(row: dict, min_price: float = MIN_PRICE_MOVE_PCT, min_oi: float = MIN_OI_CHANGE_PCT) -> Optional[str]:
    """Which of the four a stock is in, or None when the day was noise or a figure is missing."""
    price, oi = row.get("price_change_pct"), total_oi_change_pct(row)
    if price is None or oi is None or abs(price) < min_price or abs(oi) < min_oi:
        return None
    if price > 0:
        return "long_buildup" if oi > 0 else "short_covering"
    return "short_buildup" if oi > 0 else "long_unwinding"


def is_strong(row: dict, min_shift: float = STRONG_MIN_SHIFT) -> bool:
    """The older two-sided read: call AND put OI both grew at least `min_shift` percent, with a long buildup on both sides (price up) or a
    short buildup on both (price down)."""
    call, put = row.get("call_oi_change_pct"), row.get("put_oi_change_pct")
    if call is None or put is None or call < min_shift or put < min_shift:
        return False
    return (row.get("call_buildup"), row.get("put_buildup")) in (("long_buildup", "long_buildup"), ("short_buildup", "short_buildup"))


def _item(row: dict) -> dict:
    return {
        "symbol": row["symbol"],
        "price_change_pct": row["price_change_pct"],
        "oi_change_pct": total_oi_change_pct(row),
        "call_oi_change_pct": row.get("call_oi_change_pct"),
        "put_oi_change_pct": row.get("put_oi_change_pct"),
        "strong": is_strong(row),
    }


def by_quadrant(rows: list[dict], top_n: int) -> dict[str, dict]:
    """{quadrant: {"items": the top `top_n` by size of OI change, "total": how many stocks are in it}} for all four, always present."""
    buckets: dict[str, list[dict]] = {q: [] for q in QUADRANTS}
    for row in rows:
        q = quadrant(row)
        if q is not None:
            buckets[q].append(_item(row))
    out = {}
    for q, items in buckets.items():
        items.sort(key=lambda i: (-abs(i["oi_change_pct"]), -abs(i["price_change_pct"]), i["symbol"]))
        out[q] = {"items": items[:top_n], "total": len(items)}
    return out

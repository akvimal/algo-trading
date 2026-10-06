"""The rule-based half of the pre-market bias: a pure function from the fetched inputs to a -1..+1 score, so the AI's
call always has a checkable, deterministic counterpart next to it (and one misread by the model cannot set the day's
bias on its own).

Each factor maps its move to -1..+1 against a "full conviction" size, and carries a weight. A factor whose inputs
failed to load is left out and the score is renormalised over what is left, so a missing feed lowers `coverage`
instead of silently reading as "flat". Rising crude, a weaker rupee and rising yields are bearish for India, so those
are inverted. The sizes and weights are starting values, not fitted - the stored reports are what to tune them against.
"""

from __future__ import annotations

from typing import Optional

BULLISH_AT = 0.2
BEARISH_AT = -0.2

# factor key -> (weight, full-conviction move, invert). Moves are % (bp for the yields).
FACTORS = {
    "gift_gap": (3.0, 0.6, False),
    "us_close": (2.0, 1.0, False),
    "adr": (1.5, 1.5, False),
    "crude": (1.0, 2.0, True),
    "usdinr": (1.0, 0.4, True),
    "us10y": (0.5, 8.0, True),
    "in10y": (0.5, 6.0, True),
}
FACTOR_LABELS = {
    "gift_gap": "GIFT Nifty gap", "us_close": "US close", "adr": "Indian ADRs", "crude": "Crude oil",
    "usdinr": "USD/INR", "us10y": "US 10Y yield", "in10y": "India 10Y yield",
}
US_KEYS = ("sp500", "dow", "nasdaq")
ADR_KEYS = ("adr_infy", "adr_hdb", "adr_wit", "adr_ibn", "adr_rdy")


def _clamp(x: float) -> float:
    return max(-1.0, min(1.0, x))


def _avg(by_key: dict, keys: tuple) -> Optional[float]:
    vals = [by_key[k]["change"] for k in keys if k in by_key and by_key[k]["ok"] and by_key[k]["change"] is not None]
    return sum(vals) / len(vals) if vals else None


def gift_gap_pct(by_key: dict) -> Optional[float]:
    gift, ref = by_key.get("gift_nifty"), by_key.get("nifty_close")
    if not gift or not ref or not gift["ok"] or not ref["ok"] or not ref["value"]:
        return None
    return (gift["value"] / ref["value"] - 1) * 100


def moves(by_key: dict) -> dict[str, Optional[float]]:
    """The one number each factor is judged on (None when it could not be computed)."""

    def one(key: str) -> Optional[float]:
        i = by_key.get(key)
        return i["change"] if i and i["ok"] else None

    crude = [v for v in (one("brent"), one("wti")) if v is not None]
    return {
        "gift_gap": gift_gap_pct(by_key),
        "us_close": _avg(by_key, US_KEYS),
        "adr": _avg(by_key, ADR_KEYS),
        "crude": sum(crude) / len(crude) if crude else None,
        "usdinr": one("usdinr"),
        "us10y": one("us10y"),
        "in10y": one("in10y"),
    }


def score_inputs(inputs: list[dict]) -> dict:
    """`inputs` are RawInput.to_dict() rows. Returns the score, the bias it implies, how much of the weight had data,
    and each factor's own contribution (for the explanation shown next to the AI's)."""
    by_key = {i["key"]: i for i in inputs}
    factor_moves = moves(by_key)
    rows = []
    used, weighted = 0.0, 0.0
    total = sum(w for w, _, _ in FACTORS.values())
    for key, (weight, full, invert) in FACTORS.items():
        move = factor_moves[key]
        if move is None:
            rows.append({"key": key, "label": FACTOR_LABELS[key], "move": None, "score": None, "weight": weight})
            continue
        s = _clamp(move / full) * (-1 if invert else 1)
        weighted += weight * s
        used += weight
        rows.append({"key": key, "label": FACTOR_LABELS[key], "move": round(move, 3), "score": round(s, 3), "weight": weight})
    # Rounded BEFORE the thresholds are applied, so the bias always agrees with the score that is shown: a raw 0.1996
    # displayed as "0.20" next to "neutral" (cutoff 0.20) read as a bug.
    score = round(weighted / used, 2) if used else 0.0
    gap = factor_moves["gift_gap"]
    return {
        "score": score,
        "bias": "bullish" if score >= BULLISH_AT else "bearish" if score <= BEARISH_AT else "neutral",
        "coverage": round(used / total, 2),
        "gift_gap_pct": round(gap, 3) if gap is not None else None,
        "factors": rows,
    }

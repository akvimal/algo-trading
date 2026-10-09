"""The rule-based half of the MCX and crypto briefs: the same -1..+1 weighted score as app/domain/premarket_bias.py (a
factor with no data is left out and the score renormalised, so a missing feed lowers `coverage` instead of reading as
"flat"), with each segment's own factors. The sizes and weights are starting values, not fitted.

NSE (in-session pulse): "bullish" means the market is trading higher with broad sectors and falling fear; a rising India VIX is a headwind.
MCX: "bullish" means MCX prices are likely to open higher. A firmer dollar and higher US yields weigh on commodities;
a weaker rupee lifts the rupee price of the same dollar move.
Crypto: "bullish" means risk appetite and the coins' own momentum point up; a firmer dollar, higher yields and a
rising VIX are headwinds.
"""

from __future__ import annotations

from typing import Optional

BULLISH_AT = 0.2
BEARISH_AT = -0.2

# factor key -> (label, weight, full-conviction move, invert, the input keys averaged for it). Moves are % (bp yields, pt Fear & Greed).
FACTORS = {
    "NSE": {
        "nifty": ("Nifty 50", 3.0, 1.0, False, ("nifty",)),
        "banknifty": ("Bank Nifty", 2.0, 1.2, False, ("banknifty",)),
        "sectors": ("Sectors (IT, financials, auto, FMCG, metal, pharma, energy)", 1.5, 1.0, False, ("sec_it", "sec_fin", "sec_auto", "sec_fmcg", "sec_metal", "sec_pharma", "sec_energy")),
        "vix": ("India VIX", 2.0, 8.0, True, ("indiavix",)),
    },
    "MCX": {
        "gold": ("Gold", 3.0, 1.0, False, ("gold",)),
        "silver": ("Silver", 1.5, 1.5, False, ("silver",)),
        "crude": ("Crude oil", 2.0, 2.0, False, ("brent", "wti")),
        "natgas": ("Natural gas", 0.5, 3.0, False, ("natgas",)),
        "copper": ("Copper", 1.0, 1.5, False, ("copper",)),
        "dxy": ("US dollar index", 1.5, 0.5, True, ("dxy",)),
        "usdinr": ("USD/INR", 1.0, 0.4, False, ("usdinr",)),
        "us10y": ("US 10Y yield", 0.5, 8.0, True, ("us10y",)),
    },
    "CRYPTO": {
        "btc": ("Bitcoin", 3.0, 2.0, False, ("btc",)),
        "eth": ("Ether", 2.0, 2.5, False, ("eth",)),
        "sol": ("Solana", 1.0, 3.0, False, ("sol",)),
        "us_risk": ("US equity futures", 1.5, 1.0, False, ("nasdaq_fut", "sp500")),
        "vix": ("VIX", 1.0, 8.0, True, ("vix",)),
        "dxy": ("US dollar index", 1.0, 0.5, True, ("dxy",)),
        "us10y": ("US 10Y yield", 0.5, 8.0, True, ("us10y",)),
        "fear_greed": ("Fear & Greed", 1.0, 10.0, False, ("fear_greed",)),
    },
}


def _clamp(x: float) -> float:
    return max(-1.0, min(1.0, x))


def _avg(by_key: dict, keys: tuple) -> Optional[float]:
    vals = [by_key[k]["change"] for k in keys if k in by_key and by_key[k]["ok"] and by_key[k]["change"] is not None]
    return sum(vals) / len(vals) if vals else None


def score_inputs(segment: str, inputs: list[dict]) -> dict:
    """`inputs` are RawInput.to_dict() rows. Same return shape as premarket_bias.score_inputs (gift_gap_pct is always None here)."""
    by_key = {i["key"]: i for i in inputs}
    factors = FACTORS[segment]
    total = sum(f[1] for f in factors.values())
    rows, used, weighted = [], 0.0, 0.0
    for key, (label, weight, full, invert, keys) in factors.items():
        move = _avg(by_key, keys)
        if move is None:
            rows.append({"key": key, "label": label, "move": None, "score": None, "weight": weight})
            continue
        s = _clamp(move / full) * (-1 if invert else 1)
        weighted += weight * s
        used += weight
        rows.append({"key": key, "label": label, "move": round(move, 3), "score": round(s, 3), "weight": weight})
    score = round(weighted / used, 2) if used else 0.0
    return {
        "score": score,
        "bias": "bullish" if score >= BULLISH_AT else "bearish" if score <= BEARISH_AT else "neutral",
        "coverage": round(used / total, 2),
        "gift_gap_pct": None,
        "factors": rows,
    }

"""Open-interest interpretation: buildup classification, PCR, max pain.

Pure functions — no I/O. Inputs come from two `market-data` option-chain
snapshots (previous vs current); `market_data_client.py` is responsible for
fetching and diffing them into the shapes these functions expect.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

BuildupType = Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]


def classify_buildup(price_change: float, oi_change: float, flat_band: float = 0.0) -> BuildupType | None:
    """The standard four-quadrant OI read used across NSE F&O commentary:

        price up   + OI up   -> long_buildup    (fresh longs being added)
        price up   + OI down -> short_covering   (shorts exiting into strength)
        price down + OI up   -> short_buildup    (fresh shorts being added)
        price down + OI down -> long_unwinding   (longs exiting into weakness)

    Returns None when either input is exactly flat (no signal), so callers
    don't have to guess what a 0/0 classification means.
    """
    if price_change == flat_band or oi_change == flat_band:
        return None
    if price_change > 0 and oi_change > 0:
        return "long_buildup"
    if price_change > 0 and oi_change < 0:
        return "short_covering"
    if price_change < 0 and oi_change > 0:
        return "short_buildup"
    return "long_unwinding"


@dataclass
class StrikeOIRow:
    strike: float
    option_type: Literal["CE", "PE"]
    oi: float
    oi_change: float
    underlying_price_change: float

    @property
    def buildup(self) -> BuildupType | None:
        return classify_buildup(self.underlying_price_change, self.oi_change)


def aggregate_signal(rows: list[StrikeOIRow], near_the_money_only: bool = True, spot: float | None = None, band_pct: float = 0.05) -> BuildupType | None:
    """Weighted-by-|oi_change| majority vote across strikes, optionally
    restricted to strikes within `band_pct` of spot (near-the-money OI is
    generally more informative than far-dated wings for a weekly bias read).
    """
    candidates = rows
    if near_the_money_only and spot:
        candidates = [r for r in rows if abs(r.strike - spot) / spot <= band_pct]
    weights: dict[BuildupType, float] = {}
    for r in candidates:
        b = r.buildup
        if b is None:
            continue
        weights[b] = weights.get(b, 0.0) + abs(r.oi_change)
    if not weights:
        return None
    # If no single classification has a clear plurality (>50% of weighted votes), call it mixed.
    total = sum(weights.values())
    best_type, best_weight = max(weights.items(), key=lambda kv: kv[1])
    if best_weight / total < 0.5:
        return None  # caller should surface this as "mixed" per the contract enum
    return best_type


def put_call_ratio(total_put_oi: float, total_call_oi: float) -> float | None:
    if total_call_oi <= 0:
        return None
    return round(total_put_oi / total_call_oi, 3)


def max_pain(call_oi_by_strike: dict[float, float], put_oi_by_strike: dict[float, float]) -> float | None:
    """Strike at which aggregate option-writer payout is minimized, i.e.
    the classic "max pain" level. O(n^2) over strikes — fine for a single
    weekly chain (~40-80 strikes), not meant for high-frequency use.
    """
    strikes = sorted(set(call_oi_by_strike) | set(put_oi_by_strike))
    if not strikes:
        return None
    best_strike, best_loss = None, None
    for candidate in strikes:
        loss = 0.0
        for k, oi in call_oi_by_strike.items():
            if candidate > k:
                loss += (candidate - k) * oi
        for k, oi in put_oi_by_strike.items():
            if candidate < k:
                loss += (k - candidate) * oi
        if best_loss is None or loss < best_loss:
            best_strike, best_loss = candidate, loss
    return best_strike

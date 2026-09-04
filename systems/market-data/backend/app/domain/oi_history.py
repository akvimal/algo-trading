"""In-memory rolling OI / option-premium / underlying-spot time series
backing GET /options/oi-summary's 5m/15m change figures and the buildup
classification (see app/domain/oi_summary.py).

Provider-neutral - a provider holds one OiHistoryTracker and feeds it a
freshly-fetched OptionChain; the oi-summary route then asks it for each
leg's change. This is the same logic DhanProvider grew inline first
(app/providers/dhan.py's _record_oi_history / get_oi_changes family);
extracted here so the CRYPTO path (DeltaProvider) reuses it rather than
adding a third hand-rolled copy - the aggregation half
(app/domain/oi_summary.py) was already provider-neutral, this closes the
same gap on the history-tracking half.

Deliberately NOT persisted - market-data holds no DB by design (in-memory
cache only, see its README); this resets on every restart, so the change
figures read `null` for the first ~5-15 minutes after a restart, same
tradeoff every other cache in this system already accepts.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from app.domain.models import OptionChain

# How long a sample is kept before pruning - comfortably past the 15m
# window get_*_changes anchors against, with slack for a slow poll cadence.
RETENTION_SECONDS = 20 * 60


def _anchor(samples: list[tuple[float, float]], minutes: float, now: float) -> Optional[float]:
    """The value of the newest sample recorded at or before `minutes`
    ago - None if none is old enough yet. `samples` is oldest-first, so
    the last one whose timestamp is <= the target wins."""
    target = now - minutes * 60
    found: Optional[float] = None
    for ts, value in samples:
        if ts <= target:
            found = value
        else:
            break
    return found


class OiHistoryTracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # (symbol, expiry, strike, option_type) -> [(unix ts, oi), ...] oldest first
        self._oi: dict[tuple[str, str, float, str], list[tuple[float, float]]] = {}
        # same key -> [(unix ts, last_price), ...] - premium, for the
        # per-leg buildup read (needs a price direction alongside OI).
        self._price: dict[tuple[str, str, float, str], list[tuple[float, float]]] = {}
        # symbol -> [(unix ts, spot), ...] - the underlying's own spot
        # price, keyed by symbol ALONE: one series per underlying
        # regardless of which expiry's chain was fetched. Backs the
        # chain-wide (TOTAL call/put OI) buildup, which has no single
        # per-leg premium to compare against.
        self._spot: dict[str, list[tuple[float, float]]] = {}

    def record_chain(self, symbol: str, expiry: str, chain: OptionChain) -> None:
        """One OI + premium sample per leg from a freshly-fetched `chain`.
        Call only on a real provider fetch, not a cache-hit return - OI
        can't have moved between two responses served from the same cached
        fetch (the caller decides what counts as "real", since the cache
        lives on the provider)."""
        now = time.time()
        cutoff = now - RETENTION_SECONDS
        with self._lock:
            for row in chain.strikes:
                for leg, option_type in ((row.ce, "CE"), (row.pe, "PE")):
                    if leg is None:
                        continue
                    key = (symbol, expiry, row.strike, option_type)
                    for store, value in ((self._oi, float(leg.oi)), (self._price, float(leg.last_price))):
                        samples = store.setdefault(key, [])
                        samples.append((now, value))
                        while samples and samples[0][0] < cutoff:
                            samples.pop(0)

    def record_spot(self, symbol: str, spot: float) -> None:
        """Spot-price sibling of record_chain - same real-fetch-only call
        site, same retention/pruning, keyed by symbol alone."""
        now = time.time()
        cutoff = now - RETENTION_SECONDS
        with self._lock:
            samples = self._spot.setdefault(symbol, [])
            samples.append((now, float(spot)))
            while samples and samples[0][0] < cutoff:
                samples.pop(0)

    def oi_changes(
        self, symbol: str, expiry: str, strike: float, option_type: str, current_oi: int
    ) -> tuple[Optional[int], Optional[int]]:
        """(change_5m, change_15m) for one leg's OI - `current_oi` minus
        the sample closest to (but not after) that many minutes ago. None
        for a window with no sample old enough yet. `current_oi` is passed
        in rather than read from the buffer so the diff is always against
        whatever chain the caller has in hand."""
        with self._lock:
            samples = list(self._oi.get((symbol, expiry, strike, option_type), []))
        now = time.time()
        a5 = _anchor(samples, 5, now)
        a15 = _anchor(samples, 15, now)
        return (
            int(current_oi - a5) if a5 is not None else None,
            int(current_oi - a15) if a15 is not None else None,
        )

    def price_changes(
        self, symbol: str, expiry: str, strike: float, option_type: str, current_price: float
    ) -> tuple[Optional[float], Optional[float]]:
        """(change_5m, change_15m) for one leg's premium - price sibling
        of oi_changes, same anchor logic."""
        with self._lock:
            samples = list(self._price.get((symbol, expiry, strike, option_type), []))
        now = time.time()
        a5 = _anchor(samples, 5, now)
        a15 = _anchor(samples, 15, now)
        return (
            current_price - a5 if a5 is not None else None,
            current_price - a15 if a15 is not None else None,
        )

    def spot_price_changes(self, symbol: str, current_spot: float) -> tuple[Optional[float], Optional[float]]:
        """(change_5m, change_15m) for the underlying's own spot price -
        same anchor logic as oi_changes/price_changes."""
        with self._lock:
            samples = list(self._spot.get(symbol, []))
        now = time.time()
        a5 = _anchor(samples, 5, now)
        a15 = _anchor(samples, 15, now)
        return (
            current_spot - a5 if a5 is not None else None,
            current_spot - a15 if a15 is not None else None,
        )

"""Interval parsing + local candle aggregation - provider-agnostic, pure
functions extracted out of app/providers/dhan.py (originally Dhan-only)
once app/providers/delta.py needed the exact same logic (Delta's own
native resolution set doesn't include every interval this platform's
Strategy.interval vocabulary allows either, same situation Dhan was
already in). Each provider still owns its OWN native-interval dict
(passed in, not hardcoded here) - only the "Nmin" parsing and the
clock-aligned bucketing algorithm itself are shared."""

import re
from datetime import datetime

from app.domain.models import Candle


def resolve_interval_minutes(interval: str, native_intervals: dict[str, int]) -> int:
    """Resolves any interval string to its length in minutes - one of the
    caller's own native granularities (dict lookup) or a general "Nmin"
    shape for local aggregation (see aggregate_candles). Raises
    ValueError for anything else (e.g. "daily", which the intraday
    endpoints these providers use don't serve at all)."""
    if interval in native_intervals:
        return native_intervals[interval]
    match = re.fullmatch(r"(\d+)min", interval)
    if not match or int(match.group(1)) <= 0:
        raise ValueError(
            f"unsupported candle interval '{interval}' - must be one of "
            f"{list(native_intervals)} (native) or any 'Nmin' shape (locally aggregated from 1min bars)"
        )
    return int(match.group(1))


def aggregate_candles(one_min_candles: list[Candle], interval: str, minutes: int) -> list[Candle]:
    """Buckets native, already-completed 1-minute candles into `minutes`-
    wide bars, aligned to clock-time multiples of `minutes` since
    midnight - matching Dhan's own observed alignment for native
    intervals (e.g. real 5min bars land on :00/:05/:10, never :02/:07),
    reused as the same alignment convention for every provider. Only
    emits a bucket once it holds a full complement of `minutes` one-
    minute bars; a short bucket (session open not aligned to N, or the
    tail end still forming) is dropped rather than emitted early -
    extending each provider's own "completed bars only" rule at the
    1-minute level up to the aggregate level. `one_min_candles` must be
    oldest-first so the returned list is too."""
    buckets: dict[datetime, list[Candle]] = {}
    order: list[datetime] = []
    for candle in one_min_candles:
        ts = datetime.fromisoformat(candle.timestamp)
        bucket_start_minutes = ((ts.hour * 60 + ts.minute) // minutes) * minutes
        bucket_start = ts.replace(hour=bucket_start_minutes // 60, minute=bucket_start_minutes % 60, second=0, microsecond=0)
        if bucket_start not in buckets:
            buckets[bucket_start] = []
            order.append(bucket_start)
        buckets[bucket_start].append(candle)

    result = []
    for bucket_start in order:
        members = buckets[bucket_start]
        if len(members) != minutes:
            continue
        result.append(
            Candle(
                exchange=members[0].exchange,
                symbol=members[0].symbol,
                interval=interval,
                open=members[0].open,
                high=max(c.high for c in members),
                low=min(c.low for c in members),
                close=members[-1].close,
                timestamp=bucket_start.isoformat(),
                provider=members[0].provider,
            )
        )
    return result

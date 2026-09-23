"""Pure aggregation for the OI-buildup EOD screener (GET /oi-buildup) -
turns one NSE F&O stock's freshly-fetched option chain plus its own
PREVIOUS market_data.oi_eod_snapshot row into today's row fields. Kept
separate from app/scheduler.py's _record_oi_eod_snapshot (which does the
actual Dhan fetch + DB read/write) so this is unit-testable without a live
provider/DB session - same "pure core, thin job" split app/domain/
oi_summary.py already uses for the live (not EOD) OI summary.

Deliberately day-over-day only (this snapshot vs. the single most recent
earlier one for this symbol), not a 5m/15m window like oi_summary.py's own
_classify_buildup callers - there is no faster cadence here, this table is
written once per trading day.
"""

from dataclasses import dataclass
from typing import Optional

from app.domain.oi_summary import Buildup, _classify_buildup


def _pct_change(current: float, previous: float) -> Optional[float]:
    """None (not a guess) when previous is 0 - division undefined, same
    convention build_oi_summary's own `pcr` field uses for a 0 denominator."""
    return ((current - previous) / previous * 100) if previous else None


@dataclass
class PreviousSnapshot:
    """The one prior field this module needs from yesterday's (or
    whenever-earlier's) oi_eod_snapshot row - deliberately not the full
    ORM row, so this stays a plain dataclass the job can build from either
    a real query result or a test fixture."""

    total_call_oi: int
    total_put_oi: int
    spot_price: Optional[float]


@dataclass
class EodBuildupResult:
    call_oi_change_pct: Optional[float]
    put_oi_change_pct: Optional[float]
    price_change_pct: Optional[float]
    call_buildup: Optional[Buildup]
    put_buildup: Optional[Buildup]


def compute_eod_buildup(
    total_call_oi: int,
    total_put_oi: int,
    spot_price: Optional[float],
    previous: Optional[PreviousSnapshot],
) -> EodBuildupResult:
    """`previous` is None on a symbol's very first snapshot day (or if an
    earlier day's fetch failed and was skipped entirely, see the job's own
    per-symbol try/except) - every field comes back None in that case,
    same "nothing to classify yet" convention _classify_buildup already
    uses for a missing/zero change.

    Buildup classification uses the RAW oi/price diffs (not the pct
    figures also computed here) since _classify_buildup only reads their
    sign - a raw diff and its pct form always agree in sign, but computing
    it directly avoids a spurious None from _pct_change's own zero-
    denominator guard when e.g. yesterday's total_call_oi was legitimately
    0 (a symbol with no call OI at all yet) while the raw diff is still a
    perfectly good non-zero, classifiable number."""
    if previous is None:
        return EodBuildupResult(None, None, None, None, None)

    call_oi_diff = total_call_oi - previous.total_call_oi
    put_oi_diff = total_put_oi - previous.total_put_oi
    price_diff = (spot_price - previous.spot_price) if (spot_price is not None and previous.spot_price is not None) else None

    return EodBuildupResult(
        call_oi_change_pct=_pct_change(total_call_oi, previous.total_call_oi),
        put_oi_change_pct=_pct_change(total_put_oi, previous.total_put_oi),
        price_change_pct=(
            _pct_change(spot_price, previous.spot_price) if (spot_price is not None and previous.spot_price is not None) else None
        ),
        call_buildup=_classify_buildup(call_oi_diff, price_diff),
        put_buildup=_classify_buildup(put_oi_diff, price_diff),
    )

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
from typing import Literal, Optional

from app.domain.models import OptionChain
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


# ---- who moved the open interest: read from the option's own premium -------------------------------------------------------------------------------
#
# Open interest up has a buyer and a seller. The option's premium says which one pushed: premium up = buying, premium down = writing. The buildup
# labels above use the UNDERLYING's price as a stand-in (right for a call, backwards-looking for a put, whose premium falls as the stock rises); this
# is the measured version, from Dhan's per-leg previous close.

Activity = Literal["buying", "writing", "writers_covering", "unwinding"]
PREMIUM_STRIKES_EACH_SIDE = 7  # near the money, where the premium is a real price and the open interest is where the activity is
MIN_PREVIOUS_PREMIUM = 1.0  # a leg that closed under a rupee moves hundreds of percent on a tick: left out


def weighted_premium_change_pct(chain: OptionChain, side: Literal["ce", "pe"], each_side: int = PREMIUM_STRIKES_EACH_SIDE) -> Optional[float]:
    """How much the near-the-money `side` premiums moved since the previous close, as one figure: the total premium value (open interest x price) now
    against the same open interest at the previous close, so a deep leg with large open interest counts for more than a thin one. None when no leg
    has a usable previous close."""
    strikes = sorted(chain.strikes, key=lambda s: s.strike)
    if not strikes:
        return None
    atm = min(range(len(strikes)), key=lambda i: abs(strikes[i].strike - chain.underlying_last_price))
    now_value = 0.0
    before_value = 0.0
    for row in strikes[max(0, atm - each_side) : atm + each_side + 1]:
        leg = row.ce if side == "ce" else row.pe
        if leg is None or leg.oi <= 0 or leg.previous_close_price is None or leg.previous_close_price < MIN_PREVIOUS_PREMIUM:
            continue
        now_value += leg.oi * leg.last_price
        before_value += leg.oi * leg.previous_close_price
    return ((now_value - before_value) / before_value * 100) if before_value > 0 else None


def classify_activity(oi_change: Optional[float], premium_change_pct: Optional[float]) -> Optional[Activity]:
    """OI up + premium up = buying; OI up + premium down = writing; OI down + premium up = writers covering (they bought back at a loss); OI down +
    premium down = unwinding (buyers sold out). None when either is unknown or exactly flat."""
    if not oi_change or not premium_change_pct:
        return None
    if oi_change > 0:
        return "buying" if premium_change_pct > 0 else "writing"
    return "writers_covering" if premium_change_pct > 0 else "unwinding"


@dataclass
class EodActivityResult:
    call_premium_change_pct: Optional[float]
    put_premium_change_pct: Optional[float]
    call_activity: Optional[Activity]
    put_activity: Optional[Activity]


def compute_eod_activity(chain: OptionChain, total_call_oi: int, total_put_oi: int, previous: Optional[PreviousSnapshot]) -> EodActivityResult:
    """Today's premium change from the chain itself, and what it says about the day's open-interest change on each side. The activity needs yesterday's
    totals to know which way the open interest moved; the premium change does not."""
    call_pct = weighted_premium_change_pct(chain, "ce")
    put_pct = weighted_premium_change_pct(chain, "pe")
    call_diff = (total_call_oi - previous.total_call_oi) if previous is not None else None
    put_diff = (total_put_oi - previous.total_put_oi) if previous is not None else None
    return EodActivityResult(call_pct, put_pct, classify_activity(call_diff, call_pct), classify_activity(put_diff, put_pct))

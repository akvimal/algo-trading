"""Bullish/bearish sentiment for NSE and MCX, aggregated from options
OI-change totals (see app/domain/oi_summary.py) across a fixed watchlist of
underlyings - the same 4 symbols the OI Summary page already tracks (see
manual-trading's OiSummaryPage.tsx: NIFTY/BANKNIFTY for NSE, GOLDM/CRUDEOILM
for MCX), not a literal scan of every F&O symbol. Feeds the shell header's
sentiment badges (shell/index.html), which poll GET /options/sentiment every
5 minutes - a deliberately slow cadence, same Dhan rate-limit caution as
app/scheduler.py's token renewal (see docs/architecture.md / CLAUDE.md's
Dhan rate-limit notes) since every poll is a real option-chain call per
watchlist symbol.

Pure functions only (no Dhan/network dependency) - the caller
(app/api/routes/options.py) does the actual chain fetches and passes in
whatever OptionOiSummary it got (or None on a per-underlying fetch failure).
"""

from datetime import date, datetime, time as dt_time, tzinfo
from typing import Optional

from app.domain.models import ExchangeSentiment, OptionOiSummary, SentimentDirection, SentimentStrength, UnderlyingSentiment

SENTIMENT_UNDERLYINGS: dict[str, list[str]] = {
    "NSE": ["NIFTY", "BANKNIFTY"],
    "MCX": ["GOLDM", "CRUDEOILM"],
}

# Approximate real trading-session bounds per exchange, local time
# (settings.timezone, Asia/Kolkata) - used to stop app/scheduler.py's
# _record_sentiment_history from writing history rows (mostly error/stale-
# price noise, since the option chain isn't live outside session) while a
# segment's market is actually closed, and to bound
# SentimentHistoryChart.tsx's own x-axis to a consistent, comparable
# window day over day. Weekday/holiday-agnostic - no trading-calendar
# concept exists anywhere in this codebase, so a weekend/holiday still
# reads "in session" by clock time alone; any real fetch attempted then
# just degrades to an error row the same way an unexpected market closure
# during session hours already does (see score_underlying). MCX's real
# session varies by commodity (agri contracts often close ~17:00, others
# ~23:30) - this is one conservative window covering every
# SENTIMENT_UNDERLYINGS MCX symbol, not a precise per-contract one.
SEGMENT_SESSION_HOURS: dict[str, tuple[dt_time, dt_time]] = {
    "NSE": (dt_time(9, 15), dt_time(15, 30)),
    "MCX": (dt_time(9, 0), dt_time(23, 30)),
}
# CRYPTO deliberately absent - trades 24/7, same "no cutoff" treatment
# execution.accounts.square_off_time=NULL already gives it elsewhere.


def is_within_session(exchange: str, now: datetime) -> bool:
    """True if `now` (already converted to the exchange's local trading
    timezone by the caller) falls within that exchange's SEGMENT_SESSION_
    HOURS window. An exchange with no configured window (CRYPTO) is always
    in session."""
    hours = SEGMENT_SESSION_HOURS.get(exchange)
    if hours is None:
        return True
    start, end = hours
    return start <= now.time() <= end


def exchange_for_symbol(symbol: str) -> Optional[str]:
    """Reverse lookup into SENTIMENT_UNDERLYINGS - which exchange a
    sentiment-watchlist symbol belongs to, for GET /options/sentiment-
    history (which only receives `symbol`, not `exchange`, from the
    caller). None for a symbol outside the fixed watchlist."""
    for exchange, symbols in SENTIMENT_UNDERLYINGS.items():
        if symbol in symbols:
            return exchange
    return None


def session_bounds(exchange: str, day: date, tz: tzinfo) -> tuple[datetime, datetime]:
    """This exchange's SEGMENT_SESSION_HOURS window resolved to actual
    datetimes for one calendar `day` in timezone `tz` - the single
    definition both the scheduled recorder (is_within_session) and GET
    /options/sentiment-history (for SentimentHistoryChart.tsx's x-axis)
    anchor to, so they can never drift apart. An exchange with no
    configured window spans the whole day, matching is_within_session's
    own "always in session" default."""
    hours = SEGMENT_SESSION_HOURS.get(exchange)
    start_t, end_t = hours if hours is not None else (dt_time.min, dt_time.max)
    return datetime.combine(day, start_t, tzinfo=tz), datetime.combine(day, end_t, tzinfo=tz)

# Percent-of-total-OI put-minus-call shift, 15m window. Not derived from
# anything - a reasonable starting bucket, tune freely.
_MILD = 0.5
_STRONG = 1.5
_VERY_STRONG = 3.0


def _bucket(score: Optional[float]) -> tuple[SentimentDirection, Optional[SentimentStrength]]:
    if score is None or abs(score) < _MILD:
        return "neutral", None
    direction: SentimentDirection = "bullish" if score > 0 else "bearish"
    magnitude = abs(score)
    if magnitude >= _VERY_STRONG:
        return direction, "very_strong"
    if magnitude >= _STRONG:
        return direction, "strong"
    return direction, "mild"


def _classify(score_5m: Optional[float], score_15m: Optional[float]) -> tuple[SentimentDirection, Optional[SentimentStrength], Optional[float]]:
    """15m is the primary read (steadier than 5m for something meant to
    hold rather than flicker every poll tick, same reasoning as
    oi_summary.py's _classify_buildup); falls back to 5m only if 15m has
    no data yet. 5m never flips the direction on its own - it only
    sharpens or dulls the 15m-driven strength: agreeing bumps it up a
    notch, conflicting caps it at mild (weak conviction)."""
    primary = score_15m if score_15m is not None else score_5m
    direction, strength = _bucket(primary)

    if strength is not None and score_5m is not None and score_15m is not None:
        agrees = (score_5m > 0) == (score_15m > 0)
        if agrees:
            if strength == "mild":
                strength = "strong"
            elif strength == "strong":
                strength = "very_strong"
        else:
            strength = "mild"

    return direction, strength, primary


def _pct_shift(summary: OptionOiSummary, call_chg: Optional[int], put_chg: Optional[int]) -> Optional[float]:
    """Put-OI-change minus call-OI-change, as a percent of total OI at
    this snapshot: put OI growing faster than call OI reads bullish (put
    writers confident price holds above their strike), the reverse reads
    bearish - chain-wide version of the single-leg convention
    oi_summary.py's _classify_buildup already uses."""
    total_oi = summary.total_call_oi + summary.total_put_oi
    if total_oi == 0 or call_chg is None or put_chg is None:
        return None
    return (put_chg - call_chg) / total_oi * 100


def score_underlying(symbol: str, summary: Optional[OptionOiSummary], error: Optional[str] = None) -> UnderlyingSentiment:
    if summary is None:
        return UnderlyingSentiment(symbol=symbol, direction="neutral", error=error or "no data")

    score_5m = _pct_shift(summary, summary.total_call_oi_change_5m, summary.total_put_oi_change_5m)
    score_15m = _pct_shift(summary, summary.total_call_oi_change_15m, summary.total_put_oi_change_15m)
    direction, strength, _ = _classify(score_5m, score_15m)
    return UnderlyingSentiment(symbol=symbol, score_5m=score_5m, score_15m=score_15m, direction=direction, strength=strength)


def aggregate_exchange(underlyings: list[UnderlyingSentiment]) -> ExchangeSentiment:
    """Mean of the watchlist underlyings' own 5m/15m scores (skipping any
    with no data), then classified the same way a single underlying is -
    so a whole exchange never reads "very strong" off of one noisy symbol
    while its other watchlist members disagree."""
    fives = [u.score_5m for u in underlyings if u.score_5m is not None]
    fifteens = [u.score_15m for u in underlyings if u.score_15m is not None]
    avg_5m = sum(fives) / len(fives) if fives else None
    avg_15m = sum(fifteens) / len(fifteens) if fifteens else None
    direction, strength, combined = _classify(avg_5m, avg_15m)
    return ExchangeSentiment(direction=direction, strength=strength, score=combined, underlyings=underlyings)

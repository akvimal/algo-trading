"""Orchestrates one symbol's weekly options recommendation: OHLCV ->
TechnicalSnapshot -> (best-effort) OI/strike-interval/fundamentals -> regime
-> strategy.

Deliberately out of scope for this pass, same as stated to the user before
building it: no AI memo (ai_memo stays None - the AI usage this module does
have, screener_fetch.py's fundamentals read, is a structured vote input,
not free-text commentary), no scheduler, no Redis publish. This is an
on-demand read - GET /weekly-advisor/recommendations calls run_symbol()
fresh every request; screener_fetch.py is the one exception to "no DB
persistence" (its own long-lived fundamentals cache, see that module).

Real strike interval, when available: market-data's GET /options/chain
returns the actual strike ladder for the nearest expiry (OptionChain.strikes,
sorted ascending) - the gap between its first two entries IS the exchange's
real strike interval, not a guess. Only falls back to a price-scaled guess
(same one the scratchpad prototype used) when the chain is unavailable,
e.g. the dev Dhan token being expired at the time this was built.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional

from app.adapters.market_data import client as market_data_client

from . import indicators as ind
from . import oi_classifier
from . import regime_engine as regime
from . import screener_fetch
from . import strategy_selector as strat
from .contracts import (
    FundamentalSnapshot,
    GeneratedBy,
    OISnapshot,
    StrikeOI,
    TechnicalSnapshot,
    TrendChannel,
    WeeklyRecommendation,
    Zone,
)
from .oi_classifier import StrikeOIRow
from .regime_engine import OrderBlockZone

ENGINE_VERSION = "weekly_advisor@signal-engine-1.0"
EXCHANGE = "NSE"


def build_technical_snapshot(bars, timeframe: str) -> TechnicalSnapshot:
    closes = [b.close for b in bars]
    highs = [b.high for b in bars]
    lows = [b.low for b in bars]
    vols = [b.volume for b in bars]

    e20 = ind.ema(closes, 20)
    e50 = ind.ema(closes, 50)
    a14 = ind.atr(highs, lows, closes, 14)
    adx_res = ind.adx(highs, lows, closes, 14)
    vsma20 = ind.sma(vols, 20)
    channel = ind.regression_channel(closes, lookback=min(60, len(closes)))

    support_zones = ind.cluster_zones(ind.swing_pivots(lows, kind="low"), basis_prefix="support pivot")
    resistance_zones = ind.cluster_zones(ind.swing_pivots(highs, kind="high"), basis_prefix="resistance pivot")

    return TechnicalSnapshot(
        timeframe=timeframe, close=closes[-1], ema20=e20[-1], ema50=e50[-1],
        adx14=adx_res.adx[-1], adx14_slope=ind.adx_slope(adx_res.adx), atr14=a14[-1],
        trend_channel=TrendChannel(upper=channel.upper, mid=channel.mid, lower=channel.lower, slope_per_bar=channel.slope_per_bar),
        support_zones=[Zone(low=z.low, high=z.high, basis=z.basis) for z in support_zones],
        resistance_zones=[Zone(low=z.low, high=z.high, basis=z.basis) for z in resistance_zones],
        volume=vols[-1], volume_sma20=vsma20[-1], volume_confirmed=ind.volume_confirmed(vols[-1], vsma20[-1]),
    )


def _guess_strike_interval(close: float) -> float:
    """Fallback only - used when market-data has no live option chain to
    read the real strike ladder from (see module docstring)."""
    if close < 500:
        return 5.0
    if close < 1000:
        return 10.0
    if close < 2000:
        return 20.0
    if close < 5000:
        return 50.0
    return 100.0


# market-data's Dhan option-chain/expiry-list calls self-throttle to 1
# request per 3s (MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS in that service's
# providers/dhan.py - get_expiry_list and get_option_chain share the same
# throttle clock/queue), shared across EVERY concurrent caller using the
# platform-default credential - which every Weekly Advisor batch request
# is, since it's an internal job with no per-user context.
# weekly_advisor.py's own _BATCH_CONCURRENCY (5) fires that many symbols'
# expiry+chain fetches at once, but that throttle's own queue-depth guard
# (MAX_THROTTLE_WAIT_SECONDS, 4s) raises rather than queuing a caller more
# than ~1 slot deep - so without a retry here, only the first ~1-2 of 5
# concurrent symbols ever get a real chain, and with a cold expiry-list
# cache (e.g. right after a restart) each symbol needs up to 2 slots
# (expiry list + chain), doubling the effective queue depth. The rest
# silently degrade to a guessed expiry AND lose the OI vote, non-
# deterministically depending on thread scheduling (confirmed live
# 2026-09-16: the same 5-symbol batch produced different available/
# unavailable OI results run to run, and a first attempt at only retrying
# the chain call - not expiry-list too - still left 2/5 symbols failing
# after a cold restart). Retrying the WHOLE expiry+chain sequence, a fixed
# 3s apart (matching the throttle's own interval), lets a later-queued
# symbol simply wait its fair turn instead of giving up - retrying
# get_expiry_list too is cheap even when it already succeeded, since its
# own 300s cache (EXPIRY_LIST_CACHE_TTL_SECONDS) makes every retry after
# the first free. Total worst-case patience here (9 retries x 3s = 27s)
# comfortably drains a 5-wide burst even at 2 slots/symbol; a weekly
# recommendation isn't a latency-sensitive path the way live quote/order
# calls are.
_OPTION_CHAIN_RETRY_ATTEMPTS = 10
_OPTION_CHAIN_RETRY_SLEEP_SECONDS = 3.0


def _fetch_expiry_and_chain_with_retry(symbol: str) -> tuple[Optional[str], Optional[dict]]:
    last_exc: Optional[Exception] = None
    for attempt in range(_OPTION_CHAIN_RETRY_ATTEMPTS):
        try:
            expiries = market_data_client.get_expiry_list(EXCHANGE, symbol)
            if not expiries:
                return None, None
            chain = market_data_client.get_option_chain(EXCHANGE, symbol, expiries[0])
            return expiries[0], chain
        except Exception as exc:
            last_exc = exc
            if attempt < _OPTION_CHAIN_RETRY_ATTEMPTS - 1:
                time.sleep(_OPTION_CHAIN_RETRY_SLEEP_SECONDS)
    raise last_exc  # noqa: TRY201 - re-raised as-is so the caller's own except Exception still degrades gracefully


def _resolve_expiry_strike_interval_and_chain(symbol: str, weekly_close: float) -> tuple[Optional[str], float, Optional[list[dict]]]:
    """Best-effort: real nearest expiry + real strike interval from
    market-data's option chain when it's reachable, else a placeholder
    expiry (None, caller falls back to a naive monthly-Thursday guess) and
    a price-scaled strike-interval guess. Never raises - a broker-token
    outage here shouldn't take down the whole recommendation (the fetch
    itself retries first - see _fetch_expiry_and_chain_with_retry).

    Also hands back the chain's own `strikes` list (raw dicts, same shape
    market-data's GET /options/chain returns) so _fetch_oi below can build
    a real OI read off the SAME fetch, rather than a second call to
    market-data for the same chain - None whenever a chain wasn't fetched
    or didn't resolve (unresolvable underlying, no expiry, broker outage)."""
    try:
        expiry, chain = _fetch_expiry_and_chain_with_retry(symbol)
        if expiry is None:
            return None, _guess_strike_interval(weekly_close), None
        if not chain or len(chain.get("strikes", [])) < 2:
            return expiry, _guess_strike_interval(weekly_close), None
        chain_strikes = chain["strikes"]
        strikes = sorted(s["strike"] for s in chain_strikes)
        interval = round(strikes[1] - strikes[0], 2)
        return expiry, (interval if interval > 0 else _guess_strike_interval(weekly_close)), chain_strikes
    except Exception:
        return None, _guess_strike_interval(weekly_close), None


def _fetch_oi(chain_strikes: Optional[list[dict]], price_change: float, spot: float) -> OISnapshot:
    """Builds a real OI buildup read from the SAME option-chain fetch
    _resolve_expiry_strike_interval_and_chain already made for the strike
    ladder. Needs no separate persistence/diffing pass - Dhan's own
    `previous_oi` figure per leg (see OptionLegQuote's docstring in
    market-data's app/domain/models.py; it's the exchange's own previous-
    session OI, not something market-data computes) means one chain fetch
    already carries everything oi_classifier.classify_buildup needs
    (current OI vs prior, and the underlying's own price change since
    then). `price_change` is the underlying's own (not per-strike) latest-
    vs-previous daily close, same convention classify_buildup expects -
    only its sign matters. available=False (never raises) whenever the
    chain wasn't reachable or carries no CE/PE OI at all - same graceful-
    degradation convention _fetch_fundamentals/_fetch_order_blocks already
    use elsewhere in this module."""
    if not chain_strikes:
        return OISnapshot(available=False)
    try:
        rows: list[StrikeOIRow] = []
        call_oi_by_strike: dict[float, float] = {}
        put_oi_by_strike: dict[float, float] = {}
        total_call_oi = 0.0
        total_put_oi = 0.0
        for s in chain_strikes:
            strike = s["strike"]
            for option_type, leg_key in (("CE", "ce"), ("PE", "pe")):
                leg = s.get(leg_key)
                if not leg or leg.get("oi") is None or leg.get("previous_oi") is None:
                    continue
                oi = float(leg["oi"])
                oi_change = oi - float(leg["previous_oi"])
                rows.append(StrikeOIRow(strike=strike, option_type=option_type, oi=oi, oi_change=oi_change, underlying_price_change=price_change))
                if option_type == "CE":
                    call_oi_by_strike[strike] = oi
                    total_call_oi += oi
                else:
                    put_oi_by_strike[strike] = oi
                    total_put_oi += oi

        if not rows:
            return OISnapshot(available=False)

        return OISnapshot(
            available=True,
            pcr=oi_classifier.put_call_ratio(total_put_oi, total_call_oi),
            max_pain=oi_classifier.max_pain(call_oi_by_strike, put_oi_by_strike),
            aggregate_signal=oi_classifier.aggregate_signal(rows, near_the_money_only=True, spot=spot),
            by_strike=[
                StrikeOI(strike=r.strike, option_type=r.option_type, oi=r.oi, oi_change=r.oi_change, buildup=r.buildup)
                for r in rows
                if r.buildup is not None  # StrikeOI.buildup is required - a flat/no-signal row is simply omitted
            ],
        )
    except Exception:
        return OISnapshot(available=False)


@dataclass
class _LegMarketData:
    premium: float
    # Dhan's own per-contract ID for this exact leg, when the chain dict
    # carried one - not every caller of this pipeline's own chain fetch
    # populates it (see market-data's OptionLegQuote.security_id), so this
    # stays optional rather than widening _fetch_oi's own required fields.
    security_id: Optional[str] = None


def _leg_market_data(chain_strikes: Optional[list[dict]]) -> dict[tuple[float, str], _LegMarketData]:
    """(strike, option_type) -> last_price + security_id, from the SAME
    option-chain fetch _fetch_oi already reads oi/previous_oi off of - a
    couple more fields off a dict this pipeline already has in hand, not a
    second chain call. Rounded to 2dp on the key so a strike that's gone
    through strategy_selector.round_to_strike's own floating-point
    arithmetic still finds its match. Backs StrategyLeg.premium_estimate/
    security_id (see those fields' own docstrings) - never raises, an
    unparseable leg is just skipped, same graceful-degradation convention
    as _fetch_oi itself."""
    data: dict[tuple[float, str], _LegMarketData] = {}
    if not chain_strikes:
        return data
    for s in chain_strikes:
        try:
            strike = round(float(s["strike"]), 2)
        except (KeyError, TypeError, ValueError):
            continue
        for option_type, leg_key in (("CE", "ce"), ("PE", "pe")):
            leg = s.get(leg_key)
            if not leg or leg.get("last_price") is None:
                continue
            try:
                premium = float(leg["last_price"])
            except (TypeError, ValueError):
                continue
            security_id = leg.get("security_id")
            data[(strike, option_type)] = _LegMarketData(
                premium=premium, security_id=str(security_id) if security_id is not None else None,
            )
    return data


def _naive_monthly_expiry(as_of: date) -> date:
    """Placeholder only, used when market-data's own expiry list isn't
    reachable - last Thursday of the month, same approach the scaffold's
    own weekly_job.py used."""
    candidate = as_of.replace(day=28) + timedelta(days=4)
    last_day = candidate - timedelta(days=candidate.day)
    while last_day.weekday() != 3:
        last_day -= timedelta(days=1)
    if last_day < as_of:
        candidate = (last_day + timedelta(days=15)).replace(day=28) + timedelta(days=4)
        last_day = candidate - timedelta(days=candidate.day)
        while last_day.weekday() != 3:
            last_day -= timedelta(days=1)
    return last_day


def _fetch_order_blocks(symbol: str, as_of: date, interval: str, lookback_days: int) -> Optional[list[OrderBlockZone]]:
    """Best-effort SMC order blocks at the given `interval` for the bias
    vote (see regime_engine.py's _order_block_vote) - None (not "no vote"
    silently, see assess_regime's own docstring) on any failure, so a
    market-data hiccup here degrades gracefully instead of failing the
    whole recommendation. Same source=yahoo as the OHLCV fetches (order
    blocks work off whatever candles market-data hands back, weekly or
    daily). Called once per timeframe from run_symbol - see its own
    weekly + daily order-block calls, mirroring the weekly/daily OHLCV
    and EMA-vote pattern already used throughout this pipeline."""
    try:
        raw = market_data_client.get_order_blocks(
            EXCHANGE, symbol, interval, as_of - timedelta(days=lookback_days), as_of, source="yahoo",
        )
        if raw is None:
            return None
        return [
            OrderBlockZone(kind=ob["kind"], proximal=ob["proximal"], distal=ob["distal"], mitigated=ob["mitigated"])
            for ob in raw
        ]
    except Exception:
        return None


def _fetch_fundamentals(symbol: str, openrouter_api_key: Optional[str] = None) -> FundamentalSnapshot:
    """Best-effort screener.in read (see screener_fetch.py) - a scrape/AI
    hiccup here degrades to "no fundamental vote this cycle", same
    graceful-degradation convention as _fetch_order_blocks above, rather
    than failing the whole recommendation over an optional input. Can be
    slow on a cache miss (a real headless-browser page load plus a vision-
    model call, not the ~1-3s the rest of a run takes) - see
    weekly_advisor_fundamentals_cache_days in app/config.py.

    `openrouter_api_key`: the requesting user's own BYO key (2026-09-16),
    threaded down from run_symbol's own caller - see screener_fetch.py's
    get_fundamentals."""
    try:
        analysis = screener_fetch.get_fundamentals(symbol, openrouter_api_key)
    except Exception:
        analysis = None
    if analysis is None:
        return FundamentalSnapshot(available=False)
    return FundamentalSnapshot(
        available=True, bias=analysis.bias, confidence=analysis.confidence, summary=analysis.summary,
        pros=analysis.pros, cons=analysis.cons, reasons=analysis.reasons, fetched_at=analysis.fetched_at,
    )


def run_symbol(symbol: str, as_of: Optional[date] = None, openrouter_api_key: Optional[str] = None) -> WeeklyRecommendation:
    """Raises on missing/insufficient OHLCV - the route catches this per
    symbol and skips it rather than failing the whole batch."""
    as_of = as_of or date.today()

    weekly_bars = market_data_client.get_candle_history(
        EXCHANGE, symbol, "weekly", as_of - timedelta(days=3 * 365), as_of, source="yahoo",
    )
    daily_bars = market_data_client.get_candle_history(
        EXCHANGE, symbol, "daily", as_of - timedelta(days=365), as_of, source="yahoo",
    )
    if len(weekly_bars) < 50 or len(daily_bars) < 50:
        raise ValueError(f"{symbol}: insufficient history for a stable weekly read ({len(weekly_bars)}w/{len(daily_bars)}d bars)")

    weekly_snap = build_technical_snapshot(weekly_bars, "weekly")
    daily_snap = build_technical_snapshot(daily_bars, "daily")

    expiry_str, strike_interval, chain_strikes = _resolve_expiry_strike_interval_and_chain(symbol, weekly_snap.close)
    expiry_date = date.fromisoformat(expiry_str) if expiry_str else _naive_monthly_expiry(as_of)
    # Daily close-to-close, not weekly - Dhan's own previous_oi figure this
    # reads against (see _fetch_oi) is the previous SESSION's OI, so the
    # price side of the comparison should match that same cadence.
    daily_price_change = daily_bars[-1].close - daily_bars[-2].close
    oi_snap = _fetch_oi(chain_strikes, daily_price_change, weekly_snap.close)
    order_blocks = _fetch_order_blocks(symbol, as_of, "weekly", 3 * 365)
    daily_order_blocks = _fetch_order_blocks(symbol, as_of, "daily", 365)
    fundamentals = _fetch_fundamentals(symbol, openrouter_api_key)

    assessment = regime.assess_regime(
        primary=weekly_snap, oi=oi_snap, secondary=daily_snap,
        order_blocks=order_blocks, daily_order_blocks=daily_order_blocks,
        fundamental=fundamentals if fundamentals.available else None,
    )
    recommendation = strat.select_strategy(
        regime=assessment, technical=weekly_snap, corporate_event=None,
        expiry_date=expiry_date, as_of=as_of, strike_interval=strike_interval,
        # Same order_blocks/daily_order_blocks/oi_snap already fetched above
        # for the regime vote - now also anchoring strike selection, not
        # just informing the bias (see strategy_selector.py's own docstrings
        # on _unmitigated_block_anchor/_best_oi_strike).
        order_blocks=order_blocks, daily_order_blocks=daily_order_blocks, oi=oi_snap,
    )
    leg_market_data = _leg_market_data(chain_strikes)
    for leg in recommendation.legs:
        data = leg_market_data.get((round(leg.strike, 2), leg.option_type))
        if data is not None:
            leg.premium_estimate = data.premium
            leg.security_id = data.security_id

    return WeeklyRecommendation(
        symbol=symbol,
        as_of=datetime.combine(as_of, datetime.min.time()),
        technical=weekly_snap,
        oi=oi_snap,
        fundamentals=fundamentals,
        corporate_event=None,
        regime=assessment,
        strategy=recommendation,
        ai_memo=None,
        generated_by=GeneratedBy(engine_version=ENGINE_VERSION),
    )

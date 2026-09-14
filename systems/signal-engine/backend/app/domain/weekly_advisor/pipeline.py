"""Orchestrates one symbol's weekly options recommendation: OHLCV ->
TechnicalSnapshot -> (best-effort) OI/strike-interval -> regime -> strategy.

Deliberately out of scope for this pass, same as stated to the user before
building it: no AI memo, no DB persistence, no scheduler, no Redis publish.
This is an on-demand, stateless read - GET /weekly-advisor/recommendations
calls run_symbol() fresh every request.

Real strike interval, when available: market-data's GET /options/chain
returns the actual strike ladder for the nearest expiry (OptionChain.strikes,
sorted ascending) - the gap between its first two entries IS the exchange's
real strike interval, not a guess. Only falls back to a price-scaled guess
(same one the scratchpad prototype used) when the chain is unavailable,
e.g. the dev Dhan token being expired at the time this was built.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from app.adapters.market_data import client as market_data_client

from . import indicators as ind
from . import regime_engine as regime
from . import strategy_selector as strat
from .contracts import (
    GeneratedBy,
    OISnapshot,
    TechnicalSnapshot,
    TrendChannel,
    WeeklyRecommendation,
    Zone,
)
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


def _resolve_expiry_and_strike_interval(symbol: str, weekly_close: float) -> tuple[Optional[str], float]:
    """Best-effort: real nearest expiry + real strike interval from
    market-data's option chain when it's reachable, else a placeholder
    expiry (None, caller falls back to a naive monthly-Thursday guess) and
    a price-scaled strike-interval guess. Never raises - a broker-token
    outage here shouldn't take down the whole recommendation."""
    try:
        expiries = market_data_client.get_expiry_list(EXCHANGE, symbol)
        if not expiries:
            return None, _guess_strike_interval(weekly_close)
        chain = market_data_client.get_option_chain(EXCHANGE, symbol, expiries[0])
        if not chain or len(chain.get("strikes", [])) < 2:
            return expiries[0], _guess_strike_interval(weekly_close)
        strikes = sorted(s["strike"] for s in chain["strikes"])
        interval = round(strikes[1] - strikes[0], 2)
        return expiries[0], (interval if interval > 0 else _guess_strike_interval(weekly_close))
    except Exception:
        return None, _guess_strike_interval(weekly_close)


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


def run_symbol(symbol: str, as_of: Optional[date] = None) -> WeeklyRecommendation:
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

    # OI diffing needs a stored previous chain snapshot, which this
    # persistence-free pass doesn't have - always OI-blind for now, same
    # graceful-degradation path the scaffold's own pipeline takes when OI
    # is missing. Real strike interval is still worth reading from the
    # chain even without a diff.
    oi_snap = OISnapshot(available=False)
    expiry_str, strike_interval = _resolve_expiry_and_strike_interval(symbol, weekly_snap.close)
    expiry_date = date.fromisoformat(expiry_str) if expiry_str else _naive_monthly_expiry(as_of)
    order_blocks = _fetch_order_blocks(symbol, as_of, "weekly", 3 * 365)
    daily_order_blocks = _fetch_order_blocks(symbol, as_of, "daily", 365)

    assessment = regime.assess_regime(
        primary=weekly_snap, oi=oi_snap, secondary=daily_snap,
        order_blocks=order_blocks, daily_order_blocks=daily_order_blocks,
    )
    recommendation = strat.select_strategy(
        regime=assessment, technical=weekly_snap, corporate_event=None,
        expiry_date=expiry_date, as_of=as_of, strike_interval=strike_interval,
    )

    return WeeklyRecommendation(
        symbol=symbol,
        as_of=datetime.combine(as_of, datetime.min.time()),
        technical=weekly_snap,
        oi=oi_snap,
        corporate_event=None,
        regime=assessment,
        strategy=recommendation,
        ai_memo=None,
        generated_by=GeneratedBy(engine_version=ENGINE_VERSION),
    )

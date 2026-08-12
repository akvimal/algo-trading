"""The live tick for the in-house indicator engine - queries every
`live`/`in_house` Strategy, resolves its underlying via market-data,
fetches enough recent history, evaluates its rule, and posts a fresh
signal to signal-processing if one just fired. Reuses the exact same
evaluate_* functions backtest.py replays over history (rules.py), so
live and backtest can never silently disagree about what counts as a
signal - see docs/architecture.md.

One strategy's failure (market-data unreachable, unresolvable
underlying, signal-processing unreachable) is caught and logged, never
aborting the tick for other strategies - same defensive shape as
execution's _quotes_by_exchange."""

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional, Protocol

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain import breakout, range_breakout, regime
from app.domain.models import BreakoutRuleConfig, RangeBreakoutRuleConfig, validate_indicator_params, validate_rule_config
from app.domain.rules import CandleClose, bars_needed, evaluate

logger = logging.getLogger(__name__)


class ResolvedUnderlyingLike(Protocol):
    chart_symbol: str
    chart_exchange: str
    trade_symbol: str
    trade_exchange: str
    lot_size: int


ResolveUnderlying = Callable[[str, str], Optional[ResolvedUnderlyingLike]]
GetCandleHistory = Callable[[str, str, str, date, date], list[CandleClose]]
GetLtp = Callable[[str, str], Optional[float]]
GetUniverseConstituents = Callable[[str], Optional[list[str]]]
PostSignal = Callable[[dict], dict]

_INTERVAL_MINUTES = {"1min": 1, "5min": 5, "15min": 15, "25min": 25, "60min": 60}
_HISTORY_MULTIPLIER = 4  # fetch this many warm-up periods' worth of bars, not just barely enough
_MIN_HISTORY_DAYS = 3
_MAX_HISTORY_DAYS = 30


def history_window(bar_count: int, interval: str) -> tuple[date, date]:
    """A coarse over-estimate of calendar days needed to cover
    `bars_needed` bars at `interval` - extra empty days cost nothing but
    a wider query, so this deliberately doesn't try to be a precise
    trading-calendar calculation."""
    today = datetime.now(timezone.utc).date()
    minutes = _INTERVAL_MINUTES.get(interval, 5)
    bars_per_day = max(1, (6.25 * 60) // minutes)  # ~6h15m NSE session as a rough yardstick
    days_needed = max(_MIN_HISTORY_DAYS, min(_MAX_HISTORY_DAYS, int(bar_count / bars_per_day) + 2))
    return today - timedelta(days=days_needed), today


def _target_symbols(strategy: db_models.Strategy, get_universe_constituents: GetUniverseConstituents) -> list[str]:
    """A plain symbol-scoped strategy checks exactly its own underlying,
    same as before universes existed. A universe-scoped strategy
    (underlying_type='universe') instead checks every constituent of the
    named NSE index independently - each gets its own engine_runs dedupe
    row (keyed by (strategy_id, symbol)) and its own resolve/candle-fetch/
    evaluate/post_signal pass, via the exact same per-symbol functions
    below. An unresolvable universe (market-data unreachable, unknown
    key) is logged and skipped for this tick, same defensive shape as an
    unresolvable plain underlying."""
    if strategy.underlying_type == "universe":
        constituents = get_universe_constituents(strategy.underlying)
        if not constituents:
            logger.warning("could not resolve universe %s for strategy %s", strategy.underlying, strategy.id)
            return []
        return constituents
    return [strategy.underlying]


def _run_one_breakout(
    db: Session,
    strategy: db_models.Strategy,
    rule: BreakoutRuleConfig,
    symbol: str,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    post_signal: PostSignal,
) -> bool:
    """The live tick's breakout-rule path - entry only, per the documented
    live enforcement gap (app/domain/breakout.py's module docstring): the
    reversal exit only ever runs inside the backtest simulation, since
    execution has no mechanism to enforce it on a real position. The
    initial stop-loss IS enforced live, via execution's existing
    `previous_candle` method - app/api/routes/strategies.py auto-sets
    Strategy.stop_loss_interval to this rule's own htf_interval at create
    time for exactly that reason, so nothing extra needs to happen here.

    `symbol` is the one target this call checks - strategy.underlying
    itself for a plain symbol-scoped strategy, or one constituent of
    strategy.underlying's universe (see _target_symbols) - callers loop
    over every target symbol, calling this once per symbol."""
    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False

    htf_bars, ltf_bars = breakout.breakout_warmup(rule)
    htf_from, htf_to = history_window(htf_bars * _HISTORY_MULTIPLIER, rule.htf_interval)
    ltf_from, ltf_to = history_window(ltf_bars * _HISTORY_MULTIPLIER, rule.ltf_interval)
    htf_candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule.htf_interval, htf_from, htf_to)
    ltf_candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule.ltf_interval, ltf_from, ltf_to)
    if not htf_candles or not ltf_candles:
        return False

    run = db.get(db_models.EngineRun, (strategy.id, symbol))
    if run is None:
        run = db_models.EngineRun(strategy_id=strategy.id, symbol=symbol)
        db.add(run)
    run.last_checked_at = datetime.now(timezone.utc)

    result = breakout.evaluate_breakout_live(rule, htf_candles, ltf_candles)
    if result is None:
        return False
    bias, ltf_ts = result
    latest_ts = datetime.fromisoformat(ltf_ts)

    if run.last_signal_candle_ts is not None and run.last_signal_candle_ts == latest_ts:
        return False  # already acted on this exact completed LTF bar

    # The LTF candle that triggered is on the CHARTED instrument
    # (resolved.chart_symbol - an index spot, for NSE indices) - the
    # actual trade is resolved.trade_symbol (e.g. the active-month
    # future), a different instrument with its own price. Posting the
    # chart candle's close as the entry price would silently record the
    # wrong instrument's price on the real position - fetch the traded
    # instrument's own current price instead.
    trade_price = get_ltp(resolved.trade_exchange, resolved.trade_symbol)
    if trade_price is None:
        logger.warning("could not fetch LTP for trade symbol %s (%s) - skipping signal", resolved.trade_symbol, resolved.trade_exchange)
        return False

    post_signal(
        {
            "strategy_id": str(strategy.id),
            "symbol": resolved.trade_symbol,
            "exchange": resolved.trade_exchange,
            "action": "BUY" if bias == "bullish" else "SELL",
            "price": trade_price,
            "source": "in_house",
            "source_meta": {
                "underlying": symbol,
                "universe": strategy.underlying if strategy.underlying_type == "universe" else None,
                "rule": "breakout",
                "htf_interval": rule.htf_interval,
                "ltf_interval": rule.ltf_interval,
                "chart_symbol": resolved.chart_symbol,
            },
        }
    )
    run.last_signal_candle_ts = latest_ts
    return True


def _run_one_range_breakout(
    db: Session,
    strategy: db_models.Strategy,
    rule: RangeBreakoutRuleConfig,
    symbol: str,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    post_signal: PostSignal,
) -> bool:
    """The live tick's single-timeframe range-breakout path - mirrors
    _run_one's own shape closely (resolve -> fetch -> dedupe-check ->
    evaluate -> regime filter -> LTP fetch -> post_signal), just with
    range_breakout.evaluate_range_breakout_live instead of an
    indicator-based evaluate() call, and no Indicator lookup."""
    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False

    bar_count = range_breakout.range_breakout_warmup(rule)
    if strategy.regime_filter_enabled:
        bar_count = max(bar_count, regime.regime_warmup(regime.DEFAULT_REGIME_PARAMS))
    bar_count *= _HISTORY_MULTIPLIER
    from_date, to_date = history_window(bar_count, strategy.interval)
    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, strategy.interval, from_date, to_date)
    if not candles:
        return False

    latest_ts = datetime.fromisoformat(candles[-1].timestamp)

    run = db.get(db_models.EngineRun, (strategy.id, symbol))
    if run is None:
        run = db_models.EngineRun(strategy_id=strategy.id, symbol=symbol)
        db.add(run)
    run.last_checked_at = datetime.now(timezone.utc)

    if run.last_signal_candle_ts is not None and run.last_signal_candle_ts == latest_ts:
        return False  # already acted on this exact completed bar

    result = range_breakout.evaluate_range_breakout_live(rule, candles)
    if result is None:
        return False
    bias, _ = result

    if strategy.regime_filter_enabled:
        regime_result = regime.classify_regime(candles)
        enabled_checks = frozenset(strategy.regime_filter_checks)
        if not regime.direction_confirmed(bias, regime_result, enabled_checks=enabled_checks):
            return False  # breakout fired, but the regime doesn't confirm its direction

    trade_price = get_ltp(resolved.trade_exchange, resolved.trade_symbol)
    if trade_price is None:
        logger.warning("could not fetch LTP for trade symbol %s (%s) - skipping signal", resolved.trade_symbol, resolved.trade_exchange)
        return False

    post_signal(
        {
            "strategy_id": str(strategy.id),
            "symbol": resolved.trade_symbol,
            "exchange": resolved.trade_exchange,
            "action": "BUY" if bias == "bullish" else "SELL",
            "price": trade_price,
            "source": "in_house",
            "source_meta": {
                "underlying": symbol,
                "universe": strategy.underlying if strategy.underlying_type == "universe" else None,
                "rule": "range_breakout",
                "chart_symbol": resolved.chart_symbol,
            },
        }
    )
    run.last_signal_candle_ts = latest_ts
    return True


def _run_one(
    db: Session,
    strategy: db_models.Strategy,
    symbol: str,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    post_signal: PostSignal,
) -> bool:
    """Returns True if a fresh signal was posted. `symbol` is the one
    target this call checks - see _run_one_breakout's docstring, same
    convention."""
    rule = validate_rule_config(strategy.rule_config)

    if isinstance(rule, BreakoutRuleConfig):
        return _run_one_breakout(db, strategy, rule, symbol, resolve_underlying, get_candle_history, get_ltp, post_signal)
    if isinstance(rule, RangeBreakoutRuleConfig):
        return _run_one_range_breakout(
            db, strategy, rule, symbol, resolve_underlying, get_candle_history, get_ltp, post_signal
        )

    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        # Defensive: the route layer checks this exists at create/update
        # time (see app/api/routes/strategies.py), this only covers an
        # indicator deleted *after* a strategy already referenced it.
        logger.warning("indicator %s referenced by strategy %s no longer exists", rule.indicator_id, strategy.id)
        return False
    indicator_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False

    bar_count = bars_needed(rule, indicator.type, indicator_params)
    if strategy.regime_filter_enabled:
        bar_count = max(bar_count, regime.regime_warmup(regime.DEFAULT_REGIME_PARAMS))
    bar_count *= _HISTORY_MULTIPLIER
    from_date, to_date = history_window(bar_count, strategy.interval)
    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, strategy.interval, from_date, to_date)
    if not candles:
        return False

    latest_ts = datetime.fromisoformat(candles[-1].timestamp)

    run = db.get(db_models.EngineRun, (strategy.id, symbol))
    if run is None:
        run = db_models.EngineRun(strategy_id=strategy.id, symbol=symbol)
        db.add(run)
    run.last_checked_at = datetime.now(timezone.utc)

    if run.last_signal_candle_ts is not None and run.last_signal_candle_ts == latest_ts:
        return False  # already acted on this exact completed bar

    bias = evaluate(rule, indicator.type, indicator_params, candles)
    if bias is None:
        return False

    if strategy.regime_filter_enabled:
        regime_result = regime.classify_regime(candles)
        enabled_checks = frozenset(strategy.regime_filter_checks)
        if not regime.direction_confirmed(bias, regime_result, enabled_checks=enabled_checks):
            return False  # crossover fired, but the regime doesn't confirm its direction

    # The completed candle that drove the signal is on the CHARTED
    # instrument (resolved.chart_symbol - an index spot, for NSE
    # indices) - the actual trade is resolved.trade_symbol (e.g. the
    # active-month future), a different instrument with its own price.
    # Posting the chart candle's close as the entry price would silently
    # record the wrong instrument's price on the real position - fetch
    # the traded instrument's own current price instead.
    trade_price = get_ltp(resolved.trade_exchange, resolved.trade_symbol)
    if trade_price is None:
        logger.warning("could not fetch LTP for trade symbol %s (%s) - skipping signal", resolved.trade_symbol, resolved.trade_exchange)
        return False

    post_signal(
        {
            "strategy_id": str(strategy.id),
            "symbol": resolved.trade_symbol,
            "exchange": resolved.trade_exchange,
            "action": "BUY" if bias == "bullish" else "SELL",
            "price": trade_price,
            "source": "in_house",
            "source_meta": {
                "underlying": symbol,
                "universe": strategy.underlying if strategy.underlying_type == "universe" else None,
                "indicator": indicator.name,
                "chart_symbol": resolved.chart_symbol,
            },
        }
    )
    run.last_signal_candle_ts = latest_ts
    return True


def run_live_tick(
    db: Session,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    get_universe_constituents: GetUniverseConstituents,
    post_signal: PostSignal,
) -> dict:
    strategies = (
        db.query(db_models.Strategy)
        .filter(db_models.Strategy.status == "live", db_models.Strategy.source_type == "in_house")
        .all()
    )

    checked = 0
    signaled = 0
    failed = 0
    for strategy in strategies:
        for symbol in _target_symbols(strategy, get_universe_constituents):
            checked += 1
            try:
                if _run_one(db, strategy, symbol, resolve_underlying, get_candle_history, get_ltp, post_signal):
                    signaled += 1
            except Exception:
                logger.exception("engine tick failed for strategy %s (%s)", strategy.id, symbol)
                failed += 1

    db.commit()
    return {"checked": checked, "signaled": signaled, "failed": failed}

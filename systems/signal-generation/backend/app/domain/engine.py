"""The live tick for the in-house indicator engine - queries every
`live`/`in_house` Strategy (joined to its linked Rule, see
app/domain/rule.py), resolves the rule's underlying via market-data,
fetches enough recent history, evaluates the rule, and posts a fresh
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
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Optional, Protocol
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings
from app.domain import breakout, range_breakout
from app.domain.indicators import evaluate_regime_indicator, regime_indicator_warmup
from app.domain.models import WEEKDAY_NAMES
from app.domain.rule import (
    BreakoutRuleConfig,
    RangeBreakoutRuleConfig,
    parse_symbol_list,
    validate_indicator_params,
    validate_rule_config,
)
from app.domain.rules import Bias, CandleClose, bars_needed, find_crossovers_since

logger = logging.getLogger(__name__)


class ResolvedUnderlyingLike(Protocol):
    chart_symbol: str
    chart_exchange: str
    trade_symbol: str
    trade_exchange: str
    lot_size: float  # int for NSE/MCX F&O; a real fraction for Delta CRYPTO perpetuals (e.g. BTCUSD=0.001)
    expiry: Optional[str]


ResolveUnderlying = Callable[[str, str], Optional[ResolvedUnderlyingLike]]
GetCandleHistory = Callable[[str, str, str, date, date], list[CandleClose]]
GetLtp = Callable[[str, str], Optional[float]]
GetUniverseConstituents = Callable[[str], Optional[list[str]]]
PostSignal = Callable[[dict], dict]

_INTERVAL_MINUTES = {"1min": 1, "3min": 3, "5min": 5, "15min": 15, "25min": 25, "30min": 30, "60min": 60}
_HISTORY_MULTIPLIER = 4  # fetch this many warm-up periods' worth of bars, not just barely enough
_MIN_HISTORY_DAYS = 3
_MAX_HISTORY_DAYS = 30


def history_window(bar_count: int, interval: str) -> tuple[date, date]:
    """A coarse over-estimate of calendar days needed to cover
    `bars_needed` bars at `interval` - extra empty days cost nothing but
    a wider query, so this deliberately doesn't try to be a precise
    trading-calendar calculation.

    `today` MUST be IST, not UTC - market-data's candle history is IST-
    calendar-dated (see docs/architecture.md). Using UTC's date here used
    to freeze `to=<date>` at the previous IST day for the ~5h30m/day UTC
    trails IST (18:30-24:00 UTC = 00:00-05:30 IST next day), silently
    excluding every candle formed since the last IST midnight - a live
    in-house CRYPTO strategy ticking in that window would evaluate stale
    data and could never signal. Reproduced live: a 24/7 BTCUSD crossover
    rule with an 02:15-04:14 IST active window produced zero signals
    despite 6 real crossovers occurring in it, because every candle fetch
    during that window still carried `to=<yesterday's UTC date>`."""
    today = datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Kolkata")).date()
    minutes = _INTERVAL_MINUTES.get(interval, 5)
    bars_per_day = max(1, (6.25 * 60) // minutes)  # ~6h15m NSE session as a rough yardstick
    days_needed = max(_MIN_HISTORY_DAYS, min(_MAX_HISTORY_DAYS, int(bar_count / bars_per_day) + 2))
    return today - timedelta(days=days_needed), today


def _is_within_active_window(now_time: time, active_windows: list[dict]) -> bool:
    """True if there are no windows at all (empty list - no restriction)
    or now_time falls within ANY one of active_windows (each a
    {"start": "HH:MM:SS", "end": "HH:MM:SS"} dict, straight from the
    Strategy row's own JSONB column). Pure efficiency optimization for
    run_live_tick - skips wasted market-data calls for a strategy that
    resolve() (signal-processing) would just reject anyway; NOT the
    authoritative check, which is resolve()'s own is_within_active_window
    (app/domain/resolution/pipeline.py there) - that one also covers
    external-provider signals this engine never sees."""
    if not active_windows:
        return True
    return any(time.fromisoformat(w["start"]) <= now_time <= time.fromisoformat(w["end"]) for w in active_windows)


def _matches_active_weekdays(today: date, active_weekdays: list[str]) -> bool:
    """True if there's no weekday filter at all (empty list - no
    restriction) or today's weekday name is in active_weekdays (e.g.
    ["Mon","Tue","Wed","Thu","Fri"] for weekdays-only). Same pure
    efficiency-optimization role _is_within_active_window has above - not
    the authoritative check, which is resolve()'s own
    matches_active_weekday (app/domain/resolution/pipeline.py there)."""
    if not active_weekdays:
        return True
    return WEEKDAY_NAMES[today.weekday()] in active_weekdays


def _matches_contract_day_filter(
    instrument_type: str, segment: str, contract_day_filter: str, expiry: Optional[str], today: date
) -> bool:
    """True if this future should be allowed to fire today, given
    Strategy.contract_day_filter. Only meaningful for instrument_type=
    'future' + contract_day_filter='expiry' - 'start' is rejected at
    Strategy-config time for futures (see validate_contract_day_filter_fields,
    not reliably computable), 'any' never restricts, spot has no expiry
    concept, and segment='CRYPTO' is always excluded (daily option expiry
    makes the distinction meaningless there - this only ever applies to
    futures anyway, which don't exist for CRYPTO today). Options are
    checked separately, in signal-processing's choose_strategy, where the
    live expiry list actually lives."""
    if instrument_type != "future" or contract_day_filter != "expiry" or segment == "CRYPTO":
        return True
    return expiry is not None and today.isoformat() == expiry


def _target_symbols(rule_row: db_models.Rule, get_universe_constituents: GetUniverseConstituents) -> list[str]:
    """A plain symbol-scoped rule checks exactly its own underlying, same
    as before universes existed. A universe-scoped rule
    (underlying_type='universe') instead checks every constituent of the
    named NSE index independently - each gets its own engine_runs dedupe
    row (keyed by (strategy_id, symbol) - see EngineRun's own docstring)
    and its own resolve/candle-fetch/evaluate/post_signal pass, via the
    exact same per-symbol functions below. An unresolvable universe
    (market-data unreachable, unknown key) is logged and skipped for this
    tick, same defensive shape as an unresolvable plain underlying.
    underlying_type='symbol_list' is the same fan-out, but the member list
    comes from parsing `underlying` itself (see parse_symbol_list) rather
    than a market-data lookup - for segments like MCX with no index/
    universe concept, letting a rule scan a hand-picked set of symbols."""
    if rule_row.underlying_type == "universe":
        constituents = get_universe_constituents(rule_row.underlying)
        if not constituents:
            logger.warning("could not resolve universe %s for rule %s", rule_row.underlying, rule_row.id)
            return []
        return constituents
    if rule_row.underlying_type == "symbol_list":
        return parse_symbol_list(rule_row.underlying)
    return [rule_row.underlying]


def _regime_confirmed(db: Session, rule_row: db_models.Rule, bias: Bias, candles: list[CandleClose]) -> bool:
    """Rule.regime_indicator_ids gate, shared by all 3 rule types below -
    ALL listed regime indicators must confirm `bias` (not a majority
    vote), mirroring the old Strategy.regime_filter_enabled/checks'
    all-must-agree semantics but resolved per-Rule now from real
    Indicator rows instead of one fixed Strategy-level checklist. Empty
    regime_indicator_ids (the default - no regime gate configured)
    trivially confirms everything, same as before. A regime indicator
    deleted after a rule already referenced it is treated as unconfirmed
    - defensive, the route layer is the primary check (see
    app/api/routes/rules.py)."""
    for raw_id in rule_row.regime_indicator_ids:
        indicator = db.get(db_models.Indicator, uuid.UUID(raw_id))
        if indicator is None:
            logger.warning("regime indicator %s referenced by rule %s no longer exists", raw_id, rule_row.id)
            return False
        params = validate_indicator_params(indicator.type, indicator.params).model_dump()
        if not evaluate_regime_indicator(indicator.type, params, candles, bias):
            return False
    return True


def _regime_warmup_bars(db: Session, rule_row: db_models.Rule) -> int:
    """Widest bar-count any one of this rule's regime indicators needs -
    folded into the caller's own bar_count via max(), same "extra empty
    bars cost nothing" sizing philosophy the old Strategy-level
    regime.regime_warmup() used. 0 (a no-op max()) when
    regime_indicator_ids is empty."""
    widest = 0
    for raw_id in rule_row.regime_indicator_ids:
        indicator = db.get(db_models.Indicator, uuid.UUID(raw_id))
        if indicator is None:
            continue
        params = validate_indicator_params(indicator.type, indicator.params).model_dump()
        widest = max(widest, regime_indicator_warmup(indicator.type, params))
    return widest


def _breakout_ltf_settled(ltf_candle_start: datetime, ltf_interval: str) -> bool:
    """Whether settings.breakout_ltf_settle_seconds have passed since the
    LTF candle STARTING at ltf_candle_start actually CLOSED (start +
    interval, not the start time itself) - a real-world buffer against
    the provider still finalizing that candle's OHLC for a few seconds
    after our own timestamp math says it's complete. Pure/stateless so
    it's directly testable without faking a live clock through the whole
    _run_one_breakout orchestration - see Settings.
    breakout_ltf_settle_seconds' own comment for the "why" in full."""
    close_time = ltf_candle_start + timedelta(minutes=_INTERVAL_MINUTES[ltf_interval])
    settle_deadline = close_time + timedelta(seconds=settings.breakout_ltf_settle_seconds)
    return datetime.now(timezone.utc) >= settle_deadline


def _run_one_breakout(
    db: Session,
    strategy: db_models.Strategy,
    rule_row: db_models.Rule,
    rule: BreakoutRuleConfig,
    symbol: str,
    today: date,
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
    Strategy.stop_loss_interval to this rule's own ltf_interval whenever a
    strategy links to a breakout rule (HTF only arms the setup; entry and
    the stop are both LTF-only), for exactly that reason, so nothing extra
    needs to happen here.

    A fresh trigger is only acted on once at least
    settings.breakout_ltf_settle_seconds have passed since the triggering
    LTF candle's own scheduled CLOSE (not its start timestamp) - a real-
    world buffer against the provider still finalizing that candle's OHLC
    for a few seconds after our own timestamp math says it's complete
    (see Settings.breakout_ltf_settle_seconds' own comment). Not acting
    yet just defers, not skips - last_signal_candle_ts is only set once a
    signal actually posts, so the very next tick past the settle window
    still catches it.

    `symbol` is the one target this call checks - rule_row.underlying
    itself for a plain symbol-scoped rule, or one constituent of
    rule_row.underlying's universe (see _target_symbols) - callers loop
    over every target symbol, calling this once per symbol."""
    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False
    if not _matches_contract_day_filter(strategy.instrument_type, strategy.segment, strategy.contract_day_filter, resolved.expiry, today):
        return False

    htf_bars, ltf_bars = breakout.breakout_warmup(rule)
    # rule_row.interval always equals rule.ltf_interval for a breakout
    # rule (see validate_breakout_interval_consistency) - regime runs
    # against the LTF series, same single-timeframe series the other two
    # rule types use.
    ltf_bars = max(ltf_bars, _regime_warmup_bars(db, rule_row))
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

    if not _breakout_ltf_settled(latest_ts, rule.ltf_interval):
        return False  # too soon past this LTF candle's own close - try again next tick

    if run.last_signal_candle_ts is not None and run.last_signal_candle_ts == latest_ts:
        return False  # already acted on this exact completed LTF bar

    if not _regime_confirmed(db, rule_row, bias, ltf_candles):
        return False  # breakout fired, but the regime doesn't confirm its direction

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
            # For instrument_type='option', signal-processing's
            # choose_strategy re-resolves the underlying itself (it needs
            # a fresh option chain, not the future/spot instrument this
            # engine would otherwise trade) - it calls resolve_underlying
            # again with THIS symbol, so it must be the bare underlying
            # name (e.g. "GOLDM"), not resolved.trade_symbol (e.g.
            # "GOLDM-04Sep2026-FUT" - a real MCX contract symbol, not a
            # valid "underlying" resolve_underlying can look up) - see
            # signal-processing's app/domain/resolution/strategy.py
            # choose_strategy's own docstring for the chart_symbol vs
            # bare-underlying distinction this mirrors. Reproduced live:
            # an in-house option strategy on GOLDM was rejected with
            # "could not resolve underlying 'GOLDM-04Sep2026-FUT' ...for
            # options" before this fix. Spot/future are unaffected - they
            # trade resolved.trade_symbol directly, exactly as before.
            "symbol": symbol if strategy.instrument_type == "option" else resolved.trade_symbol,
            "exchange": resolved.trade_exchange,
            "action": "BUY" if bias == "bullish" else "SELL",
            "price": trade_price,
            "source": "in_house",
            "source_meta": {
                "underlying": symbol,
                "universe": rule_row.underlying if rule_row.underlying_type == "universe" else None,
                "symbol_list": rule_row.underlying if rule_row.underlying_type == "symbol_list" else None,
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
    rule_row: db_models.Rule,
    rule: RangeBreakoutRuleConfig,
    symbol: str,
    today: date,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    post_signal: PostSignal,
) -> bool:
    """The live tick's single-timeframe range-breakout path - mirrors
    _run_one's own shape closely (resolve -> fetch -> dedupe-check ->
    evaluate -> regime filter -> LTP fetch -> post_signal), just with
    range_breakout.evaluate_range_breakout_live (single latest-bar check
    only, no multi-bar backfill scan) instead of find_crossovers_since,
    and no Indicator lookup."""
    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False
    if not _matches_contract_day_filter(
        strategy.instrument_type, strategy.segment, strategy.contract_day_filter, resolved.expiry, today
    ):
        return False

    bar_count = range_breakout.range_breakout_warmup(rule)
    bar_count = max(bar_count, _regime_warmup_bars(db, rule_row))
    bar_count *= _HISTORY_MULTIPLIER
    from_date, to_date = history_window(bar_count, rule_row.interval)
    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, from_date, to_date)
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

    if not _regime_confirmed(db, rule_row, bias, candles):
        return False  # breakout fired, but the regime doesn't confirm its direction

    trade_price = get_ltp(resolved.trade_exchange, resolved.trade_symbol)
    if trade_price is None:
        logger.warning("could not fetch LTP for trade symbol %s (%s) - skipping signal", resolved.trade_symbol, resolved.trade_exchange)
        return False

    post_signal(
        {
            "strategy_id": str(strategy.id),
            # For instrument_type='option', signal-processing's
            # choose_strategy re-resolves the underlying itself (it needs
            # a fresh option chain, not the future/spot instrument this
            # engine would otherwise trade) - it calls resolve_underlying
            # again with THIS symbol, so it must be the bare underlying
            # name (e.g. "GOLDM"), not resolved.trade_symbol (e.g.
            # "GOLDM-04Sep2026-FUT" - a real MCX contract symbol, not a
            # valid "underlying" resolve_underlying can look up) - see
            # signal-processing's app/domain/resolution/strategy.py
            # choose_strategy's own docstring for the chart_symbol vs
            # bare-underlying distinction this mirrors. Reproduced live:
            # an in-house option strategy on GOLDM was rejected with
            # "could not resolve underlying 'GOLDM-04Sep2026-FUT' ...for
            # options" before this fix. Spot/future are unaffected - they
            # trade resolved.trade_symbol directly, exactly as before.
            "symbol": symbol if strategy.instrument_type == "option" else resolved.trade_symbol,
            "exchange": resolved.trade_exchange,
            "action": "BUY" if bias == "bullish" else "SELL",
            "price": trade_price,
            "source": "in_house",
            "source_meta": {
                "underlying": symbol,
                "universe": rule_row.underlying if rule_row.underlying_type == "universe" else None,
                "symbol_list": rule_row.underlying if rule_row.underlying_type == "symbol_list" else None,
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
    rule_row: db_models.Rule,
    symbol: str,
    today: date,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    post_signal: PostSignal,
) -> bool:
    """Returns True if a fresh signal was posted. `symbol` is the one
    target this call checks - see _run_one_breakout's docstring, same
    convention. `today` is the tick's own local date (run_live_tick's
    today_ist) - threaded down for contract_day_filter, not re-derived
    per call so every strategy checked in the same tick agrees on "today"."""
    rule = validate_rule_config(rule_row.rule_config)

    if isinstance(rule, BreakoutRuleConfig):
        return _run_one_breakout(db, strategy, rule_row, rule, symbol, today, resolve_underlying, get_candle_history, get_ltp, post_signal)
    if isinstance(rule, RangeBreakoutRuleConfig):
        return _run_one_range_breakout(
            db, strategy, rule_row, rule, symbol, today, resolve_underlying, get_candle_history, get_ltp, post_signal
        )

    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        # Defensive: the route layer checks this exists at Rule
        # create/update time (see app/api/routes/rules.py), this only
        # covers an indicator deleted *after* a rule already referenced it.
        logger.warning("indicator %s referenced by rule %s no longer exists", rule.indicator_id, rule_row.id)
        return False
    indicator_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    resolved = resolve_underlying(strategy.segment, symbol)
    if resolved is None:
        logger.warning(
            "could not resolve underlying %s (segment=%s) for strategy %s", symbol, strategy.segment, strategy.id
        )
        return False
    if not _matches_contract_day_filter(strategy.instrument_type, strategy.segment, strategy.contract_day_filter, resolved.expiry, today):
        return False

    bar_count = bars_needed(rule, indicator.type, indicator_params)
    bar_count = max(bar_count, _regime_warmup_bars(db, rule_row))
    bar_count *= _HISTORY_MULTIPLIER
    from_date, to_date = history_window(bar_count, rule_row.interval)
    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, from_date, to_date)
    if not candles:
        return False

    run = db.get(db_models.EngineRun, (strategy.id, symbol))
    if run is None:
        run = db_models.EngineRun(strategy_id=strategy.id, symbol=symbol)
        db.add(run)
    run.last_checked_at = datetime.now(timezone.utc)

    # Every crossover since the last one actually signaled, not just the
    # newest bar - a 60s poll tick isn't guaranteed to align with the
    # candle cadence (processing lag, or plain phase drift against the
    # exchange's minute boundaries), so 2+ candles can complete between
    # one tick and the next; comparing only the latest bar-pair would
    # silently miss a crossover-then-reversal entirely contained in the
    # skipped bars. Naturally bounded by this tick's own `candles` fetch
    # (sized off the indicator's warmup, see bar_count above) - a strategy
    # reactivated after a long pause backfills at most that window, not
    # its entire history. See find_crossovers_since's own docstring
    # (reproduced live 2026-08-21).
    crossovers = find_crossovers_since(rule, indicator.type, indicator_params, candles, run.last_signal_candle_ts)
    if not crossovers:
        return False

    latest_index = len(candles) - 1
    signaled_any = False
    for index, bias in crossovers:
        # Regime state AS OF that bar, not as of now - a retroactively
        # discovered crossover is judged by what the regime looked like
        # when it actually happened, not by today's tick's own regime
        # snapshot. Doesn't advance last_signal_candle_ts on rejection -
        # a later tick re-checks this same bar in case a since-added
        # regime indicator (or its own warmup finishing) confirms it by
        # then, same as the single-bar design this replaces.
        if not _regime_confirmed(db, rule_row, bias, candles[: index + 1]):
            continue

        if index == latest_index:
            # The current bar - the completed candle that drove the
            # signal is on the CHARTED instrument (resolved.chart_symbol -
            # an index spot, for NSE indices), but the actual trade is
            # resolved.trade_symbol (e.g. the active-month future), a
            # different instrument with its own price. A live quote on the
            # TRADED instrument is the accurate fill price here.
            price = get_ltp(resolved.trade_exchange, resolved.trade_symbol)
            if price is None:
                logger.warning(
                    "could not fetch LTP for trade symbol %s (%s) - skipping signal", resolved.trade_symbol, resolved.trade_exchange
                )
                continue
        else:
            # A crossover discovered retroactively (this tick's candle
            # fetch already contains bars newer than this one) - there's
            # no live quote for a bar that's already in the past, so its
            # own candle close on the charted instrument is the best
            # available fill price, the same approximation
            # app/domain/backtest.py's replay already uses for every
            # simulated trade.
            price = candles[index].close

        post_signal(
            {
                "strategy_id": str(strategy.id),
                # For instrument_type='option', signal-processing's
                # choose_strategy re-resolves the underlying itself (it
                # needs a fresh option chain, not the future/spot
                # instrument this engine would otherwise trade) - it calls
                # resolve_underlying again with THIS symbol, so it must be
                # the bare underlying name (e.g. "GOLDM"), not
                # resolved.trade_symbol (e.g. "GOLDM-04Sep2026-FUT" - a
                # real MCX contract symbol, not a valid "underlying"
                # resolve_underlying can look up) - see signal-processing's
                # app/domain/resolution/strategy.py choose_strategy's own
                # docstring for the chart_symbol vs bare-underlying
                # distinction this mirrors. Reproduced live: an in-house
                # option strategy on GOLDM was rejected with "could not
                # resolve underlying 'GOLDM-04Sep2026-FUT' ...for options"
                # before this fix. Spot/future are unaffected - they trade
                # resolved.trade_symbol directly, exactly as before.
                "symbol": symbol if strategy.instrument_type == "option" else resolved.trade_symbol,
                "exchange": resolved.trade_exchange,
                "action": "BUY" if bias == "bullish" else "SELL",
                "price": price,
                "source": "in_house",
                "source_meta": {
                    "underlying": symbol,
                    "universe": rule_row.underlying if rule_row.underlying_type == "universe" else None,
                    "symbol_list": rule_row.underlying if rule_row.underlying_type == "symbol_list" else None,
                    "indicator": indicator.name,
                    "chart_symbol": resolved.chart_symbol,
                },
            }
        )
        # Advances only on an actual post, one bar at a time, in
        # chronological order - so a failure partway through this loop
        # (a rejected regime check, a failed LTP fetch) never causes an
        # earlier, already-posted bar to be silently skipped or re-signaled.
        run.last_signal_candle_ts = datetime.fromisoformat(candles[index].timestamp)
        signaled_any = True

    return signaled_any


def run_live_tick(
    db: Session,
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
    get_ltp: GetLtp,
    get_universe_constituents: GetUniverseConstituents,
    post_signal: PostSignal,
) -> dict:
    strategy_rule_pairs = (
        db.query(db_models.Strategy, db_models.Rule)
        .join(db_models.Rule, db_models.Strategy.rule_id == db_models.Rule.id)
        .filter(db_models.Strategy.status == "live", db_models.Strategy.source_type == "in_house")
        .all()
    )

    now_ist_dt = datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Kolkata"))
    now_ist = now_ist_dt.time()
    today_ist = now_ist_dt.date()

    checked = 0
    signaled = 0
    failed = 0
    for strategy, rule_row in strategy_rule_pairs:
        if not _is_within_active_window(now_ist, strategy.active_windows):
            continue
        if not _matches_active_weekdays(today_ist, strategy.active_weekdays):
            continue
        for symbol in _target_symbols(rule_row, get_universe_constituents):
            checked += 1
            try:
                if _run_one(db, strategy, rule_row, symbol, today_ist, resolve_underlying, get_candle_history, get_ltp, post_signal):
                    signaled += 1
            except Exception:
                logger.exception("engine tick failed for strategy %s (%s)", strategy.id, symbol)
                failed += 1

    db.commit()
    return {"checked": checked, "signaled": signaled, "failed": failed}

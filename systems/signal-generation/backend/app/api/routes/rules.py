import logging
import uuid
from datetime import date
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.market_data.client import (
    get_candle_history,
    get_option_leg_history,
    get_universe_constituents,
    resolve_underlying,
)
from app.domain import breakout, range_breakout
from app.domain.backtest import (
    MAX_GRID_COMBINATIONS,
    ExitConfig,
    RegimeIndicators,
    expand_grid,
    expand_stop_loss_grid,
    grid_search,
    replay,
)
from app.domain.engine import history_window, resolve_watchlist_symbols
from app.domain.indicators import regime_indicator_warmup
from app.domain.option_backtest import MAX_OPTION_BACKTEST_DAYS, OPTION_HISTORY_INTERVAL, replay_options
from app.domain.rule import (
    CROSSOVER_INDICATOR_TYPES,
    REGIME_INDICATOR_TYPES,
    BreakoutRuleConfig,
    CrossoverRuleConfig,
    RangeBreakoutRuleConfig,
    RuleBacktestGridRequest,
    RuleBacktestRequest,
    RuleConfig,
    RuleCreate,
    RuleOut,
    RuleUpdate,
    parse_symbol_list,
    validate_breakout_interval_consistency,
    validate_indicator_params,
    validate_rule_config,
    validate_rule_in_house_fields,
    validate_rule_symbol_list_fields,
    validate_rule_universe_fields,
    validate_rule_watchlist_fields,
)
from app.domain.rules import bars_needed, build_crossover_bias_fn, evaluate

logger = logging.getLogger(__name__)
router = APIRouter()


def _to_out(row: db_models.Rule) -> RuleOut:
    return RuleOut(
        id=str(row.id),
        name=row.name,
        description=row.description,
        segment=row.segment,
        underlying=row.underlying,
        underlying_type=row.underlying_type,
        interval=row.interval,
        rule_config=row.rule_config,
        regime_indicator_ids=row.regime_indicator_ids,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _check_referenced_indicator_exists(db: Session, rule_config: Optional[dict]) -> None:
    """CrossoverRuleConfig rules must reference a real Indicator at
    create/update time - validate_rule_config only checks rule_config's
    shape, not that indicator_id resolves to anything (that needs a DB
    session). The engine's own defensive skip (app/domain/engine.py) is a
    second, later line of defense for an indicator deleted *after* a rule
    already referenced it, not this primary check. BreakoutRuleConfig/
    RangeBreakoutRuleConfig have no indicator_id at all - nothing to
    check. Also rejects an indicator whose type isn't in
    CROSSOVER_INDICATOR_TYPES here - app/domain/indicators.py's
    compute_indicator/compute_indicator_signal only know how to dispatch
    a subset of IndicatorTypes ("rsi", "supertrend"), so a crossover rule
    referencing anything else would 500 at evaluation time instead of
    failing validation here. Membership in CROSSOVER_INDICATOR_TYPES is
    checked directly (not "not a regime type") since "supertrend" is
    deliberately valid for both - see that set's own docstring."""
    if rule_config is None:
        return
    rule = validate_rule_config(rule_config)
    if not isinstance(rule, CrossoverRuleConfig):
        return
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    if indicator.type not in CROSSOVER_INDICATOR_TYPES:
        raise HTTPException(
            status_code=422, detail=f"indicator '{rule.indicator_id}' has type '{indicator.type}', not a crossover-compatible type"
        )


def _check_regime_indicator_ids(db: Session, regime_indicator_ids: list[str]) -> None:
    """Each id in Rule.regime_indicator_ids must resolve to a real
    Indicator, AND that Indicator's own `type` must be one of the 5
    regime types (REGIME_INDICATOR_TYPES) - "rsi" is a crossover-only
    slot (CrossoverRuleConfig.indicator_id), never a regime one, so an
    rsi id here is rejected the same as a nonexistent one. Mirrors
    _check_referenced_indicator_exists's shape for CrossoverRuleConfig
    above."""
    for raw_id in regime_indicator_ids:
        try:
            parsed_id = uuid.UUID(raw_id)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"invalid indicator id '{raw_id}'")
        indicator = db.get(db_models.Indicator, parsed_id)
        if indicator is None:
            raise HTTPException(status_code=422, detail=f"no indicator with id '{raw_id}'")
        if indicator.type not in REGIME_INDICATOR_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"indicator '{raw_id}' has type '{indicator.type}', not a regime type ({sorted(REGIME_INDICATOR_TYPES)})",
            )


def _check_watchlist_exists(db: Session, underlying_type: str, underlying: Optional[str]) -> None:
    """underlying_type='watchlist' must name a real signal_generation.watchlists
    row at create/update time - unlike 'universe' (no equivalent check
    today, fails silently at scan time instead), this is cheap to verify
    since the Watchlist table is local to this same DB/system. Mirrors
    _check_regime_indicator_ids' shape: shape-only validation already
    happened in the Pydantic layer (validate_rule_watchlist_fields),
    existence is checked here where a DB session is available."""
    if underlying_type != "watchlist":
        return
    exists = db.query(db_models.Watchlist).filter_by(name=underlying).first() is not None
    if not exists:
        raise HTTPException(status_code=404, detail=f"no watchlist named '{underlying}'")


def _resolve_regime_indicators(db: Session, rule_row: db_models.Rule) -> RegimeIndicators:
    """Rule.regime_indicator_ids resolved to (indicator_type, params)
    pairs, once per backtest request - fed into backtest.replay/
    grid_search's own regime_indicators param (app/domain/backtest.py),
    the same resolve-then-pass-in pattern the rule's own crossover
    indicator_id already uses just above. 422 if an id no longer resolves
    - defensive, _check_regime_indicator_ids is the primary check at Rule
    create/update time."""
    resolved: RegimeIndicators = []
    for raw_id in rule_row.regime_indicator_ids:
        indicator = db.get(db_models.Indicator, uuid.UUID(raw_id))
        if indicator is None:
            raise HTTPException(status_code=422, detail=f"no indicator with id '{raw_id}'")
        resolved.append((indicator.type, validate_indicator_params(indicator.type, indicator.params).model_dump()))
    return resolved


def _regime_warmup_bars(regime_indicators: RegimeIndicators) -> int:
    """Widest bar-count any one resolved regime indicator needs - folded
    into the caller's own bar_count via max(), same sizing philosophy as
    app/domain/engine.py's own _regime_warmup_bars."""
    return max((regime_indicator_warmup(t, p) for t, p in regime_indicators), default=0)


@router.post("/rules", response_model=RuleOut, status_code=201)
def create_rule(payload: RuleCreate, db: Session = Depends(get_db)):
    _check_referenced_indicator_exists(db, payload.rule_config)
    _check_regime_indicator_ids(db, payload.regime_indicator_ids)
    _check_watchlist_exists(db, payload.underlying_type, payload.underlying)
    row = db_models.Rule(
        name=payload.name,
        description=payload.description,
        segment=payload.segment,
        underlying=payload.underlying,
        underlying_type=payload.underlying_type,
        interval=payload.interval,
        rule_config=payload.rule_config,
        regime_indicator_ids=payload.regime_indicator_ids,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("/rules", response_model=list[RuleOut])
def list_rules(db: Session = Depends(get_db)):
    rows = db.query(db_models.Rule).order_by(db_models.Rule.created_at.desc()).all()
    return [_to_out(r) for r in rows]


@router.get("/rules/{rule_id}", response_model=RuleOut)
def get_rule(rule_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db.get(db_models.Rule, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return _to_out(row)


@router.patch("/rules/{rule_id}", response_model=RuleOut)
def update_rule(rule_id: str, payload: RuleUpdate, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db.get(db_models.Rule, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="rule not found")

    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.segment is not None:
        row.segment = payload.segment
    if payload.underlying is not None:
        row.underlying = payload.underlying
    if payload.underlying_type is not None:
        row.underlying_type = payload.underlying_type
    if payload.interval is not None:
        row.interval = payload.interval
    if payload.rule_config is not None:
        row.rule_config = payload.rule_config
    if payload.regime_indicator_ids is not None:
        row.regime_indicator_ids = payload.regime_indicator_ids

    try:
        validate_rule_in_house_fields(row.underlying, row.rule_config, row.interval)
        validate_rule_universe_fields(row.underlying_type, row.segment)
        validate_rule_symbol_list_fields(row.underlying_type, row.underlying)
        validate_rule_watchlist_fields(row.underlying_type, row.underlying)
        validate_breakout_interval_consistency(row.interval, row.rule_config)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _check_referenced_indicator_exists(db, row.rule_config)
    _check_regime_indicator_ids(db, row.regime_indicator_ids)
    _check_watchlist_exists(db, row.underlying_type, row.underlying)

    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: str, db: Session = Depends(get_db)):
    """Guarded (unlike Strategy's own hard delete) - a Rule can back many
    Strategies (see app/domain/models.py), so silently orphaning them
    would leave live strategies referencing a nonexistent rule_id. Delete
    the referencing strategies first, or re-point them at a different
    rule via PATCH /strategies/{id}."""
    try:
        parsed_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db.get(db_models.Rule, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="rule not found")

    referencing = db.query(db_models.Strategy).filter_by(rule_id=parsed_id).count()
    if referencing:
        raise HTTPException(
            status_code=409,
            detail=f"cannot delete rule - {referencing} strateg{'y' if referencing == 1 else 'ies'} still reference it",
        )

    db.delete(row)
    db.commit()


# --- Backtest (relocated from app/api/routes/strategies.py's Strategy-scoped route) ---------


def _load_rule_for_backtest(db: Session, rule_id: str) -> db_models.Rule:
    try:
        parsed_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db.get(db_models.Rule, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return row


def _exit_config_for(payload) -> ExitConfig:
    """Builds simulate_trades' ExitConfig from the backtest request's own
    optional overrides - a Rule alone carries no exit config (that's
    Strategy-owned). Omitting every field reproduces ExitConfig()'s bare
    defaults: opposite-signal/end-of-data exits only. Accepts either
    RuleBacktestRequest or RuleBacktestGridRequest - both expose the same
    field names."""
    return ExitConfig(
        stop_loss_method=payload.stop_loss_method,
        stop_loss_percent=payload.stop_loss_percent,
        stop_loss_indicator_type=getattr(payload, "stop_loss_indicator_type", None),
        stop_loss_indicator_params=getattr(payload, "stop_loss_indicator_params", None),
        target_percent=payload.target_percent,
        trailing_stop_enabled=payload.trailing_stop_enabled,
        square_off_time=payload.square_off_time,
        stop_loss_confirmation=payload.stop_loss_confirmation,
        entry_window_start=payload.entry_window_start,
        entry_window_end=payload.entry_window_end,
        entry_weekdays=payload.entry_weekdays,
    )


def _sl_candles_for(payload, rule_row: db_models.Rule, resolved, candles: list, fetch_from: date, to: date) -> Optional[list]:
    """stop_loss_method='previous_candle' needs a second candle series (at
    the request's own stop_loss_interval, which can differ from the
    rule's main `interval`) - reuses the already-fetched `candles`
    outright when the two intervals match, so the common case costs no
    extra market-data call.

    stop_loss_method='indicator' also needs its own series, always
    fetched fresh over a widened window (not opportunistically reused
    like previous_candle above) since the indicator's own warm-up
    requirement isn't generally the same as the rule's. Reads the warmup
    bar count from stop_loss_indicator_params["period"] - both 'ema' and
    'supertrend' name their warmup field "period" deliberately (see
    SupertrendStopParams' own comment); an indicator type with a
    differently-named warmup field would need its own small dispatch
    here, mirroring backtest.py's _STOP_LOSS_COMPUTE_FUNCS."""
    if payload.stop_loss_method == "previous_candle" and payload.stop_loss_interval:
        if payload.stop_loss_interval == rule_row.interval:
            return candles
        return get_candle_history(resolved.chart_exchange, resolved.chart_symbol, payload.stop_loss_interval, fetch_from, to)
    if payload.stop_loss_method == "indicator" and payload.stop_loss_interval and payload.stop_loss_indicator_params:
        warmup_bars = payload.stop_loss_indicator_params.get("period", 20)
        warmup_from, _ = history_window(warmup_bars, payload.stop_loss_interval)
        return get_candle_history(
            resolved.chart_exchange, resolved.chart_symbol, payload.stop_loss_interval, min(fetch_from, warmup_from), to
        )
    return None


def _backtest_one_symbol(
    db: Session,
    rule_row: db_models.Rule,
    rule: RuleConfig,
    payload: RuleBacktestRequest,
    symbol: str,
    from_: date,
    to: date,
    regime_indicators: RegimeIndicators,
) -> dict:
    """The actual single-symbol backtest, shared by the plain (one
    underlying) and universe (many constituents, see _backtest_universe)
    paths - `symbol` is the traded symbol to run against, not necessarily
    rule_row.underlying itself (a universe rule passes each constituent
    through here in turn). `regime_indicators` (resolved once by the
    caller, see _resolve_regime_indicators) gates crossover/range_breakout
    signals the same way app/domain/engine.py's live tick does - NOT
    applied to a BreakoutRuleConfig backtest (breakout.replay_breakout is
    its own simulation engine with no regime hook at all, a pre-existing
    gap this refactor doesn't close) or an option backtest (see
    _backtest_one_symbol_option)."""
    if payload.instrument_type == "option":
        return _backtest_one_symbol_option(db, rule_row, rule, payload, symbol, from_, to)

    if isinstance(rule, BreakoutRuleConfig):
        resolved = resolve_underlying(rule_row.segment, symbol)
        if resolved is None:
            raise HTTPException(status_code=502, detail=f"could not resolve underlying '{symbol}' on segment '{rule_row.segment}'")
        htf_bars, ltf_bars = breakout.breakout_warmup(rule)
        htf_warmup_from, _ = history_window(htf_bars, rule.htf_interval)
        ltf_warmup_from, _ = history_window(ltf_bars, rule.ltf_interval)
        htf_candles = get_candle_history(
            resolved.chart_exchange, resolved.chart_symbol, rule.htf_interval, min(from_, htf_warmup_from), to
        )
        ltf_candles = get_candle_history(
            resolved.chart_exchange, resolved.chart_symbol, rule.ltf_interval, min(from_, ltf_warmup_from), to
        )
        return breakout.replay_breakout(rule, htf_candles, ltf_candles, payload.square_off_time)

    if isinstance(rule, RangeBreakoutRuleConfig):
        resolved = resolve_underlying(rule_row.segment, symbol)
        if resolved is None:
            raise HTTPException(status_code=502, detail=f"could not resolve underlying '{symbol}' on segment '{rule_row.segment}'")
        warmup_bars = max(range_breakout.range_breakout_warmup(rule), _regime_warmup_bars(regime_indicators))
        warmup_from, _ = history_window(warmup_bars, rule_row.interval)
        fetch_from = min(from_, warmup_from)
        candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)
        sl_candles = _sl_candles_for(payload, rule_row, resolved, candles, fetch_from, to)
        return replay(
            lambda window: range_breakout.evaluate_range_breakout(rule, window),
            rule.breakout_period + 1,
            candles,
            _exit_config_for(payload),
            sl_candles,
            regime_indicators,
            payload.time_bucket_minutes,
        )

    if not isinstance(rule, CrossoverRuleConfig):
        raise HTTPException(status_code=422, detail=f"no backtest support for rule type {type(rule).__name__}")  # pragma: no cover
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    indicator_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    resolved = resolve_underlying(rule_row.segment, symbol)
    if resolved is None:
        raise HTTPException(status_code=502, detail=f"could not resolve underlying '{symbol}' on segment '{rule_row.segment}'")

    bar_count = max(bars_needed(rule, indicator.type, indicator_params), _regime_warmup_bars(regime_indicators))
    warmup_from, _ = history_window(bar_count, rule_row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)
    sl_candles = _sl_candles_for(payload, rule_row, resolved, candles, fetch_from, to)
    return replay(
        build_crossover_bias_fn(rule, indicator.type, indicator_params, candles),
        bars_needed(rule, indicator.type, indicator_params) + 1,
        candles,
        _exit_config_for(payload),
        sl_candles,
        regime_indicators,
        payload.time_bucket_minutes,
    )


def _backtest_one_symbol_option(
    db: Session, rule_row: db_models.Rule, rule: RuleConfig, payload: RuleBacktestRequest, symbol: str, from_: date, to: date
) -> dict:
    """Phase 4c of the options trading module (see docs/architecture.md):
    instrument_type='option' backtest - crossover-rule rules only, this
    phase's confirmed scope (breakout/range_breakout replay via functions
    that don't build a bias_fn the same way, or would need a shared
    bias_fn-builder factored out first - not done yet). Does NOT apply
    trailing-stop (documented as not-yet-extended to the option variant,
    see option_backtest.py's own module docstring) or Rule.
    regime_indicator_ids (option_backtest.py's replay_options is its own
    simulation engine with no regime hook at all - same scope boundary
    as the breakout backtest path, see _backtest_one_symbol)."""
    if not isinstance(rule, CrossoverRuleConfig):
        raise HTTPException(status_code=422, detail="option backtesting only supports crossover-rule rules today")
    if payload.option_position_style == "naked":
        # option_backtest.py's legs_for_direction is hardcoded to a
        # long+short pair (Phase 4c never anticipated a single-leg
        # style) - silently backtesting a naked strategy as a spread
        # would report wrong numbers, so this rejects explicitly rather
        # than a follow-up phase, not built yet.
        raise HTTPException(status_code=422, detail="backtesting a naked option strategy isn't supported yet")
    if payload.option_strike_moneyness != "ATM":
        # Same reasoning as the naked guard above - legs_for_direction is
        # also hardcoded to ATM ("ATM"/f"ATM+{SPREAD_WIDTH_STRIKES}"), so a
        # non-ATM primary-leg backtest would silently run against the
        # wrong strike entirely, not just the wrong leg count.
        raise HTTPException(
            status_code=422, detail="backtesting a non-ATM option_strike_moneyness strategy isn't supported yet"
        )
    if (to - from_).days > MAX_OPTION_BACKTEST_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"option backtest range too wide ({(to - from_).days} days) - max is {MAX_OPTION_BACKTEST_DAYS}",
        )

    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    indicator_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    resolved = resolve_underlying(rule_row.segment, symbol)
    if resolved is None:
        raise HTTPException(status_code=502, detail=f"could not resolve underlying '{symbol}' on segment '{rule_row.segment}'")

    bar_count = bars_needed(rule, indicator.type, indicator_params)
    warmup_from, _ = history_window(bar_count, rule_row.interval)
    fetch_from = min(from_, warmup_from)
    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)

    # WEEK for intraday/swing (nearest expiry, mirrors signal-processing's
    # choose_expiry treating anything but 'positional' as "nearest"),
    # MONTH for positional (more buffer before expiry, matching
    # choose_expiry's own MIN_POSITIONAL_DAYS_TO_EXPIRY intent - Dhan's
    # rollingoption has no "at least N days out" concept, so this is an
    # approximation, not a replay of that exact rule). `horizon` is a
    # request-time override here (Rule itself carries no horizon - that's
    # a Strategy/trading concept).
    expiry_flag = "MONTH" if payload.horizon == "positional" else "WEEK"

    # Each distinct (option_type, strike) leg is fetched at most once for
    # the whole [fetch_from, to] range, memoized here - simulate_option_trades
    # only ever slices this per trade window, never re-fetches.
    leg_cache: dict[tuple[str, str], Optional[list]] = {}

    def leg_fetcher(option_type: str, strike: str):
        key = (option_type, strike)
        if key not in leg_cache:
            leg_cache[key] = get_option_leg_history(
                resolved.chart_exchange,
                resolved.chart_symbol,
                option_type,
                strike,
                expiry_flag,
                # Dhan's rollingoption expiryCode is 1-indexed (1=nearest,
                # not 0) - passing 0 gets rejected outright ("expiryCode is
                # required", confirmed live) rather than silently treated
                # as nearest. This whole backtest path only ever wants the
                # nearest rolling contract for expiry_flag's own week/month
                # bucket (see expiry_flag's comment above), so 1 is always
                # correct here, not just a placeholder default.
                1,
                OPTION_HISTORY_INTERVAL,
                fetch_from,
                to,
            )
        return leg_cache[key]

    return replay_options(
        lambda window: evaluate(rule, indicator.type, indicator_params, window),
        bars_needed(rule, indicator.type, indicator_params) + 1,
        candles,
        expiry_flag,
        _exit_config_for(payload),
        leg_fetcher,
    )


def _backtest_pooled_symbols(
    db: Session,
    rule_row: db_models.Rule,
    rule: RuleConfig,
    payload: RuleBacktestRequest,
    symbols: list[str],
    from_: date,
    to: date,
    regime_indicators: RegimeIndicators,
) -> dict:
    """Shared by _backtest_universe and _backtest_symbol_list: runs
    _backtest_one_symbol independently against every symbol in the list
    and combines the results - total trade_count/hypothetical_pnl across
    all of them (the headline numbers), plus a by_symbol breakdown for
    drill-down. A symbol that fails to resolve (delisted, not in
    market-data's cache, ...) or whose candle history call to market-data
    itself fails (e.g. a transient 502, or a too-wide date range Dhan
    rejects - get_candle_history/get_option_leg_history in
    app/adapters/market_data/client.py raise requests.RequestException
    uncaught, unlike get_ltp/get_universe_constituents which already
    swallow it) is logged and skipped rather than failing the whole
    pooled request - same "one failure doesn't abort the batch"
    defensiveness as the live engine's own per-symbol loop (see
    app/domain/engine.py's run_live_tick)."""
    by_symbol: dict[str, dict] = {}
    skipped: list[str] = []
    for symbol in symbols:
        try:
            by_symbol[symbol] = _backtest_one_symbol(db, rule_row, rule, payload, symbol, from_, to, regime_indicators)
        except (HTTPException, requests.RequestException) as exc:
            logger.warning("skipping symbol %s (rule %s) - %s", symbol, rule_row.id, exc)
            skipped.append(symbol)

    return {
        "pooled": True,
        "trade_count": sum(r["trade_count"] for r in by_symbol.values()),
        "hypothetical_pnl": sum(r["hypothetical_pnl"] for r in by_symbol.values()),
        "constituents_tested": len(by_symbol),
        "constituents_skipped": len(skipped),
        "by_symbol": by_symbol,
    }


def _backtest_universe(
    db: Session,
    rule_row: db_models.Rule,
    rule: RuleConfig,
    payload: RuleBacktestRequest,
    from_: date,
    to: date,
    regime_indicators: RegimeIndicators,
) -> dict:
    """Pooled backtest for a universe-scoped rule - see
    _backtest_pooled_symbols for the shared pooling logic."""
    constituents = get_universe_constituents(rule_row.underlying)
    if not constituents:
        raise HTTPException(status_code=502, detail=f"could not resolve universe '{rule_row.underlying}'")
    return _backtest_pooled_symbols(db, rule_row, rule, payload, constituents, from_, to, regime_indicators)


def _backtest_symbol_list(
    db: Session,
    rule_row: db_models.Rule,
    rule: RuleConfig,
    payload: RuleBacktestRequest,
    from_: date,
    to: date,
    regime_indicators: RegimeIndicators,
) -> dict:
    """Pooled backtest for a symbol_list-scoped rule - see
    _backtest_pooled_symbols for the shared pooling logic. Unlike
    _backtest_universe, the symbol list comes from parsing
    rule_row.underlying directly (parse_symbol_list), never market-data -
    same distinction as _target_symbols in app/domain/engine.py."""
    symbols = parse_symbol_list(rule_row.underlying)
    if not symbols:
        raise HTTPException(status_code=422, detail=f"could not parse any symbols from underlying '{rule_row.underlying}'")
    return _backtest_pooled_symbols(db, rule_row, rule, payload, symbols, from_, to, regime_indicators)


def _backtest_watchlist(
    db: Session,
    rule_row: db_models.Rule,
    rule: RuleConfig,
    payload: RuleBacktestRequest,
    from_: date,
    to: date,
    regime_indicators: RegimeIndicators,
) -> dict:
    """Pooled backtest for a watchlist-scoped rule - see
    _backtest_pooled_symbols for the shared pooling logic. The symbol list
    comes from a signal_generation.watchlists row looked up by name (see
    app/domain/engine.py's resolve_watchlist_symbols, reused here) rather
    than parsing rule_row.underlying directly (unlike symbol_list) or
    calling market-data (unlike universe)."""
    symbols = resolve_watchlist_symbols(db, rule_row.underlying)
    if not symbols:
        raise HTTPException(status_code=502, detail=f"could not resolve watchlist '{rule_row.underlying}'")
    return _backtest_pooled_symbols(db, rule_row, rule, payload, symbols, from_, to, regime_indicators)


@router.post("/rules/{rule_id}/backtest")
def backtest_rule(
    rule_id: str,
    payload: RuleBacktestRequest,
    from_: date = Query(alias="from"),
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """Lightweight signal replay over [from_, to] - reuses the exact same
    rule the live engine tick runs (app/domain/rules.py), so a backtest
    and live behavior can never silently disagree. A Rule alone carries no
    exit config/instrument_type/horizon (all Strategy-owned trading
    concepts) - `payload` supplies them as optional per-run overrides;
    omitting the exit-config fields reproduces ExitConfig()'s bare
    opposite-signal/end-of-data-only defaults. underlying_type='universe',
    'symbol_list', or 'watchlist' pools the same backtest across every
    constituent/listed symbol - see _backtest_universe/_backtest_symbol_list/
    _backtest_watchlist.
    Rule.regime_indicator_ids (if any) are resolved once here and applied
    for real - see _backtest_one_symbol's own docstring for which rule
    types/instrument types that does and doesn't cover."""
    rule_row = _load_rule_for_backtest(db, rule_id)
    rule = validate_rule_config(rule_row.rule_config)
    regime_indicators = _resolve_regime_indicators(db, rule_row)

    if rule_row.underlying_type == "universe":
        return _backtest_universe(db, rule_row, rule, payload, from_, to, regime_indicators)
    if rule_row.underlying_type == "symbol_list":
        return _backtest_symbol_list(db, rule_row, rule, payload, from_, to, regime_indicators)
    if rule_row.underlying_type == "watchlist":
        return _backtest_watchlist(db, rule_row, rule, payload, from_, to, regime_indicators)
    return _backtest_one_symbol(db, rule_row, rule, payload, rule_row.underlying, from_, to, regime_indicators)


@router.post("/rules/{rule_id}/backtest/grid")
def backtest_rule_grid(
    rule_id: str,
    payload: RuleBacktestGridRequest,
    from_: date = Query(alias="from"),
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """Grid search over the rule's referenced indicator's params - runs
    the same replay() as /backtest once per combination in the cartesian
    product of payload.param_grid (any param not named there stays fixed
    at the Indicator's own current value), fetching candle history ONCE
    for the widest warm-up any combination in the grid needs rather than
    once per combination. Does NOT mutate the Indicator row - PATCH
    /indicators/{id} once you've picked a winner from the report.

    stop_loss_method='indicator' with stop_loss_indicator_param_grid set,
    OR stop_loss_method='percent' with stop_loss_percent_grid set, adds a
    SECOND, independent sweep dimension (e.g. candidate EMA periods, or
    candidate SL percentages) - every (indicator params, stop-loss value)
    pair gets its own replay run, see app/domain/backtest.py's
    grid_search. The total combination count (indicator combos x
    stop-loss combos) is capped at MAX_GRID_COMBINATIONS same as either
    dimension alone."""
    rule_row = _load_rule_for_backtest(db, rule_id)
    rule = validate_rule_config(rule_row.rule_config)
    if not isinstance(rule, CrossoverRuleConfig):
        raise HTTPException(status_code=422, detail="this operation only applies to crossover-rule rules")
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    base_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    try:
        combos = expand_grid(base_params, payload.param_grid)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    sl_combos: Optional[list[dict]] = None
    if payload.stop_loss_method == "indicator" and payload.stop_loss_indicator_param_grid:
        try:
            sl_combos = expand_stop_loss_grid(payload.stop_loss_indicator_param_grid)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        total = len(combos) * len(sl_combos)
        if total > MAX_GRID_COMBINATIONS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"grid search would run {total} combinations (indicator x stop-loss) - "
                    f"max is {MAX_GRID_COMBINATIONS}, narrow one of the grids"
                ),
            )

    # Alternative to sl_combos above, for stop_loss_method='percent' - same
    # "one fixed method per request" mutual exclusion grid_search itself
    # relies on (see its own docstring), so only one of sl_combos/
    # sl_percent_combos is ever non-None.
    sl_percent_combos: Optional[list[float]] = None
    if payload.stop_loss_method == "percent" and payload.stop_loss_percent_grid:
        sl_percent_combos = payload.stop_loss_percent_grid
        total = len(combos) * len(sl_percent_combos)
        if total > MAX_GRID_COMBINATIONS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"grid search would run {total} combinations (indicator x stop-loss) - "
                    f"max is {MAX_GRID_COMBINATIONS}, narrow one of the grids"
                ),
            )

    resolved = resolve_underlying(rule_row.segment, rule_row.underlying)
    if resolved is None:
        raise HTTPException(
            status_code=502, detail=f"could not resolve underlying '{rule_row.underlying}' on segment '{rule_row.segment}'"
        )

    regime_indicators = _resolve_regime_indicators(db, rule_row)

    # Widest warm-up across every combination in the grid, so one fetch
    # covers all of them - candidate params aren't known until expand_grid
    # runs, so this can't reuse /backtest's single bars_needed call above.
    max_bars = max(max(bars_needed(rule, indicator.type, params) for params in combos), _regime_warmup_bars(regime_indicators))
    warmup_from, _ = history_window(max_bars, rule_row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)

    # sl_candles must cover the WIDEST stop-loss indicator period across
    # the whole sweep, not just payload.stop_loss_indicator_params's own
    # value - _sl_candles_for only reads a single period, so temporarily
    # widen it for this one fetch call. Each individual replay run below
    # still uses its own sl_combo value against this same fetched series
    # (a wider-than-needed series computes a smaller-period EMA correctly
    # too, same as _indicator_stop_price already relies on).
    sl_fetch_payload = payload
    if sl_combos:
        periods = [c["period"] for c in sl_combos if "period" in c]
        if periods:
            widened = dict(payload.stop_loss_indicator_params or {})
            widened["period"] = max(periods + [widened.get("period", 0)])
            sl_fetch_payload = payload.model_copy(update={"stop_loss_indicator_params": widened})

    sl_candles = _sl_candles_for(sl_fetch_payload, rule_row, resolved, candles, fetch_from, to)
    return grid_search(
        rule,
        indicator.type,
        combos,
        candles,
        _exit_config_for(payload),
        sl_candles,
        regime_indicators,
        stop_loss_indicator_combos=sl_combos,
        stop_loss_percent_combos=sl_percent_combos,
    )

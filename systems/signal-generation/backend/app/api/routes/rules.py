import logging
import uuid
from datetime import date
from typing import Optional

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
from app.domain.backtest import ExitConfig, expand_grid, grid_search, replay
from app.domain.engine import history_window
from app.domain.option_backtest import MAX_OPTION_BACKTEST_DAYS, OPTION_HISTORY_INTERVAL, replay_options
from app.domain.rule import (
    BreakoutRuleConfig,
    CrossoverRuleConfig,
    RangeBreakoutRuleConfig,
    RuleBacktestGridRequest,
    RuleBacktestRequest,
    RuleConfig,
    RuleCreate,
    RuleOut,
    RuleUpdate,
    validate_breakout_interval_consistency,
    validate_indicator_params,
    validate_rule_config,
    validate_rule_in_house_fields,
    validate_rule_universe_fields,
)
from app.domain.rules import bars_needed, evaluate

logger = logging.getLogger(__name__)
router = APIRouter()


def _to_out(row: db_models.Rule) -> RuleOut:
    return RuleOut(
        id=str(row.id),
        name=row.name,
        description=row.description,
        source_type=row.source_type,
        provider_rule_name=row.provider_rule_name,
        segment=row.segment,
        underlying=row.underlying,
        underlying_type=row.underlying_type,
        interval=row.interval,
        rule_config=row.rule_config,
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
    check."""
    if rule_config is None:
        return
    rule = validate_rule_config(rule_config)
    if not isinstance(rule, CrossoverRuleConfig):
        return
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")


@router.post("/rules", response_model=RuleOut, status_code=201)
def create_rule(payload: RuleCreate, db: Session = Depends(get_db)):
    _check_referenced_indicator_exists(db, payload.rule_config)
    row = db_models.Rule(
        name=payload.name,
        description=payload.description,
        source_type=payload.source_type,
        provider_rule_name=payload.provider_rule_name,
        segment=payload.segment,
        underlying=payload.underlying,
        underlying_type=payload.underlying_type,
        interval=payload.interval,
        rule_config=payload.rule_config,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("/rules", response_model=list[RuleOut])
def list_rules(source_type: str | None = None, db: Session = Depends(get_db)):
    q = db.query(db_models.Rule)
    if source_type:
        q = q.filter_by(source_type=source_type)
    rows = q.order_by(db_models.Rule.created_at.desc()).all()
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
    """source_type isn't patchable (fixed at create, same reasoning as
    Strategy.source_type - see app/domain/models.py's
    validate_rule_link_consistency, checked wherever a Strategy links to
    this Rule, not here)."""
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
    if payload.provider_rule_name is not None:
        row.provider_rule_name = payload.provider_rule_name
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

    try:
        validate_rule_in_house_fields(row.source_type, row.underlying, row.rule_config, row.interval)
        validate_rule_universe_fields(row.underlying_type, row.segment)
        validate_breakout_interval_consistency(row.interval, row.rule_config)
        if row.source_type == "in_house" and row.provider_rule_name is not None:
            raise ValueError("provider_rule_name only applies to source_type != 'in_house'")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _check_referenced_indicator_exists(db, row.rule_config)

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
    if row.source_type != "in_house":
        raise HTTPException(status_code=422, detail="backtesting only applies to source_type='in_house' rules")
    return row


def _exit_config_for(payload) -> ExitConfig:
    """Builds simulate_trades' ExitConfig from the backtest request's own
    optional overrides - a Rule alone carries no exit config (that's
    Strategy-owned). Omitting every field reproduces ExitConfig()'s bare
    defaults: opposite-signal/end-of-data exits only. Accepts either
    RuleBacktestRequest or RuleBacktestGridRequest - both expose the same
    5 field names."""
    return ExitConfig(
        stop_loss_method=payload.stop_loss_method,
        stop_loss_percent=payload.stop_loss_percent,
        target_percent=payload.target_percent,
        trailing_stop_enabled=payload.trailing_stop_enabled,
        square_off_time=payload.square_off_time,
    )


def _sl_candles_for(payload, rule_row: db_models.Rule, resolved, candles: list, fetch_from: date, to: date) -> Optional[list]:
    """Only stop_loss_method='previous_candle' needs a second candle
    series (at the request's own stop_loss_interval, which can differ
    from the rule's main `interval`) - reuses the already-fetched
    `candles` outright when the two intervals match, so the common case
    costs no extra market-data call."""
    if payload.stop_loss_method != "previous_candle" or not payload.stop_loss_interval:
        return None
    if payload.stop_loss_interval == rule_row.interval:
        return candles
    return get_candle_history(resolved.chart_exchange, resolved.chart_symbol, payload.stop_loss_interval, fetch_from, to)


def _backtest_one_symbol(
    db: Session, rule_row: db_models.Rule, rule: RuleConfig, payload: RuleBacktestRequest, symbol: str, from_: date, to: date
) -> dict:
    """The actual single-symbol backtest, shared by the plain (one
    underlying) and universe (many constituents, see _backtest_universe)
    paths - `symbol` is the traded symbol to run against, not necessarily
    rule_row.underlying itself (a universe rule passes each constituent
    through here in turn). Regime filtering (Strategy-only - gates a
    signal on top of the rule's own raw output) is never applied here,
    since there's no Strategy in this path - always run as if
    regime_filter_enabled=False."""
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
        warmup_from, _ = history_window(range_breakout.range_breakout_warmup(rule), rule_row.interval)
        fetch_from = min(from_, warmup_from)
        candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)
        sl_candles = _sl_candles_for(payload, rule_row, resolved, candles, fetch_from, to)
        return replay(
            lambda window: range_breakout.evaluate_range_breakout(rule, window),
            rule.breakout_period + 1,
            candles,
            _exit_config_for(payload),
            sl_candles,
            False,
            frozenset(),
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

    bar_count = bars_needed(rule, indicator.type, indicator_params)
    warmup_from, _ = history_window(bar_count, rule_row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)
    sl_candles = _sl_candles_for(payload, rule_row, resolved, candles, fetch_from, to)
    return replay(
        lambda window: evaluate(rule, indicator.type, indicator_params, window),
        bars_needed(rule, indicator.type, indicator_params) + 1,
        candles,
        _exit_config_for(payload),
        sl_candles,
        False,
        frozenset(),
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
    see option_backtest.py's own module docstring) or the regime filter
    (Strategy-only, never applies to a Rule-scoped backtest)."""
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
                0,
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


def _backtest_universe(db: Session, rule_row: db_models.Rule, rule: RuleConfig, payload: RuleBacktestRequest, from_: date, to: date) -> dict:
    """Pooled backtest for a universe-scoped rule: runs _backtest_one_symbol
    independently against every constituent and combines the results -
    total trade_count/hypothetical_pnl across all of them (the headline
    numbers), plus a by_symbol breakdown for drill-down. A constituent
    that fails to resolve (delisted, not in market-data's cache, ...) is
    logged and skipped rather than failing the whole pooled request - same
    "one failure doesn't abort the batch" defensiveness as the live
    engine's own per-constituent loop (see app/domain/engine.py's
    run_live_tick)."""
    constituents = get_universe_constituents(rule_row.underlying)
    if not constituents:
        raise HTTPException(status_code=502, detail=f"could not resolve universe '{rule_row.underlying}'")

    by_symbol: dict[str, dict] = {}
    skipped: list[str] = []
    for symbol in constituents:
        try:
            by_symbol[symbol] = _backtest_one_symbol(db, rule_row, rule, payload, symbol, from_, to)
        except HTTPException:
            logger.warning("skipping unresolvable universe constituent %s (rule %s)", symbol, rule_row.id)
            skipped.append(symbol)

    return {
        "pooled": True,
        "trade_count": sum(r["trade_count"] for r in by_symbol.values()),
        "hypothetical_pnl": sum(r["hypothetical_pnl"] for r in by_symbol.values()),
        "constituents_tested": len(by_symbol),
        "constituents_skipped": len(skipped),
        "by_symbol": by_symbol,
    }


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
    opposite-signal/end-of-data-only defaults. Only meaningful for an
    in_house rule. underlying_type='universe' pools the same backtest
    across every constituent - see _backtest_universe."""
    rule_row = _load_rule_for_backtest(db, rule_id)
    rule = validate_rule_config(rule_row.rule_config)

    if rule_row.underlying_type == "universe":
        return _backtest_universe(db, rule_row, rule, payload, from_, to)
    return _backtest_one_symbol(db, rule_row, rule, payload, rule_row.underlying, from_, to)


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
    /indicators/{id} once you've picked a winner from the report."""
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

    resolved = resolve_underlying(rule_row.segment, rule_row.underlying)
    if resolved is None:
        raise HTTPException(
            status_code=502, detail=f"could not resolve underlying '{rule_row.underlying}' on segment '{rule_row.segment}'"
        )

    # Widest warm-up across every combination in the grid, so one fetch
    # covers all of them - candidate params aren't known until expand_grid
    # runs, so this can't reuse /backtest's single bars_needed call above.
    max_bars = max(bars_needed(rule, indicator.type, params) for params in combos)
    warmup_from, _ = history_window(max_bars, rule_row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, rule_row.interval, fetch_from, to)
    sl_candles = _sl_candles_for(payload, rule_row, resolved, candles, fetch_from, to)
    return grid_search(
        rule,
        indicator.type,
        combos,
        candles,
        _exit_config_for(payload),
        sl_candles,
        False,
        frozenset(),
    )

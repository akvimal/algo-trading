import uuid
from datetime import date
from typing import Optional, get_args

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.market_data.client import get_candle_history, resolve_underlying
from app.domain import breakout, range_breakout, regime
from app.domain.backtest import ExitConfig, expand_grid, grid_search, replay
from app.domain.engine import history_window
from app.domain.models import (
    BacktestGridRequest,
    BreakoutRuleConfig,
    CrossoverRuleConfig,
    RangeBreakoutRuleConfig,
    RuleConfig,
    StopLossInterval,
    StrategyCreate,
    StrategyOut,
    StrategyUpdate,
    validate_in_house_fields,
    validate_indicator_params,
    validate_rule_config,
    validate_stop_loss_fields,
    validate_underlying_type_fields,
)
from app.domain.rules import bars_needed, evaluate

router = APIRouter()


def _to_out(row: db_models.Strategy) -> StrategyOut:
    return StrategyOut(
        id=str(row.id),
        name=row.name,
        source_type=row.source_type,
        exchange=row.exchange,
        horizon=row.horizon,
        instrument_type=row.instrument_type,
        interval=row.interval,
        stop_loss_method=row.stop_loss_method,
        stop_loss_interval=row.stop_loss_interval,
        stop_loss_percent=float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        target_percent=float(row.target_percent) if row.target_percent is not None else None,
        trailing_stop_enabled=row.trailing_stop_enabled,
        segment=row.segment,
        square_off_time=row.square_off_time,
        underlying=row.underlying,
        underlying_type=row.underlying_type,
        rule_config=row.rule_config,
        regime_filter_enabled=row.regime_filter_enabled,
        regime_filter_checks=row.regime_filter_checks,
        duplicate_signal_policy=row.duplicate_signal_policy,
        counter_signal_policy=row.counter_signal_policy,
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _check_referenced_indicator_exists(db: Session, rule_config: dict | None) -> None:
    """CrossoverRuleConfig strategies must reference a real Indicator at
    create/update time - validate_rule_config only checks rule_config's
    shape, not that indicator_id resolves to anything (that needs a DB
    session). The engine's own defensive skip (app/domain/engine.py) is a
    second, later line of defense for an indicator deleted *after* a
    strategy already referenced it, not this primary check.
    BreakoutRuleConfig has no indicator_id at all - nothing to check."""
    if rule_config is None:
        return
    rule = validate_rule_config(rule_config)
    if not isinstance(rule, CrossoverRuleConfig):
        return
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")


def _breakout_stop_loss_fields(rule: BreakoutRuleConfig, interval: Optional[str]) -> tuple[str, str]:
    """A breakout strategy owns its own stop-loss scheme rather than
    accepting whatever stop_loss_method/interval was passed - the initial
    stop is enforced live by reusing execution's existing
    `previous_candle` mechanism with stop_loss_interval set to this
    rule's own htf_interval (see app/domain/breakout.py's module
    docstring on the live enforcement gap). Validates (422 if not):
    `interval` (the Strategy's own column) matches the rule's
    ltf_interval, and htf_interval is one of execution's supported
    stop-loss intervals - otherwise this strategy could never actually be
    supported live, even with the reversal-exit gap accepted. Returns
    (stop_loss_method, stop_loss_interval) to set on the row."""
    if interval != rule.ltf_interval:
        raise HTTPException(
            status_code=422, detail="interval must equal rule_config.ltf_interval for a breakout strategy"
        )
    if rule.htf_interval not in get_args(StopLossInterval):
        raise HTTPException(
            status_code=422,
            detail=(
                f"htf_interval '{rule.htf_interval}' isn't one of execution's supported stop-loss intervals "
                f"({', '.join(get_args(StopLossInterval))}) - required so the initial stop-loss can be enforced live"
            ),
        )
    return "previous_candle", rule.htf_interval


@router.post("/strategies", response_model=StrategyOut, status_code=201)
def create_strategy(payload: StrategyCreate, db: Session = Depends(get_db)):
    _check_referenced_indicator_exists(db, payload.rule_config)

    stop_loss_method = payload.stop_loss_method
    stop_loss_interval = payload.stop_loss_interval
    stop_loss_percent = payload.stop_loss_percent
    trailing_stop_enabled = payload.trailing_stop_enabled
    if payload.rule_config is not None:
        rule = validate_rule_config(payload.rule_config)
        if isinstance(rule, BreakoutRuleConfig):
            stop_loss_method, stop_loss_interval = _breakout_stop_loss_fields(rule, payload.interval)
            stop_loss_percent = None
            trailing_stop_enabled = False

    row = db_models.Strategy(
        name=payload.name,
        source_type=payload.source_type,
        exchange=payload.exchange,
        horizon=payload.horizon,
        instrument_type=payload.instrument_type,
        interval=payload.interval,
        stop_loss_method=stop_loss_method,
        stop_loss_interval=stop_loss_interval,
        stop_loss_percent=stop_loss_percent,
        target_percent=payload.target_percent,
        trailing_stop_enabled=trailing_stop_enabled,
        segment=payload.segment,
        square_off_time=payload.square_off_time,
        underlying=payload.underlying,
        underlying_type=payload.underlying_type,
        rule_config=payload.rule_config,
        regime_filter_enabled=payload.regime_filter_enabled,
        regime_filter_checks=payload.regime_filter_checks,
        duplicate_signal_policy=payload.duplicate_signal_policy,
        counter_signal_policy=payload.counter_signal_policy,
        status="draft",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/strategies/{strategy_id}", status_code=204)
def delete_strategy(strategy_id: str, db: Session = Depends(get_db)):
    """Hard delete - historical signals/positions elsewhere keep their
    strategy_id as a plain reference (no cross-schema FK, see
    docs/architecture.md), so this doesn't break past records, only stops
    the strategy from resolving any *new* signal."""
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")

    row = db.get(db_models.Strategy, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="strategy not found")

    db.delete(row)
    db.commit()


@router.get("/strategies", response_model=list[StrategyOut])
def list_strategies(source_type: str | None = None, db: Session = Depends(get_db)):
    q = db.query(db_models.Strategy)
    if source_type:
        q = q.filter_by(source_type=source_type)
    rows = q.order_by(db_models.Strategy.created_at.desc()).all()
    return [_to_out(r) for r in rows]


@router.get("/strategies/{strategy_id}", response_model=StrategyOut)
def get_strategy(strategy_id: str, db: Session = Depends(get_db)):
    """Called by signal-processing during resolution, and by the frontend
    to display a single strategy's config/webhook URLs."""
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")

    row = db.get(db_models.Strategy, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="strategy not found")
    return _to_out(row)


@router.patch("/strategies/{strategy_id}", response_model=StrategyOut)
def update_strategy(strategy_id: str, payload: StrategyUpdate, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")

    row = db.get(db_models.Strategy, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="strategy not found")

    if payload.name is not None:
        row.name = payload.name
    if payload.status is not None:
        row.status = payload.status
    if payload.horizon is not None:
        row.horizon = payload.horizon
    if payload.instrument_type is not None:
        row.instrument_type = payload.instrument_type
    if payload.interval is not None:
        row.interval = payload.interval

    if payload.stop_loss_method is not None:
        # Method is the complete replacement pair for interval/percent -
        # explicitly clears whichever one the new method doesn't use, so
        # switching methods in one PATCH never leaves a stale value from
        # the old method behind.
        row.stop_loss_method = payload.stop_loss_method
        row.stop_loss_interval = payload.stop_loss_interval
        row.stop_loss_percent = payload.stop_loss_percent
    else:
        if payload.stop_loss_interval is not None:
            row.stop_loss_interval = payload.stop_loss_interval
        if payload.stop_loss_percent is not None:
            row.stop_loss_percent = payload.stop_loss_percent
    if payload.target_percent is not None:
        row.target_percent = payload.target_percent
    if payload.trailing_stop_enabled is not None:
        row.trailing_stop_enabled = payload.trailing_stop_enabled
    if payload.segment is not None:
        row.segment = payload.segment
    if payload.square_off_time is not None:
        row.square_off_time = payload.square_off_time
    if payload.underlying is not None:
        row.underlying = payload.underlying
    if payload.underlying_type is not None:
        row.underlying_type = payload.underlying_type
    if payload.rule_config is not None:
        row.rule_config = payload.rule_config
    if payload.regime_filter_enabled is not None:
        row.regime_filter_enabled = payload.regime_filter_enabled
    if payload.regime_filter_checks is not None:
        row.regime_filter_checks = payload.regime_filter_checks
    if payload.duplicate_signal_policy is not None:
        row.duplicate_signal_policy = payload.duplicate_signal_policy
    if payload.counter_signal_policy is not None:
        row.counter_signal_policy = payload.counter_signal_policy

    try:
        validate_stop_loss_fields(
            row.stop_loss_method,
            row.stop_loss_interval,
            float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
            row.trailing_stop_enabled,
        )
        # source_type itself isn't patchable (fixed at create), so this
        # re-validates the merged row's underlying/rule_config/interval
        # against whichever source_type it already has.
        validate_in_house_fields(row.source_type, row.underlying, row.rule_config, row.interval)
        validate_underlying_type_fields(row.underlying_type, row.segment, row.instrument_type)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _check_referenced_indicator_exists(db, row.rule_config)

    # Re-derive (and re-apply) the breakout SL scheme unconditionally on
    # every PATCH to a breakout strategy - not just when this particular
    # PATCH touched rule_config/interval - so the invariant always holds,
    # and a caller trying to PATCH stop_loss_method away from
    # 'previous_candle' on a breakout strategy gets overridden back
    # rather than silently accepted.
    if row.rule_config is not None:
        rule = validate_rule_config(row.rule_config)
        if isinstance(rule, BreakoutRuleConfig):
            row.stop_loss_method, row.stop_loss_interval = _breakout_stop_loss_fields(rule, row.interval)
            row.stop_loss_percent = None
            row.trailing_stop_enabled = False

    db.commit()
    db.refresh(row)
    return _to_out(row)


def _load_strategy_and_rule(db: Session, strategy_id: str) -> tuple[db_models.Strategy, RuleConfig]:
    """Shared prefix for both /backtest and /backtest/grid: resolve the
    strategy and its rule, whichever rule type it is. Raises the same
    HTTPExceptions either route would raise on its own."""
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")

    row = db.get(db_models.Strategy, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="strategy not found")
    if row.source_type != "in_house":
        raise HTTPException(status_code=422, detail="backtesting only applies to source_type='in_house' strategies")

    rule = validate_rule_config(row.rule_config)
    return row, rule


def _load_backtest_context(db: Session, strategy_id: str) -> tuple[db_models.Strategy, CrossoverRuleConfig, db_models.Indicator]:
    """Crossover-only: also resolves the Indicator the rule references -
    422s for a breakout-rule strategy (grid search is crossover-only, see
    backtest_strategy_grid)."""
    row, rule = _load_strategy_and_rule(db, strategy_id)
    if not isinstance(rule, CrossoverRuleConfig):
        raise HTTPException(status_code=422, detail="this operation only applies to crossover-rule strategies")
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    return row, rule, indicator


def _exit_config_for(row: db_models.Strategy) -> ExitConfig:
    """Builds simulate_trades' ExitConfig straight from the strategy's own
    stop-loss/target/square-off fields - whatever /backtest reports is
    exactly what the strategy is actually configured to do if promoted to
    live, per app/domain/backtest.py's simulate_trades."""
    return ExitConfig(
        stop_loss_method=row.stop_loss_method,
        stop_loss_percent=float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        target_percent=float(row.target_percent) if row.target_percent is not None else None,
        trailing_stop_enabled=row.trailing_stop_enabled,
        square_off_time=row.square_off_time,
    )


def _regime_checks_for(row: db_models.Strategy) -> frozenset:
    """Which of regime.REGIME_CHECK_NAMES this strategy requires - the
    stored JSONB list, as a frozenset for regime.direction_confirmed.
    Only meaningful when row.regime_filter_enabled."""
    return frozenset(row.regime_filter_checks)


def _sl_candles_for(row: db_models.Strategy, resolved, candles: list, fetch_from: date, to: date) -> Optional[list]:
    """Only stop_loss_method='previous_candle' needs a second candle
    series (at the strategy's own stop_loss_interval, which can differ
    from its main `interval`) - reuses the already-fetched `candles`
    outright when the two intervals match, so the common case costs no
    extra market-data call."""
    if row.stop_loss_method != "previous_candle" or not row.stop_loss_interval:
        return None
    if row.stop_loss_interval == row.interval:
        return candles
    return get_candle_history(resolved.chart_exchange, resolved.chart_symbol, row.stop_loss_interval, fetch_from, to)


@router.post("/strategies/{strategy_id}/backtest")
def backtest_strategy(
    strategy_id: str,
    from_: date = Query(alias="from"),
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """Lightweight signal replay over [from_, to] - reuses the exact same
    rule the live engine tick runs (app/domain/rules.py), so a backtest
    and live behavior can never silently disagree. Simulates the
    strategy's own stop-loss/target/square-off configuration (whatever is
    unset simply doesn't create that exit condition) - see
    app/domain/backtest.py's simulate_trades for exactly how. Only
    meaningful for an in_house strategy; does not require
    status='backtesting' (you can backtest a live or draft strategy too),
    and never changes the strategy's status - promote it manually via
    PATCH after reviewing the report."""
    row, rule = _load_strategy_and_rule(db, strategy_id)

    if isinstance(rule, BreakoutRuleConfig):
        resolved = resolve_underlying(row.segment, row.underlying)
        if resolved is None:
            raise HTTPException(
                status_code=502, detail=f"could not resolve underlying '{row.underlying}' on segment '{row.segment}'"
            )
        htf_bars, ltf_bars = breakout.breakout_warmup(rule)
        htf_warmup_from, _ = history_window(htf_bars, rule.htf_interval)
        ltf_warmup_from, _ = history_window(ltf_bars, rule.ltf_interval)
        htf_candles = get_candle_history(
            resolved.chart_exchange, resolved.chart_symbol, rule.htf_interval, min(from_, htf_warmup_from), to
        )
        ltf_candles = get_candle_history(
            resolved.chart_exchange, resolved.chart_symbol, rule.ltf_interval, min(from_, ltf_warmup_from), to
        )
        return breakout.replay_breakout(rule, htf_candles, ltf_candles, row.square_off_time)

    if isinstance(rule, RangeBreakoutRuleConfig):
        resolved = resolve_underlying(row.segment, row.underlying)
        if resolved is None:
            raise HTTPException(
                status_code=502, detail=f"could not resolve underlying '{row.underlying}' on segment '{row.segment}'"
            )
        warmup_from, _ = history_window(range_breakout.range_breakout_warmup(rule), row.interval)
        fetch_from = min(from_, warmup_from)
        candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, row.interval, fetch_from, to)
        sl_candles = _sl_candles_for(row, resolved, candles, fetch_from, to)
        return replay(
            lambda window: range_breakout.evaluate_range_breakout(rule, window),
            # The rule's own tight minimum (matches evaluate_range_breakout's
            # own len(candles) > breakout_period guard) - NOT
            # range_breakout_warmup's more generous fetch-width padding
            # (used above for how far back to fetch, a separate concern).
            rule.breakout_period + 1,
            candles,
            _exit_config_for(row),
            sl_candles,
            row.regime_filter_enabled,
            _regime_checks_for(row),
        )

    if not isinstance(rule, CrossoverRuleConfig):
        raise HTTPException(status_code=422, detail=f"no backtest support for rule type {type(rule).__name__}")  # pragma: no cover
    indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
    if indicator is None:
        raise HTTPException(status_code=422, detail=f"no indicator with id '{rule.indicator_id}'")
    indicator_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    resolved = resolve_underlying(row.segment, row.underlying)
    if resolved is None:
        raise HTTPException(
            status_code=502, detail=f"could not resolve underlying '{row.underlying}' on segment '{row.segment}'"
        )

    # Fetch a bit further back than `from_` so the indicator (and, if
    # enabled, the regime classifier) is already warmed up right at the
    # start of the range the caller actually asked about - same reasoning
    # as the live engine's own history_window.
    bar_count = bars_needed(rule, indicator.type, indicator_params)
    if row.regime_filter_enabled:
        bar_count = max(bar_count, regime.regime_warmup(regime.DEFAULT_REGIME_PARAMS))
    warmup_from, _ = history_window(bar_count, row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, row.interval, fetch_from, to)
    sl_candles = _sl_candles_for(row, resolved, candles, fetch_from, to)
    return replay(
        lambda window: evaluate(rule, indicator.type, indicator_params, window),
        # Matches what simulate_trades computed internally before this was
        # generalized - the rule's own warm-up only, NOT bar_count above
        # (which may be regime-inflated for the *fetch* width - a separate
        # concern from how many bars the rule itself needs before scanning).
        bars_needed(rule, indicator.type, indicator_params) + 1,
        candles,
        _exit_config_for(row),
        sl_candles,
        row.regime_filter_enabled,
        _regime_checks_for(row),
    )


@router.post("/strategies/{strategy_id}/backtest/grid")
def backtest_strategy_grid(
    strategy_id: str,
    payload: BacktestGridRequest,
    from_: date = Query(alias="from"),
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """Grid search over the strategy's referenced indicator's params -
    runs the same replay() as /backtest once per combination in the
    cartesian product of payload.param_grid (any param not named there
    stays fixed at the Indicator's own current value), fetching candle
    history ONCE for the widest warm-up any combination in the grid needs
    rather than once per combination. Does NOT mutate the Indicator row -
    PATCH /indicators/{id} once you've picked a winner from the report."""
    row, rule, indicator = _load_backtest_context(db, strategy_id)
    base_params = validate_indicator_params(indicator.type, indicator.params).model_dump()

    try:
        combos = expand_grid(base_params, payload.param_grid)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    resolved = resolve_underlying(row.segment, row.underlying)
    if resolved is None:
        raise HTTPException(
            status_code=502, detail=f"could not resolve underlying '{row.underlying}' on segment '{row.segment}'"
        )

    # Widest warm-up across every combination in the grid, so one fetch
    # covers all of them - candidate params aren't known until expand_grid
    # runs, so this can't reuse /backtest's single bars_needed call above.
    max_bars = max(bars_needed(rule, indicator.type, params) for params in combos)
    if row.regime_filter_enabled:
        max_bars = max(max_bars, regime.regime_warmup(regime.DEFAULT_REGIME_PARAMS))
    warmup_from, _ = history_window(max_bars, row.interval)
    fetch_from = min(from_, warmup_from)

    candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, row.interval, fetch_from, to)
    sl_candles = _sl_candles_for(row, resolved, candles, fetch_from, to)
    return grid_search(
        rule,
        indicator.type,
        combos,
        candles,
        _exit_config_for(row),
        sl_candles,
        row.regime_filter_enabled,
        _regime_checks_for(row),
    )

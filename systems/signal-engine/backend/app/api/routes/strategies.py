import logging
import uuid
from datetime import date, datetime
from typing import Optional, get_args

import requests
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db import processing_models
from app.adapters.db.session import get_db
from app.adapters.market_data.client import get_candle_history, resolve_underlying
from app.auth import get_optional_user_id
from app.domain.generation.backtest import expand_stop_loss_grid, max_drawdown, win_rate
from app.domain.generation.engine import history_window
from app.domain.generation.external_backtest import (
    build_exit_config,
    expand_exit_grid,
    grid_search_external_signals,
    simulate_external_signals_by_symbol,
)
from app.domain.generation.external_backtest_models import (
    ExternalBacktestRequest,
    ExternalBacktestResponse,
    ExternalBacktestSkippedSymbol,
    ExternalBacktestTrade,
    ExternalBacktestTradeRequest,
    ExternalBacktestTradeResponse,
)
from app.domain.generation.models import (
    StopLossInterval,
    StrategyCreate,
    StrategyOut,
    StrategyUpdate,
    validate_active_weekdays,
    validate_active_windows,
    validate_contract_day_filter_fields,
    validate_exit_condition,
    validate_segment_instrument_type,
    validate_stop_loss_fields,
)
from app.domain.generation.rule import BreakoutRuleConfig, Condition, CrossoverRuleConfig, RuleSummary, validate_rule_config

router = APIRouter()
logger = logging.getLogger(__name__)


def _last_scan_at(db: Session, strategy_id: uuid.UUID) -> Optional[datetime]:
    """MAX(engine_runs.last_checked_at) across every symbol this one
    strategy scans - see StrategyOut.last_scan_at's own docstring. Single-
    strategy lookup, used by GET /strategies/{id} - list_strategies below
    does the batched equivalent in one query instead of N of these."""
    return db.query(func.max(db_models.EngineRun.last_checked_at)).filter(
        db_models.EngineRun.strategy_id == strategy_id
    ).scalar()


def _last_signal_at(db: Session, strategy_id: uuid.UUID) -> Optional[datetime]:
    """MAX(signal_processing.signals.received_at) for one strategy - see
    StrategyOut.last_signal_at's own docstring. Single-strategy lookup,
    used by GET /strategies/{id} - list_strategies below does the batched
    equivalent in one query instead of N of these. Cross-schema (signals
    lives in signal_processing, Strategy in signal_generation) but both
    are owned by this same signal-engine backend/DB since the 2026-08-28
    merge - not a systems/* boundary crossing."""
    return db.query(func.max(processing_models.Signal.received_at)).filter(
        processing_models.Signal.strategy_id == strategy_id
    ).scalar()


def _to_out(
    row: db_models.Strategy,
    rule_row: Optional[db_models.Rule],
    last_scan_at: Optional[datetime] = None,
    last_signal_at: Optional[datetime] = None,
) -> StrategyOut:
    return StrategyOut(
        id=str(row.id),
        name=row.name,
        source_type=row.source_type,
        source_rule_name=row.source_rule_name,
        exchange=row.exchange,
        horizon=row.horizon,
        instrument_type=row.instrument_type,
        rule_id=str(row.rule_id) if row.rule_id is not None else None,
        rule=RuleSummary(id=str(rule_row.id), name=rule_row.name, segment=rule_row.segment) if rule_row is not None else None,
        created_by=str(row.created_by) if row.created_by is not None else None,
        stop_loss_method=row.stop_loss_method,
        stop_loss_interval=row.stop_loss_interval,
        stop_loss_percent=float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        stop_loss_indicator_type=row.stop_loss_indicator_type,
        stop_loss_indicator_params=row.stop_loss_indicator_params,
        target_percent=float(row.target_percent) if row.target_percent is not None else None,
        trailing_stop_enabled=row.trailing_stop_enabled,
        exit_condition=row.exit_condition,
        option_position_style=row.option_position_style,
        option_strike_moneyness=row.option_strike_moneyness,
        option_sl_scope=row.option_sl_scope,
        fixed_lots=row.fixed_lots,
        use_margin=row.use_margin,
        contract_day_filter=row.contract_day_filter,
        segment=row.segment,
        duplicate_signal_policy=row.duplicate_signal_policy,
        counter_signal_policy=row.counter_signal_policy,
        active_windows=row.active_windows,
        active_weekdays=row.active_weekdays,
        status=row.status,
        last_scan_at=last_scan_at,
        last_signal_at=last_signal_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _load_rule_or_404(db: Session, rule_id: str) -> db_models.Rule:
    try:
        parsed_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db.get(db_models.Rule, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return row


def _stop_loss_fields_for_rule(
    db: Session,
    rule_row: Optional[db_models.Rule],
    stop_loss_method: Optional[str],
    stop_loss_interval: Optional[str],
    stop_loss_percent: Optional[float],
    trailing_stop_enabled: bool,
    stop_loss_indicator_type: Optional[str] = None,
    stop_loss_indicator_params: Optional[dict] = None,
) -> tuple[Optional[str], Optional[str], Optional[float], bool, Optional[str], Optional[dict]]:
    """A strategy linked to a breakout rule owns its own stop-loss scheme
    rather than accepting whatever stop_loss_method/interval was
    requested - the initial stop is enforced live by reusing execution's
    existing `previous_candle` mechanism with stop_loss_interval set to
    the rule's own ltf_interval (see app/domain/breakout.py's module
    docstring on the live enforcement gap) - HTF only ever arms the setup,
    entry and the stop are both entirely LTF-derived, so live enforcement
    must read the LTF series too, not HTF. Validates (422 if not) that
    ltf_interval is one of execution's supported stop-loss intervals -
    otherwise this strategy could never actually be supported live, even
    with the reversal-exit gap accepted. This forces the SL scheme
    unconditionally, even over an explicitly-requested one - see
    update_strategy's own comment on why breakout is special that way.

    A strategy linked to a SuperTrend-backed crossover rule instead gets a
    soft default (added 2026-08-21, see docs/architecture.md): if the
    caller left stop_loss_method unset entirely, default to trailing off
    the SAME SuperTrend line the crossover itself watches (period/
    multiplier copied from the rule's own referenced Indicator row) -
    "enter on the ST flip, protect with the ST line" is the standard way
    this indicator is used, so a strategy shouldn't have to spell out
    method='indicator'/indicator_type='supertrend'/trailing_stop_enabled=
    True by hand every time. Unlike breakout above, this NEVER overrides
    an explicitly-requested stop_loss_method - a caller that wants percent/
    previous_candle/a different indicator on a SuperTrend-crossover
    strategy still gets exactly that. Skipped (falls through to the
    explicit fields unchanged, i.e. no stop-loss at all) if the rule's own
    interval is 'daily' - not one of execution's supported stop-loss
    intervals, so silently defaulting into an unusable strategy would be
    worse than requiring the caller to pick something else explicitly.

    `rule_row` is None for an external strategy (no Rule at all) - passes
    fields through unchanged, same as any other non-breakout,
    non-SuperTrend-crossover rule."""
    if rule_row is not None and rule_row.rule_config is not None:
        rule = validate_rule_config(rule_row.rule_config)
        if isinstance(rule, BreakoutRuleConfig):
            if rule.ltf_interval not in get_args(StopLossInterval):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"ltf_interval '{rule.ltf_interval}' isn't one of execution's supported stop-loss intervals "
                        f"({', '.join(get_args(StopLossInterval))}) - required so the initial stop-loss can be enforced live"
                    ),
                )
            return "previous_candle", rule.ltf_interval, None, False, None, None
        if (
            isinstance(rule, CrossoverRuleConfig)
            and stop_loss_method is None
            and rule_row.interval in get_args(StopLossInterval)
        ):
            indicator = db.get(db_models.Indicator, uuid.UUID(rule.indicator_id))
            if indicator is not None and indicator.type == "supertrend":
                return "indicator", rule_row.interval, None, True, "supertrend", dict(indicator.params)
    return stop_loss_method, stop_loss_interval, stop_loss_percent, trailing_stop_enabled, stop_loss_indicator_type, stop_loss_indicator_params


@router.post("/strategies", response_model=StrategyOut, status_code=201)
def create_strategy(
    payload: StrategyCreate,
    db: Session = Depends(get_db),
    created_by: Optional[uuid.UUID] = Depends(get_optional_user_id),
):
    # payload.rule_id is required iff source_type=='in_house' (enforced by
    # StrategyCreate's own validator) - external strategies carry no Rule.
    rule_row = _load_rule_or_404(db, payload.rule_id) if payload.rule_id is not None else None

    stop_loss_method, stop_loss_interval, stop_loss_percent, trailing_stop_enabled, stop_loss_indicator_type, stop_loss_indicator_params = (
        _stop_loss_fields_for_rule(
            db,
            rule_row,
            payload.stop_loss_method,
            payload.stop_loss_interval,
            payload.stop_loss_percent,
            payload.trailing_stop_enabled,
            payload.stop_loss_indicator_type,
            payload.stop_loss_indicator_params,
        )
    )

    row = db_models.Strategy(
        name=payload.name,
        source_type=payload.source_type,
        source_rule_name=payload.source_rule_name,
        exchange=payload.exchange,
        horizon=payload.horizon,
        instrument_type=payload.instrument_type,
        rule_id=rule_row.id if rule_row is not None else None,
        created_by=created_by,
        stop_loss_method=stop_loss_method,
        stop_loss_interval=stop_loss_interval,
        stop_loss_percent=stop_loss_percent,
        stop_loss_indicator_type=stop_loss_indicator_type,
        stop_loss_indicator_params=stop_loss_indicator_params,
        target_percent=payload.target_percent,
        trailing_stop_enabled=trailing_stop_enabled,
        exit_condition=payload.exit_condition.model_dump(mode="json") if payload.exit_condition is not None else None,
        option_position_style=payload.option_position_style,
        option_strike_moneyness=payload.option_strike_moneyness,
        option_sl_scope=payload.option_sl_scope,
        fixed_lots=payload.fixed_lots,
        use_margin=payload.use_margin,
        contract_day_filter=payload.contract_day_filter,
        segment=payload.segment,
        duplicate_signal_policy=payload.duplicate_signal_policy,
        counter_signal_policy=payload.counter_signal_policy,
        active_windows=[w.model_dump(mode="json") for w in payload.active_windows],
        active_weekdays=list(payload.active_weekdays),
        status="draft",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row, rule_row)


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
    # outerjoin, not join - an external strategy has no rule_id at all, an
    # inner join would silently drop every one of them from this list.
    q = db.query(db_models.Strategy, db_models.Rule).outerjoin(
        db_models.Rule, db_models.Strategy.rule_id == db_models.Rule.id
    )
    if source_type:
        q = q.filter(db_models.Strategy.source_type == source_type)
    rows = q.order_by(db_models.Strategy.created_at.desc()).all()

    # One batched GROUP BY instead of N _last_scan_at() calls - same
    # "avoid N+1" reasoning the Rule outerjoin above already follows.
    last_scan_rows = db.query(db_models.EngineRun.strategy_id, func.max(db_models.EngineRun.last_checked_at)).group_by(
        db_models.EngineRun.strategy_id
    ).all()
    last_scan_by_strategy = dict(last_scan_rows)

    # Same batched-GROUP-BY reasoning as last_scan_rows above, cross-schema
    # (signal_processing.signals) - see _last_signal_at's own comment.
    last_signal_rows = db.query(processing_models.Signal.strategy_id, func.max(processing_models.Signal.received_at)).group_by(
        processing_models.Signal.strategy_id
    ).all()
    last_signal_by_strategy = dict(last_signal_rows)

    return [
        _to_out(strategy_row, rule_row, last_scan_by_strategy.get(strategy_row.id), last_signal_by_strategy.get(strategy_row.id))
        for strategy_row, rule_row in rows
    ]


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
    rule_row = db.get(db_models.Rule, row.rule_id) if row.rule_id is not None else None
    return _to_out(row, rule_row, _last_scan_at(db, parsed_id), _last_signal_at(db, parsed_id))


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
    if payload.source_rule_name is not None:
        if row.source_type == "in_house":
            raise HTTPException(status_code=422, detail="source_rule_name only applies to external strategies")
        row.source_rule_name = payload.source_rule_name
    if payload.horizon is not None:
        row.horizon = payload.horizon
    if payload.instrument_type is not None:
        row.instrument_type = payload.instrument_type
    if payload.rule_id is not None:
        if row.source_type != "in_house":
            raise HTTPException(status_code=422, detail="rule_id only applies to source_type='in_house' strategies")
        new_rule_row = _load_rule_or_404(db, payload.rule_id)
        row.rule_id = new_rule_row.id

    if payload.stop_loss_method is not None:
        # Method is the complete replacement group for interval/percent/
        # indicator_type/indicator_params - explicitly clears whichever
        # ones the new method doesn't use, so switching methods in one
        # PATCH never leaves a stale value from the old method behind.
        row.stop_loss_method = payload.stop_loss_method
        row.stop_loss_interval = payload.stop_loss_interval
        row.stop_loss_percent = payload.stop_loss_percent
        row.stop_loss_indicator_type = payload.stop_loss_indicator_type
        row.stop_loss_indicator_params = payload.stop_loss_indicator_params
    else:
        if payload.stop_loss_interval is not None:
            row.stop_loss_interval = payload.stop_loss_interval
        if payload.stop_loss_percent is not None:
            row.stop_loss_percent = payload.stop_loss_percent
        if payload.stop_loss_indicator_type is not None:
            row.stop_loss_indicator_type = payload.stop_loss_indicator_type
        if payload.stop_loss_indicator_params is not None:
            row.stop_loss_indicator_params = payload.stop_loss_indicator_params
    if payload.target_percent is not None:
        row.target_percent = payload.target_percent
    if payload.trailing_stop_enabled is not None:
        row.trailing_stop_enabled = payload.trailing_stop_enabled
    # Explicit-null-clears - same model_fields_set distinction fixed_lots
    # already uses, so a PATCH can remove an already-configured
    # exit_condition (not just add/replace one).
    if "exit_condition" in payload.model_fields_set:
        row.exit_condition = payload.exit_condition.model_dump(mode="json") if payload.exit_condition is not None else None
    if payload.option_position_style is not None:
        row.option_position_style = payload.option_position_style
    if payload.option_strike_moneyness is not None:
        row.option_strike_moneyness = payload.option_strike_moneyness
    if payload.option_sl_scope is not None:
        row.option_sl_scope = payload.option_sl_scope
    # Deliberately different from every other field's "not None means set"
    # convention here: the Manual tab (see docs/architecture.md) needs to
    # be able to clear this back to null (auto-sizing) between orders on
    # the same reused strategy, which "omitted or null means unchanged"
    # can't express. model_fields_set distinguishes "key present in the
    # request body" from "key absent entirely" - only an explicit
    # {"fixed_lots": null} clears it; omitting the key still leaves
    # it untouched exactly as before.
    if "fixed_lots" in payload.model_fields_set:
        row.fixed_lots = payload.fixed_lots
    if payload.use_margin is not None:
        row.use_margin = payload.use_margin
    if payload.contract_day_filter is not None:
        row.contract_day_filter = payload.contract_day_filter
    if payload.segment is not None:
        row.segment = payload.segment
    if payload.duplicate_signal_policy is not None:
        row.duplicate_signal_policy = payload.duplicate_signal_policy
    if payload.counter_signal_policy is not None:
        row.counter_signal_policy = payload.counter_signal_policy
    # active_windows=[] is a meaningful, distinct value from "omitted" -
    # see StrategyUpdate's own comment on why this checks
    # model_fields_set rather than "is not None" like every field above.
    if "active_windows" in payload.model_fields_set:
        row.active_windows = [w.model_dump(mode="json") for w in payload.active_windows]
    # Same omitted-vs-explicit-empty distinction as active_windows above.
    if "active_weekdays" in payload.model_fields_set:
        row.active_weekdays = list(payload.active_weekdays)

    try:
        validate_stop_loss_fields(
            row.stop_loss_method,
            row.stop_loss_interval,
            float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
            row.trailing_stop_enabled,
            row.stop_loss_indicator_type,
            row.stop_loss_indicator_params,
        )
        validate_contract_day_filter_fields(row.contract_day_filter, row.instrument_type)
        validate_segment_instrument_type(row.segment, row.instrument_type)
        validate_active_windows(row.active_windows)
        validate_active_weekdays(row.active_weekdays)
        validate_exit_condition(Condition(**row.exit_condition) if row.exit_condition is not None else None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Re-derive (and re-apply) the breakout SL scheme unconditionally on
    # every PATCH to a strategy linked to a breakout rule - not just when
    # this particular PATCH touched rule_id - so the invariant always
    # holds, and a caller trying to PATCH stop_loss_method away from
    # 'previous_candle' gets overridden back rather than silently accepted.
    rule_row = db.get(db_models.Rule, row.rule_id) if row.rule_id is not None else None
    (
        row.stop_loss_method,
        row.stop_loss_interval,
        row.stop_loss_percent,
        row.trailing_stop_enabled,
        row.stop_loss_indicator_type,
        row.stop_loss_indicator_params,
    ) = _stop_loss_fields_for_rule(
        db,
        rule_row,
        row.stop_loss_method,
        row.stop_loss_interval,
        float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        row.trailing_stop_enabled,
        row.stop_loss_indicator_type,
        row.stop_loss_indicator_params,
    )

    db.commit()
    db.refresh(row)
    return _to_out(row, rule_row, _last_scan_at(db, row.id), _last_signal_at(db, row.id))


def _skip_reason_for_candle_failure(exc: requests.RequestException, from_date: date, to: date) -> str:
    """Turns a get_candle_history failure into a message that tells a
    date-range problem apart from anything else - market-data's own
    candles.py wraps a Dhan RuntimeError as a 502 whose JSON body's
    `detail` carries Dhan's actual error text (see that route's own
    `except RuntimeError` clause); requests.HTTPError exposes the failed
    response via `exc.response`, so that detail is recovered here rather
    than only the generic 'X Server Error' requests itself would format.
    Dhan's own charts/intraday rejection reads "Data for Intraday Charts
    can be fetched for 90 days at a time" (error code DH-905) - the most
    common real-world cause of a skip, since this backtest's from_date is
    a symbol's own earliest CSV signal and could be arbitrarily old."""
    detail = None
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text
    detail = detail or str(exc)
    if "days at a time" in detail or "DH-905" in detail:
        span_days = (to - from_date).days
        return f"date range too wide ({from_date} to {to}, {span_days} days) - {detail}"
    return detail


def _fetch_candles_for_backtest_signals(
    strategy: db_models.Strategy,
    signals_by_symbol: dict[str, list[str]],
    interval: str,
    stop_loss_method: Optional[str],
    stop_loss_interval: Optional[str],
    to: date,
    stop_loss_indicator_period: Optional[int] = None,
) -> tuple[dict[str, list], dict[str, list], list[ExternalBacktestSkippedSymbol]]:
    """Shared by the grid endpoint below and its /trades drill-down
    sibling - resolves + fetches candles once per symbol (main interval,
    plus a second SL-interval series for stop_loss_method='previous_candle'
    or 'indicator'), skipping (not raising for) a symbol that fails to
    resolve or whose candle history call to market-data itself fails -
    same per-symbol from_date and requests.RequestException handling as
    _backtest_pooled_symbols in rules.py; see backtest_strategy_signals's
    own docstring for why both matter here. Each skip carries a `reason`
    (see _skip_reason_for_candle_failure) rather than just a bare symbol,
    so a caller can tell a too-wide date range apart from a resolve
    failure or an empty result.

    stop_loss_indicator_period is the widest 'period' across whatever the
    caller is about to run (a single value for the /trades drill-down, or
    the max across the whole grid for backtest_strategy_signals - see that
    route's own call site) - same "one wide-enough fetch, not one per
    combo" reasoning as rules.py's own backtest_rule_grid. Without this,
    stop_loss_method='indicator' silently got NO sl_candles at all (this
    function used to only special-case 'previous_candle'), so
    _indicator_stop_price/_initial_stop_loss_price always fell through to
    None - the indicator-based stop-loss never actually fired despite
    every OTHER exit path (target/opposite-signal/end-of-data) working
    fine, exactly the "SL doesn't close on a close below EMA/SuperTrend"
    symptom reported live."""
    candles_by_symbol: dict[str, list] = {}
    sl_candles_by_symbol: dict[str, list] = {}
    skipped: list[ExternalBacktestSkippedSymbol] = []
    for symbol, timestamps in signals_by_symbol.items():
        resolved = resolve_underlying(strategy.segment, symbol)
        if resolved is None:
            skipped.append(ExternalBacktestSkippedSymbol(symbol=symbol, reason="could not resolve this symbol"))
            continue
        from_date = min(datetime.fromisoformat(ts) for ts in timestamps).date()
        try:
            candles = get_candle_history(resolved.chart_exchange, resolved.chart_symbol, interval, from_date, to)
            if not candles:
                skipped.append(
                    ExternalBacktestSkippedSymbol(
                        symbol=symbol,
                        reason=f"no candle history returned for {from_date} to {to}",
                    )
                )
                continue
            sl_candles = None
            if stop_loss_method == "previous_candle" and stop_loss_interval:
                sl_candles = (
                    candles
                    if stop_loss_interval == interval
                    else get_candle_history(resolved.chart_exchange, resolved.chart_symbol, stop_loss_interval, from_date, to)
                )
            elif stop_loss_method == "indicator" and stop_loss_interval and stop_loss_indicator_period:
                # Always fetched fresh (never opportunistically reused
                # like previous_candle above, even when the intervals
                # match) - the indicator's own warm-up window is
                # typically wider than the main series' own range, same
                # as rules.py's _sl_candles_for does for the exact same
                # reason.
                warmup_from, _ = history_window(stop_loss_indicator_period, stop_loss_interval)
                sl_candles = get_candle_history(
                    resolved.chart_exchange, resolved.chart_symbol, stop_loss_interval, min(from_date, warmup_from), to
                )
        except requests.RequestException as exc:
            reason = _skip_reason_for_candle_failure(exc, from_date, to)
            logger.warning("skipping symbol %s (strategy %s) - %s", symbol, strategy.id, reason)
            skipped.append(ExternalBacktestSkippedSymbol(symbol=symbol, reason=reason))
            continue
        candles_by_symbol[symbol] = candles
        if sl_candles is not None:
            sl_candles_by_symbol[symbol] = sl_candles
    return candles_by_symbol, sl_candles_by_symbol, skipped


@router.post("/strategies/{strategy_id}/backtest-signals", response_model=ExternalBacktestResponse)
def backtest_strategy_signals(
    strategy_id: str,
    payload: ExternalBacktestRequest,
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """Backtests an externally-supplied (symbol, timestamp) signal list -
    e.g. a Chartink alert-history CSV export, which has no price/action
    columns of its own - against a GRID of exit configurations, to find
    which stop-loss/target/trailing setup would have worked best. The
    opposite of every other backtest in this service (which derive entries
    from a Rule's own indicator condition and hold exit config fixed) -
    see app/domain/generation/external_backtest.py's own module docstring.
    strategy_id is only used to resolve `segment` (which market-data
    provider/exchange to fetch candles from) - the strategy's own
    source_type/rule/exit-config fields are irrelevant here, since exit
    config is exactly what's being swept, not read from the strategy.
    Works for any strategy (in-house or external), but is really meant for
    an external one - an in-house Strategy's own Rule already has its own
    /rules/{id}/backtest for this.

    Only one stop_loss_method's own grid is populated per request (same
    "one fixed method" rule backtest_rule_grid already enforces) -
    'percent' sweeps stop_loss_percent_grid, 'indicator' sweeps
    stop_loss_indicator_param_grid (expand_stop_loss_grid, same shape Rule
    grid search already uses), 'previous_candle'/None have nothing to
    sweep on that axis (a single implicit None combo).

    `to` (query param, defaults to today) is the ONLY end of the backtest
    window a caller controls - the start is derived automatically, PER
    SYMBOL, as that symbol's own earliest signal in `signals` (see
    _fetch_candles_for_backtest_signals). There's no separate "lookback"
    knob: candles are fetched from a symbol's first signal through `to`,
    which is exactly the window every trade in the result was simulated
    over."""
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")
    strategy = db.get(db_models.Strategy, parsed_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="strategy not found")

    stop_loss_values: list = [None]
    if payload.stop_loss_method == "percent":
        if not payload.stop_loss_percent_grid:
            raise HTTPException(status_code=422, detail="stop_loss_method='percent' requires stop_loss_percent_grid")
        stop_loss_values = payload.stop_loss_percent_grid
    elif payload.stop_loss_method == "indicator":
        if not payload.stop_loss_indicator_type or not payload.stop_loss_indicator_param_grid:
            raise HTTPException(
                status_code=422,
                detail="stop_loss_method='indicator' requires stop_loss_indicator_type and stop_loss_indicator_param_grid",
            )
        # Which candle series the indicator gets computed on - without it
        # _fetch_candles_for_backtest_signals has no interval to fetch
        # sl_candles at, so the indicator stop-loss would silently never
        # fire (same field the Strategy edit form already requires for
        # this method - see StrategyUpdate's own validation).
        if not payload.stop_loss_interval:
            raise HTTPException(status_code=422, detail="stop_loss_method='indicator' requires stop_loss_interval")
        try:
            stop_loss_values = expand_stop_loss_grid(payload.stop_loss_indicator_param_grid)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    elif payload.stop_loss_method == "previous_candle" and not payload.stop_loss_interval:
        raise HTTPException(status_code=422, detail="stop_loss_method='previous_candle' requires stop_loss_interval")

    try:
        combos = expand_exit_grid(stop_loss_values, payload.target_percent_grid, payload.trailing_grid)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    signals_by_symbol: dict[str, list[str]] = {}
    for s in payload.signals:
        signals_by_symbol.setdefault(s.symbol.strip().upper(), []).append(s.timestamp.isoformat())

    # sl_candles must cover the WIDEST stop-loss indicator period across
    # the whole sweep - same "one wide-enough fetch, not one per combo"
    # reasoning as rules.py's own backtest_rule_grid (a wider-than-needed
    # series computes a smaller-period EMA/SuperTrend correctly too).
    stop_loss_indicator_period = None
    if payload.stop_loss_method == "indicator":
        periods = [int(v["period"]) for v in stop_loss_values if isinstance(v, dict) and "period" in v]
        if periods:
            stop_loss_indicator_period = max(periods)

    candles_by_symbol, sl_candles_by_symbol, skipped = _fetch_candles_for_backtest_signals(
        strategy,
        signals_by_symbol,
        payload.interval,
        payload.stop_loss_method,
        payload.stop_loss_interval,
        to,
        stop_loss_indicator_period,
    )

    results = grid_search_external_signals(
        {symbol: timestamps for symbol, timestamps in signals_by_symbol.items() if symbol in candles_by_symbol},
        payload.direction,
        candles_by_symbol,
        combos,
        payload.stop_loss_method,
        payload.stop_loss_indicator_type,
        sl_candles_by_symbol or None,
        payload.square_off_time,
    )

    return ExternalBacktestResponse(
        signal_count=len(payload.signals),
        symbols_tested=len(candles_by_symbol),
        symbols_skipped=skipped,
        results=results,
    )


@router.post("/strategies/{strategy_id}/backtest-signals/trades", response_model=ExternalBacktestTradeResponse)
def backtest_strategy_signals_trades(
    strategy_id: str,
    payload: ExternalBacktestTradeRequest,
    to: date = date.today(),
    db: Session = Depends(get_db),
):
    """The individual-trade drill-down for ONE exit config, sibling of
    /backtest-signals above (which sweeps a whole grid and only returns
    each combo's aggregate stats - see that route's own docstring, same
    `to` semantics apply here). Meant to be called with a single combo row
    from that route's own response (stop_loss_value/target_percent/
    trailing_stop_enabled), letting a caller see exactly which trades
    produced a combo's hypothetical_pnl rather than only the aggregate."""
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")
    strategy = db.get(db_models.Strategy, parsed_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="strategy not found")

    if payload.stop_loss_method == "percent" and payload.stop_loss_percent is None:
        raise HTTPException(status_code=422, detail="stop_loss_method='percent' requires stop_loss_percent")
    if payload.stop_loss_method == "indicator" and (
        not payload.stop_loss_indicator_type or not payload.stop_loss_indicator_params
    ):
        raise HTTPException(
            status_code=422,
            detail="stop_loss_method='indicator' requires stop_loss_indicator_type and stop_loss_indicator_params",
        )
    if payload.stop_loss_method == "indicator" and not payload.stop_loss_interval:
        raise HTTPException(status_code=422, detail="stop_loss_method='indicator' requires stop_loss_interval")
    if payload.stop_loss_method == "previous_candle" and not payload.stop_loss_interval:
        raise HTTPException(status_code=422, detail="stop_loss_method='previous_candle' requires stop_loss_interval")

    combo = {
        "stop_loss_value": payload.stop_loss_percent if payload.stop_loss_method == "percent" else payload.stop_loss_indicator_params,
        "target_percent": payload.target_percent,
        "trailing_stop_enabled": payload.trailing_stop_enabled,
    }
    exit_config = build_exit_config(combo, payload.stop_loss_method, payload.stop_loss_indicator_type, payload.square_off_time)

    signals_by_symbol: dict[str, list[str]] = {}
    for s in payload.signals:
        signals_by_symbol.setdefault(s.symbol.strip().upper(), []).append(s.timestamp.isoformat())

    stop_loss_indicator_period = (
        int(payload.stop_loss_indicator_params["period"])
        if payload.stop_loss_method == "indicator" and payload.stop_loss_indicator_params and "period" in payload.stop_loss_indicator_params
        else None
    )
    candles_by_symbol, sl_candles_by_symbol, skipped = _fetch_candles_for_backtest_signals(
        strategy,
        signals_by_symbol,
        payload.interval,
        payload.stop_loss_method,
        payload.stop_loss_interval,
        to,
        stop_loss_indicator_period,
    )

    trades_by_symbol = simulate_external_signals_by_symbol(
        {symbol: timestamps for symbol, timestamps in signals_by_symbol.items() if symbol in candles_by_symbol},
        payload.direction,
        candles_by_symbol,
        exit_config,
        sl_candles_by_symbol or None,
    )
    trades = [
        ExternalBacktestTrade(
            symbol=symbol,
            entry_time=t.entry_time,
            direction=t.direction,
            entry_price=t.entry_price,
            exit_time=t.exit_time,
            exit_price=t.exit_price,
            exit_reason=t.exit_reason,
            pnl=t.pnl,
        )
        for symbol, symbol_trades in trades_by_symbol.items()
        for t in symbol_trades
    ]
    trades.sort(key=lambda t: t.entry_time)
    all_trades = [t for symbol_trades in trades_by_symbol.values() for t in symbol_trades]

    return ExternalBacktestTradeResponse(
        signal_count=len(payload.signals),
        symbols_tested=len(candles_by_symbol),
        symbols_skipped=skipped,
        trade_count=len(all_trades),
        hypothetical_pnl=sum(t.pnl for t in all_trades),
        win_rate=win_rate(all_trades),
        max_drawdown=max_drawdown(all_trades),
        trades=trades,
    )

import uuid
from datetime import datetime
from typing import Optional, get_args

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import get_optional_user_id
from app.domain.generation.models import (
    StopLossInterval,
    StrategyCreate,
    StrategyOut,
    StrategyUpdate,
    validate_active_weekdays,
    validate_active_windows,
    validate_contract_day_filter_fields,
    validate_segment_instrument_type,
    validate_stop_loss_fields,
)
from app.domain.generation.rule import BreakoutRuleConfig, CrossoverRuleConfig, RuleSummary, validate_rule_config

router = APIRouter()


def _last_scan_at(db: Session, strategy_id: uuid.UUID) -> Optional[datetime]:
    """MAX(engine_runs.last_checked_at) across every symbol this one
    strategy scans - see StrategyOut.last_scan_at's own docstring. Single-
    strategy lookup, used by GET /strategies/{id} - list_strategies below
    does the batched equivalent in one query instead of N of these."""
    return db.query(func.max(db_models.EngineRun.last_checked_at)).filter(
        db_models.EngineRun.strategy_id == strategy_id
    ).scalar()


def _to_out(row: db_models.Strategy, rule_row: Optional[db_models.Rule], last_scan_at: Optional[datetime] = None) -> StrategyOut:
    return StrategyOut(
        id=str(row.id),
        name=row.name,
        source_type=row.source_type,
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

    return [_to_out(strategy_row, rule_row, last_scan_by_strategy.get(strategy_row.id)) for strategy_row, rule_row in rows]


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
    return _to_out(row, rule_row, _last_scan_at(db, parsed_id))


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
    return _to_out(row, rule_row, _last_scan_at(db, row.id))

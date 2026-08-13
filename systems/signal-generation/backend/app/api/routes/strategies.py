import uuid
from typing import Optional, get_args

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.models import (
    StopLossInterval,
    StrategyCreate,
    StrategyOut,
    StrategyUpdate,
    validate_active_window_fields,
    validate_contract_day_filter_fields,
    validate_rule_link_consistency,
    validate_stop_loss_fields,
)
from app.domain.rule import BreakoutRuleConfig, RuleSummary, validate_rule_config

router = APIRouter()


def _to_out(row: db_models.Strategy, rule_row: Optional[db_models.Rule]) -> StrategyOut:
    return StrategyOut(
        id=str(row.id),
        name=row.name,
        source_type=row.source_type,
        exchange=row.exchange,
        horizon=row.horizon,
        instrument_type=row.instrument_type,
        rule_id=str(row.rule_id),
        rule=RuleSummary(id=str(rule_row.id), name=rule_row.name, source_type=rule_row.source_type, segment=rule_row.segment)
        if rule_row is not None
        else None,
        stop_loss_method=row.stop_loss_method,
        stop_loss_interval=row.stop_loss_interval,
        stop_loss_percent=float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        target_percent=float(row.target_percent) if row.target_percent is not None else None,
        trailing_stop_enabled=row.trailing_stop_enabled,
        option_position_style=row.option_position_style,
        option_strike_moneyness=row.option_strike_moneyness,
        option_sl_scope=row.option_sl_scope,
        option_fixed_lots=row.option_fixed_lots,
        contract_day_filter=row.contract_day_filter,
        segment=row.segment,
        square_off_time=row.square_off_time,
        regime_filter_enabled=row.regime_filter_enabled,
        regime_filter_checks=row.regime_filter_checks,
        duplicate_signal_policy=row.duplicate_signal_policy,
        counter_signal_policy=row.counter_signal_policy,
        active_from_time=row.active_from_time,
        active_to_time=row.active_to_time,
        status=row.status,
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
    rule_row: db_models.Rule,
    stop_loss_method: Optional[str],
    stop_loss_interval: Optional[str],
    stop_loss_percent: Optional[float],
    trailing_stop_enabled: bool,
) -> tuple[Optional[str], Optional[str], Optional[float], bool]:
    """A strategy linked to a breakout rule owns its own stop-loss scheme
    rather than accepting whatever stop_loss_method/interval was
    requested - the initial stop is enforced live by reusing execution's
    existing `previous_candle` mechanism with stop_loss_interval set to
    the rule's own htf_interval (see app/domain/breakout.py's module
    docstring on the live enforcement gap). Validates (422 if not) that
    htf_interval is one of execution's supported stop-loss intervals -
    otherwise this strategy could never actually be supported live, even
    with the reversal-exit gap accepted. Every other rule type (or no
    rule_config at all, i.e. an external rule) passes the requested
    fields through unchanged - only breakout forces this."""
    if rule_row.rule_config is not None:
        rule = validate_rule_config(rule_row.rule_config)
        if isinstance(rule, BreakoutRuleConfig):
            if rule.htf_interval not in get_args(StopLossInterval):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"htf_interval '{rule.htf_interval}' isn't one of execution's supported stop-loss intervals "
                        f"({', '.join(get_args(StopLossInterval))}) - required so the initial stop-loss can be enforced live"
                    ),
                )
            return "previous_candle", rule.htf_interval, None, False
    return stop_loss_method, stop_loss_interval, stop_loss_percent, trailing_stop_enabled


@router.post("/strategies", response_model=StrategyOut, status_code=201)
def create_strategy(payload: StrategyCreate, db: Session = Depends(get_db)):
    rule_row = _load_rule_or_404(db, payload.rule_id)
    try:
        validate_rule_link_consistency(payload.source_type, rule_row.source_type)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stop_loss_method, stop_loss_interval, stop_loss_percent, trailing_stop_enabled = _stop_loss_fields_for_rule(
        rule_row, payload.stop_loss_method, payload.stop_loss_interval, payload.stop_loss_percent, payload.trailing_stop_enabled
    )

    row = db_models.Strategy(
        name=payload.name,
        source_type=payload.source_type,
        exchange=payload.exchange,
        horizon=payload.horizon,
        instrument_type=payload.instrument_type,
        rule_id=rule_row.id,
        stop_loss_method=stop_loss_method,
        stop_loss_interval=stop_loss_interval,
        stop_loss_percent=stop_loss_percent,
        target_percent=payload.target_percent,
        trailing_stop_enabled=trailing_stop_enabled,
        option_position_style=payload.option_position_style,
        option_strike_moneyness=payload.option_strike_moneyness,
        option_sl_scope=payload.option_sl_scope,
        option_fixed_lots=payload.option_fixed_lots,
        contract_day_filter=payload.contract_day_filter,
        segment=payload.segment,
        square_off_time=payload.square_off_time,
        regime_filter_enabled=payload.regime_filter_enabled,
        regime_filter_checks=payload.regime_filter_checks,
        duplicate_signal_policy=payload.duplicate_signal_policy,
        counter_signal_policy=payload.counter_signal_policy,
        active_from_time=payload.active_from_time,
        active_to_time=payload.active_to_time,
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
    q = db.query(db_models.Strategy, db_models.Rule).join(db_models.Rule, db_models.Strategy.rule_id == db_models.Rule.id)
    if source_type:
        q = q.filter(db_models.Strategy.source_type == source_type)
    rows = q.order_by(db_models.Strategy.created_at.desc()).all()
    return [_to_out(strategy_row, rule_row) for strategy_row, rule_row in rows]


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
    rule_row = db.get(db_models.Rule, row.rule_id)
    return _to_out(row, rule_row)


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
        new_rule_row = _load_rule_or_404(db, payload.rule_id)
        try:
            validate_rule_link_consistency(row.source_type, new_rule_row.source_type)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.rule_id = new_rule_row.id

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
    if payload.option_position_style is not None:
        row.option_position_style = payload.option_position_style
    if payload.option_strike_moneyness is not None:
        row.option_strike_moneyness = payload.option_strike_moneyness
    if payload.option_sl_scope is not None:
        row.option_sl_scope = payload.option_sl_scope
    if payload.option_fixed_lots is not None:
        row.option_fixed_lots = payload.option_fixed_lots
    if payload.contract_day_filter is not None:
        row.contract_day_filter = payload.contract_day_filter
    if payload.segment is not None:
        row.segment = payload.segment
    if payload.square_off_time is not None:
        row.square_off_time = payload.square_off_time
    if payload.regime_filter_enabled is not None:
        row.regime_filter_enabled = payload.regime_filter_enabled
    if payload.regime_filter_checks is not None:
        row.regime_filter_checks = payload.regime_filter_checks
    if payload.duplicate_signal_policy is not None:
        row.duplicate_signal_policy = payload.duplicate_signal_policy
    if payload.counter_signal_policy is not None:
        row.counter_signal_policy = payload.counter_signal_policy
    if payload.active_from_time is not None:
        row.active_from_time = payload.active_from_time
    if payload.active_to_time is not None:
        row.active_to_time = payload.active_to_time

    try:
        validate_stop_loss_fields(
            row.stop_loss_method,
            row.stop_loss_interval,
            float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
            row.trailing_stop_enabled,
        )
        validate_contract_day_filter_fields(row.contract_day_filter, row.instrument_type)
        validate_active_window_fields(row.active_from_time, row.active_to_time)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Re-derive (and re-apply) the breakout SL scheme unconditionally on
    # every PATCH to a strategy linked to a breakout rule - not just when
    # this particular PATCH touched rule_id - so the invariant always
    # holds, and a caller trying to PATCH stop_loss_method away from
    # 'previous_candle' gets overridden back rather than silently accepted.
    rule_row = db.get(db_models.Rule, row.rule_id)
    row.stop_loss_method, row.stop_loss_interval, row.stop_loss_percent, row.trailing_stop_enabled = _stop_loss_fields_for_rule(
        rule_row,
        row.stop_loss_method,
        row.stop_loss_interval,
        float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        row.trailing_stop_enabled,
    )

    db.commit()
    db.refresh(row)
    return _to_out(row, rule_row)

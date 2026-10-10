"""Server-side pending (limit) orders.

An armed limit order used to live only in the browser: LiveChartPage watched the
underlying's price in a timer and fired the order on the first crossing. It died
with the tab and never worked on a phone. This stores the order
(execution.pending_orders) and a scheduler job watches it.

Semantics are the frontend's, ported exactly (manualOrder.ts, pendingTriggerCrossed):
`trigger_price` is a level of the UNDERLYING's own price, also for option orders
(the legs are resolved at whatever premium is live when it fires). The side the
underlying was on when the order was armed is recorded once (started_above) and
the order fires on the first crossing from that side. One difference, on purpose:
that starting side is taken from the SERVER's live price at arm time, not trusted
from the client.

PAPER ONLY. A background trigger has no user token, so it cannot place a real
order: creating one on a live account is refused, and an account that went live
while an order was armed makes it FAIL rather than trade real money unattended.
Quotes come from the platform credential, like the existing exit-monitor jobs.
Note for the own-keys data model (docs/redesign-rollout-plan.md, decision 1):
background jobs will need a per-user credential path.

Stacking: unless the order was armed with allow_stacking, firing is SKIPPED (cancelled, with a reason) when the
person already holds an open position or option group on that underlying - manual trades are independent of the
Strategy signal-conflict policies, so this is the only thing stopping a second waiting order from doubling up.

Lifecycle: pending -> exactly one of triggered / rejected / failed / cancelled /
expired. Firing is AT-MOST-ONCE: the row is claimed ('triggered', committed)
BEFORE the order is placed, so a crash mid-placement can lose an order but can
never place it twice. Every state change out of 'pending' (claim, cancel, expiry)
is a single conditional UPDATE ... WHERE status = 'pending', so it is atomic in the
database and safe with more than one worker (a second instance, an overlapping
run): exactly one wins, and a cancel can never overwrite an order that just fired. One pending order per (user, segment, symbol); arming a new
one replaces the old. Orders expire (default 24h, capped) so a stale intention
cannot fire days later.
"""

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings
from app.domain import trade_snapshots
from app.domain.study_notes import StudyNoteError, decode_snapshot

logger = logging.getLogger(__name__)


class PendingOrderError(Exception):
    """A request the caller can fix; carries the HTTP status the route should use."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class UnknownUnderlying(Exception):
    """The symbol does not resolve on that segment."""


class UnderlyingUnavailable(Exception):
    """The symbol resolves but no price could be fetched right now."""


def crossed(started_above: bool, trigger_price: float, ltp: float) -> bool:
    """Port of pendingTriggerCrossed: from above, fire when the price falls to
    the trigger; from below, when it rises to it."""
    return ltp <= trigger_price if started_above else ltp >= trigger_price


def bracket_problem(action: str, trigger: float, stop: Optional[float], target: Optional[float]) -> Optional[str]:
    """A stop must sit on the losing side of the trigger and a target on the
    winning side (same rule as the frontend's validateBracket)."""
    if stop is not None and not (stop < trigger if action == "BUY" else stop > trigger):
        return f"the stop-loss must be {'below' if action == 'BUY' else 'above'} the trigger price for a {action}"
    if target is not None and not (target > trigger if action == "BUY" else target < trigger):
        return f"the target must be {'above' if action == 'BUY' else 'below'} the trigger price for a {action}"
    return None


# --- what the job needs from the outside world ---------------------------------------------------------------------


@dataclass
class Deps:
    """Injectable so the logic is testable without market-data or a broker."""

    underlying_ltp: Callable  # (segment, symbol, token=None, owner=None) -> price; raises UnknownUnderlying / UnderlyingUnavailable
    open_future: Callable  # (db, order, exec_settings) -> Position
    open_option: Callable  # (db, order, exec_settings) -> OptionPositionGroup
    set_spot_stop: Callable  # (db, user_id, group_id, price)
    set_spot_target: Callable
    # (db, user_id, segment, symbol) -> a description of what is already held, or None. Left unset = never skip.
    holds_open: Optional[Callable] = None
    # (db, order, exec_settings) -> Position: a positional spot hold on the positional book. Left unset = a positional order fails.
    open_spot: Optional[Callable] = None


_RESOLVE_TTL_SECONDS = 3600
_resolve_cache: dict[tuple[str, str], tuple[float, tuple[str, str]]] = {}


def default_deps() -> Deps:
    """The real adapters. Imported lazily so importing this module (and its tests)
    needs neither market-data nor the option machinery."""
    from app.adapters.quotes.client import (
        get_candle_history, get_expiry_list, get_ltp_batch, get_lot_size, get_option_chain, get_previous_candle,
        resolve_symbol_by_security_id, resolve_underlying,
    )
    from app.domain.option_position_manager import open_manual_option_group, update_group_spot_stop_loss, update_group_spot_target
    from app.domain.position_manager import open_manual_position

    def underlying_ltp(segment: str, symbol: str, token: Optional[str] = None, owner=None) -> float:
        """`token`: a user is arming an order right now (their own keys). `owner`: the watcher is checking
        on behalf of that order's owner (their keys, with the platform credential as a fallback)."""
        key = (segment, symbol)
        hit = _resolve_cache.get(key)
        if hit is None or time.monotonic() - hit[0] > _RESOLVE_TTL_SECONDS:
            resolved = resolve_underlying(segment, symbol)
            if not resolved:
                raise UnknownUnderlying(symbol)
            hit = (time.monotonic(), (resolved["chart_exchange"], resolved["chart_symbol"]))
            _resolve_cache[key] = hit
        exchange, chart_symbol = hit[1]
        try:
            prices = get_ltp_batch(exchange, [chart_symbol], token=token, on_behalf_of=owner)
            if not prices.get(chart_symbol) and owner is not None and settings.job_quotes_platform_fallback:
                prices = get_ltp_batch(exchange, [chart_symbol])  # the owner's keys gave nothing: the platform's, so the order is still watched
        except Exception as exc:
            raise UnderlyingUnavailable(str(exc)) from exc
        price = prices.get(chart_symbol)
        if price is None:
            raise UnderlyingUnavailable(f"no price for {symbol}")
        return float(price)

    def open_future(db, o, exec_settings):
        return open_manual_position(
            o.user_id, o.segment, o.symbol, o.action, "future", float(o.trigger_price),
            float(o.quantity) if o.quantity is not None else None,
            float(o.stop_loss_price) if o.stop_loss_price is not None else None,
            exec_settings, db, resolve_underlying,
            get_previous_candle=get_previous_candle, get_candle_history=get_candle_history,
            plan_checklist=[], order_type="limit", token=None,
            target_price=float(o.target_price) if o.target_price is not None else None,
            trend_followed=o.trend_followed, risk_managed=o.risk_managed, setup_tag=o.setup_tag, confidence=o.confidence,
            auto_traded=False, entry_interval=o.entry_interval, notes=o.notes,
        )

    def open_option(db, o, exec_settings):
        # The legs the order was armed for (an explicit strike per leg and the expiry they came from) win over the moneyness,
        # exactly as they do for a market order.
        return open_manual_option_group(
            o.user_id, o.segment, o.symbol, o.action, "spread" if o.strategy == "spread" else "naked", o.moneyness or "ATM",
            o.expiry, "combined", float(o.quantity) if o.quantity is not None else None, exec_settings, db, resolve_underlying,
            get_expiry_list, get_option_chain, get_ltp_batch, resolve_symbol_by_security_id, get_lot_size,
            spread_width=o.spread_width,
            primary_strike=float(o.primary_strike) if o.primary_strike is not None else None,
            second_strike=float(o.second_strike) if o.second_strike is not None else None,
            plan_checklist=[], order_type="limit", trend_followed=o.trend_followed, risk_managed=o.risk_managed,
            setup_tag=o.setup_tag, confidence=o.confidence, notes=o.notes, entry_interval=o.entry_interval, auto_traded=False,
        )

    def open_spot(db, o, exec_settings):
        return open_manual_position(
            o.user_id, o.segment, o.symbol, o.action, "spot", float(o.trigger_price),
            float(o.quantity) if o.quantity is not None else None,
            float(o.stop_loss_price) if o.stop_loss_price is not None else None,
            exec_settings, db, resolve_underlying,
            get_previous_candle=get_previous_candle, get_candle_history=get_candle_history,
            plan_checklist=[], order_type="limit", token=None,
            target_price=float(o.target_price) if o.target_price is not None else None,
            trend_followed=o.trend_followed, risk_managed=o.risk_managed, setup_tag=o.setup_tag, confidence=o.confidence,
            auto_traded=False, entry_interval=o.entry_interval, horizon="positional", notes=o.notes,
        )

    return Deps(underlying_ltp, open_future, open_option, update_group_spot_stop_loss, update_group_spot_target, holds_open_position, open_spot)


def holds_open_position(db: Session, user_id: uuid.UUID, segment: str, symbol: str, horizon: str = "intraday") -> Optional[str]:
    """What the person already holds open on this underlying, or None. A future/spot position is stored under
    its resolved contract (NIFTY-Sep2026-FUT) or the bare symbol, an option group under the bare underlying;
    option legs (which carry an option_group_id) are left to their group so one trade is not counted twice.

    `horizon` picks the book: an intraday order is only blocked by an intraday hold, a positional one by a positional hold (a
    swing position on the same symbol is a different book and must not stop, or be stopped by, a day trade)."""
    sym = symbol.strip().upper()
    pos = db_models.Position
    held = (
        db.query(pos)
        .filter(pos.user_id == user_id, pos.segment == segment, pos.status == "OPEN", pos.option_group_id.is_(None))
        .all()
    )
    positional = horizon == "positional"
    mine = [
        p for p in held
        if (p.symbol.upper() == sym or p.symbol.upper().startswith(f"{sym}-")) and ((getattr(p, "horizon", None) == "positional") == positional)
    ]
    grp = db_models.OptionPositionGroup
    groups = (
        []
        if positional  # options are never positional
        else db.query(grp)
        .filter(grp.user_id == user_id, grp.segment == segment, grp.underlying_symbol == sym, grp.status == "OPEN")
        .all()
    )
    count = len(mine) + len(groups)
    if count == 0:
        return None
    return f"{count} open {sym} position{'s' if count != 1 else ''}"


# --- creating / cancelling / listing -----------------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid_or_none(value: Optional[str]) -> Optional[uuid.UUID]:
    if not value or not value.strip():
        return None
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        raise PendingOrderError(422, "source_note_id is not a valid id")


def link_note_to_position(db: Session, user_id: uuid.UUID, note_id: Optional[uuid.UUID], position_id: Optional[uuid.UUID]) -> None:
    """The plan note an order was armed from follows the trade it produced: the note's position_id is set once the order has filled.
    A note that is not this user's, or already points at a trade, is left alone."""
    if note_id is None or position_id is None:
        return
    note = db.get(db_models.StudyNote, note_id)
    if note is not None and note.user_id == user_id and note.position_id is None:
        note.position_id = position_id
        db.commit()
        # The note's own picture (the chart as it was when the plan was written) becomes the trade's plan at entry.
        trade_snapshots.copy_note_snapshot(db, note, position_id)


def create_pending_order(
    db: Session, user_id: uuid.UUID, payload, deps: Deps, is_live: bool, now: Optional[datetime] = None, token: Optional[str] = None
) -> db_models.PendingOrder:
    """`is_live`: whether the caller's account for this segment is live (the route
    looks it up). Raises PendingOrderError for anything the caller can fix."""
    now = now or _now()
    if is_live:
        raise PendingOrderError(409, "pending orders are paper-only, and this account is live: place a market order, or switch live trading off first")
    problem = bracket_problem(payload.action, payload.trigger_price, payload.stop_loss_price, payload.target_price)
    if problem:
        raise PendingOrderError(422, problem)
    ttl = payload.expires_in_minutes or settings.pending_order_default_ttl_minutes
    if ttl > settings.pending_order_max_ttl_minutes:
        raise PendingOrderError(422, f"expires_in_minutes may be at most {settings.pending_order_max_ttl_minutes}")

    symbol = payload.symbol.strip().upper()
    try:
        # The person arming the order is at a browser: read the price on THEIR keys when we have their token.
        ltp = deps.underlying_ltp(payload.segment, symbol, token=token) if token else deps.underlying_ltp(payload.segment, symbol)
    except UnknownUnderlying:
        raise PendingOrderError(404, f"unknown symbol {symbol} on {payload.segment}")
    except UnderlyingUnavailable as exc:
        raise PendingOrderError(503, f"could not get a live price for {symbol} to arm the order: {exc}")
    if ltp == payload.trigger_price:
        raise PendingOrderError(422, "the price is already at the trigger: place a market order instead")

    P = db_models.PendingOrder
    existing = db.query(P).filter(P.user_id == user_id, P.status == "pending").all()
    same = [r for r in existing if r.segment == payload.segment and r.symbol == symbol and (r.horizon or "intraday") == payload.horizon]
    if len(existing) - len(same) >= settings.max_pending_orders_per_user:
        raise PendingOrderError(422, f"too many pending orders (at most {settings.max_pending_orders_per_user})")
    for old in same:  # one live order per symbol: arming a new one replaces it
        old.status, old.status_reason = "cancelled", "replaced by a newer order for the same symbol"
    db.flush()

    row = P(
        user_id=user_id, segment=payload.segment, symbol=symbol, action=payload.action, strategy=payload.strategy,
        moneyness=payload.moneyness if payload.strategy != "future" else None, trigger_price=payload.trigger_price,
        started_above=ltp > payload.trigger_price, stop_loss_price=payload.stop_loss_price, target_price=payload.target_price,
        quantity=payload.quantity, trend_followed=payload.trend_followed, risk_managed=payload.risk_managed,
        setup_tag=payload.setup_tag, confidence=payload.confidence, entry_interval=payload.entry_interval,
        status="pending", expires_at=now + timedelta(minutes=ttl), last_price=ltp, last_checked_at=now,
        allow_stacking=bool(payload.allow_stacking), horizon=payload.horizon,
        source_note_id=_uuid_or_none(payload.source_note_id),
        primary_strike=payload.primary_strike, second_strike=payload.second_strike, expiry=payload.expiry,
        spread_width=payload.spread_width, notes=(payload.notes or "").strip() or None,
    )
    try:
        row.plan_snapshot = decode_snapshot(payload.plan_snapshot_png_base64)
    except StudyNoteError as exc:
        raise PendingOrderError(exc.status_code, exc.detail)
    db.add(row)
    db.commit()
    return row


def cancel_pending_order(db: Session, user_id: uuid.UUID, order_id: uuid.UUID) -> Optional[db_models.PendingOrder]:
    """None if there is no such order for this user; PendingOrderError(409) if it
    is no longer pending."""
    P = db_models.PendingOrder
    row = db.get(P, order_id)
    if row is None or row.user_id != user_id:
        return None
    # One conditional UPDATE: if the watcher claimed it between the read above and
    # here, this changes nothing and the caller is told, instead of overwriting a
    # 'triggered' order with 'cancelled'.
    updated = (
        db.query(P)
        .filter(P.id == order_id, P.user_id == user_id, P.status == "pending")
        .update({P.status: "cancelled", P.status_reason: "cancelled by you"}, synchronize_session=False)
    )
    db.commit()
    db.refresh(row)
    if updated != 1:
        raise PendingOrderError(409, f"this order is already {row.status}")
    return row


def update_pending_order(
    db: Session, user_id: uuid.UUID, order_id: uuid.UUID, deps: Deps, *,
    trigger_price: Optional[float] = None, stop_loss_price: Optional[float] = None, target_price: Optional[float] = None, token: Optional[str] = None,
) -> Optional[db_models.PendingOrder]:
    """Move a waiting order's trigger, stop-loss and/or target. None if there is no such order for this user; PendingOrderError(409) if it is no
    longer pending, 422 if the new levels no longer make sense together (a stop on the winning side, a trigger the price is already at).

    A moved trigger re-reads the price: the order fires on the FIRST CROSSING of the trigger, so which side the price starts from has to be
    worked out again against the new level. The write is one conditional UPDATE like cancel's, so an order the watcher has just claimed is not
    changed after the fact (the watcher's own claim is what makes a fire happen once)."""
    P = db_models.PendingOrder
    row = db.get(P, order_id)
    if row is None or row.user_id != user_id:
        return None
    if row.status != "pending":
        raise PendingOrderError(409, f"this order is already {row.status}")
    trigger = trigger_price if trigger_price is not None else float(row.trigger_price)
    stop = stop_loss_price if stop_loss_price is not None else (float(row.stop_loss_price) if row.stop_loss_price is not None else None)
    target = target_price if target_price is not None else (float(row.target_price) if row.target_price is not None else None)
    problem = bracket_problem(row.action, trigger, stop, target)
    if problem:
        raise PendingOrderError(422, problem)
    values: dict = {}
    if trigger_price is not None and trigger_price != float(row.trigger_price):
        try:
            ltp = deps.underlying_ltp(row.segment, row.symbol, token=token) if token else deps.underlying_ltp(row.segment, row.symbol)
        except UnknownUnderlying:
            raise PendingOrderError(404, f"unknown symbol {row.symbol} on {row.segment}")
        except UnderlyingUnavailable as exc:
            raise PendingOrderError(503, f"could not get a live price for {row.symbol} to move the order: {exc}")
        if ltp == trigger_price:
            raise PendingOrderError(422, "the price is already at the trigger: place a market order instead")
        values.update({P.trigger_price: trigger_price, P.started_above: ltp > trigger_price, P.last_price: ltp})
    if stop_loss_price is not None:
        values[P.stop_loss_price] = stop_loss_price
    if target_price is not None:
        values[P.target_price] = target_price
    if not values:
        return row
    updated = db.query(P).filter(P.id == order_id, P.user_id == user_id, P.status == "pending").update(values, synchronize_session=False)
    db.commit()
    db.refresh(row)
    if updated != 1:
        raise PendingOrderError(409, f"this order is already {row.status}")
    return row


def list_pending_orders(db: Session, user_id: uuid.UUID, status: Optional[str] = None, limit: int = 100) -> list[db_models.PendingOrder]:
    P = db_models.PendingOrder
    rows = db.query(P).filter(P.user_id == user_id).order_by(P.created_at.desc()).all()
    if status is not None:
        rows = [r for r in rows if r.status == status]
    return rows[:limit]


# --- the watcher ---------------------------------------------------------------------------------------------------------


def _finish(db: Session, order_id: uuid.UUID, status: str, reason: Optional[str], *, position_id=None, group_id=None) -> None:
    row = db.get(db_models.PendingOrder, order_id)
    row.status, row.status_reason = status, reason
    if position_id is not None:
        row.position_id = position_id
    if group_id is not None:
        row.option_group_id = group_id
    db.commit()


def _place(db: Session, order, deps: Deps) -> str:
    """Places a CLAIMED order (already committed as 'triggered'). Returns the final status."""
    from app.domain.position_manager import load_account, load_settings

    order_id, user_id = order.id, order.user_id
    positional = (order.horizon or "intraday") == "positional"
    account = load_account(db, user_id, order.segment, "positional" if positional else "intraday")
    if account is not None and account.live_trading_enabled:
        _finish(db, order_id, "failed", "the account went live while this order was armed: pending orders are paper-only, so it was not placed")
        return "failed"
    try:
        exec_settings = load_settings(db, user_id)
        if order.strategy in ("future", "spot"):
            opener = deps.open_spot if order.strategy == "spot" else deps.open_future
            if opener is None:
                raise RuntimeError("this watcher cannot place a positional order")
            row = opener(db, order, exec_settings)
            rejected, reason, position_id, group_id = row.status == "REJECTED", row.rejection_reason, row.id, None
            if not rejected:
                link_note_to_position(db, user_id, order.source_note_id, position_id)
                trade_snapshots.attach_plan_snapshot(db, order, position_id=position_id)
        else:
            row = deps.open_option(db, order, exec_settings)
            rejected, reason, position_id, group_id = row.status == "REJECTED", row.rejection_reason, None, row.id
            if not rejected:
                warnings = []
                for label, price, setter in (("stop-loss", order.stop_loss_price, deps.set_spot_stop), ("target", order.target_price, deps.set_spot_target)):
                    if price is None:
                        continue
                    try:
                        setter(db, user_id, row.id, float(price))
                    except Exception:
                        logger.exception("pending order %s: the %s did not attach", order_id, label)
                        warnings.append(f"the {label} did not attach")
                if warnings:
                    reason = "opened, but " + " and ".join(warnings) + ": set it on the position"
                trade_snapshots.attach_plan_snapshot(db, order, option_group_id=group_id)
    except Exception as exc:
        db.rollback()
        logger.exception("pending order %s could not be placed", order_id)
        _finish(db, order_id, "failed", f"could not place the order: {exc}")
        return "failed"
    status = "rejected" if rejected else "triggered"
    _finish(db, order_id, status, reason, position_id=position_id, group_id=group_id)
    return status


def process_pending_orders(db: Session, deps: Deps, now: Optional[datetime] = None) -> dict:
    """One pass of the watcher (app/scheduler.py): expire what is due, fetch each
    distinct underlying's price once, and fire what crossed."""
    now = now or _now()
    P = db_models.PendingOrder
    counts = {"checked": 0, "expired": 0, "triggered": 0, "rejected": 0, "failed": 0, "no_price": 0, "skipped": 0}

    counts["expired"] = (
        db.query(P)
        .filter(P.status == "pending", P.expires_at <= now)
        .update({P.status: "expired", P.status_reason: "expired before the price reached the trigger"}, synchronize_session=False)
    )
    db.commit()
    live = db.query(P).filter(P.status == "pending").all()

    # With JOB_QUOTES_USE_OWNER_KEYS each owner's orders are priced on that owner's own keys, so the
    # price is fetched once per (underlying, owner) instead of once per underlying.
    per_owner = settings.job_quotes_use_owner_keys
    prices: dict[tuple[str, str, Optional[uuid.UUID]], Optional[float]] = {}
    for r in live:
        owner = r.user_id if per_owner else None
        key = (r.segment, r.symbol, owner)
        if key not in prices:
            try:
                prices[key] = deps.underlying_ltp(r.segment, r.symbol, owner=owner) if owner is not None else deps.underlying_ltp(r.segment, r.symbol)
            except (UnknownUnderlying, UnderlyingUnavailable):
                prices[key] = None
            except Exception:
                logger.exception("pending orders: price lookup failed for %s", key)
                prices[key] = None

    for r in live:
        counts["checked"] += 1
        price = prices[(r.segment, r.symbol, r.user_id if per_owner else None)]
        if price is None:
            counts["no_price"] += 1  # retried next tick
            continue
        r.last_price, r.last_checked_at = price, now
        if not crossed(bool(r.started_above), float(r.trigger_price), price):
            continue
        # Manual trades are independent of the signal-conflict policies, so without this a waiting order would
        # quietly stack a second position on one already open. Skip it (cancelled, with the reason) unless the
        # person said adding was the point. One conditional UPDATE, like every other exit from 'pending'.
        held = None
        if deps.holds_open is not None and not r.allow_stacking:
            held = (
                deps.holds_open(db, r.user_id, r.segment, r.symbol, "positional")
                if (r.horizon or "intraday") == "positional"
                else deps.holds_open(db, r.user_id, r.segment, r.symbol)
            )
        if held:
            skipped = (
                db.query(P)
                .filter(P.id == r.id, P.status == "pending")
                .update(
                    {
                        P.status: "cancelled",
                        P.status_reason: f"skipped: you already hold {held}. Place it again with 'allow adding to my open position' if you want a second one.",
                    },
                    synchronize_session=False,
                )
            )
            db.commit()
            counts["skipped"] += skipped
            continue
        # Claim it BEFORE placing: at-most-once. A crash in _place can lose the
        # order, never place it twice. The claim is one conditional UPDATE, so if
        # another worker (or a cancel) got there first this matches nothing and we
        # leave the order alone.
        claimed = (
            db.query(P)
            .filter(P.id == r.id, P.status == "pending")
            .update({P.status: "triggered", P.triggered_at: now, P.status_reason: None}, synchronize_session=False)
        )
        db.commit()
        if claimed != 1:
            continue
        counts[_place(db, r, deps)] += 1
    db.commit()
    return counts

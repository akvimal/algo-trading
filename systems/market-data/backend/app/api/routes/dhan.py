"""Manual trigger + visibility for Dhan access-token renewal - mirrors
instruments.py's POST /instruments/sync + GET /instruments/sync-status
pair. The actual renewal also runs on a schedule (app/scheduler.py); this
exists for on-demand renewal and to see the current in-memory state
(app/providers/dhan.py's renew_access_token/renew_token_status).

Also the live market feed's status + manual subscribe endpoint - unlike
Delta's own feed, the Dhan feed is no longer auto-started on boot (its
reconnect-on-every-restart behavior was hammering Dhan's own account-wide
rate limit, which also blocks the plain REST quote API - reproduced live),
so POST /dhan/feed/subscribe below now calls start_feed() itself before
subscribing (idempotent - a no-op if the background thread's already
running) rather than relying on app.main's startup handler to have started
it already."""

import logging
from uuid import UUID

import requests
from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.adapters.accounts_client import get_user_dhan_credentials_strict
from app.auth import require_user_id
from app.config import settings
from app.domain.models import (
    DhanCredentialsUpdate,
    DhanOrderUpdatePostback,
    FeedSubscribeRequest,
    FundsResponse,
    InternalModifyOrderRequest,
    InternalPlaceOrderRequest,
    ModifyOrderRequest,
    OrderBookResponse,
    OrderResponse,
    PlaceOrderRequest,
)
from app.providers.dhan import DhanProvider, current_access_token, renew_access_token, renew_token_status, set_manual_credentials
from app.providers.dhan_feed import feed_status, start_feed, subscribe
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

# The platform operator's own ops surface (Dhan data-provider credentials,
# token renewal, live-feed status/subscribe). No login required (removed
# 2026-08-29 at the user's request) - this is a single-operator, self-
# hosted platform, and gating the screen an operator needs in order to get
# quotes working at all added friction without protecting anything a
# person on this same box couldn't already do.
router = APIRouter()


@router.get("/dhan/token-expiry")
def token_expiry():
    # Narrower than /dhan/token-status below (just the expiry timestamp) -
    # kept as its own route since shell/index.html's global "Dhan token
    # expiring soon" banner has polled this one specifically since
    # 2026-08-29 and there's no reason to churn its URL now.
    return {"token_expires_at": renew_token_status()["token_expires_at"]}


@router.post("/dhan/renew-token")
def renew_token():
    try:
        return renew_access_token()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/dhan/token-status")
def token_status():
    # dhan_client_id/has_access_token surface what's CURRENTLY configured
    # (from .env, or a prior PUT /dhan/credentials) - has_access_token is
    # a presence check only, never the raw secret itself.
    return {
        **renew_token_status(),
        "dhan_client_id": settings.dhan_client_id,
        "has_access_token": bool(current_access_token()),
    }


@router.put("/dhan/credentials")
def update_credentials(payload: DhanCredentialsUpdate):
    """The UI's 'Data provider keys' form - sets both the Dhan client ID
    and access token at runtime, no restart needed (see
    set_manual_credentials' own docstring for the in-memory-only caveat)."""
    set_manual_credentials(payload.client_id, payload.access_token)
    return token_status()


@router.get("/dhan/feed-status")
def get_feed_status():
    return feed_status()


@router.post("/dhan/feed/subscribe")
def subscribe_feed(payload: FeedSubscribeRequest):
    start_feed()
    try:
        ok = subscribe(payload.exchange, payload.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(
            status_code=404, detail=f"could not resolve '{payload.symbol}' on exchange '{payload.exchange}' for the live feed"
        )
    return feed_status()


# ---------------------------------------------------------------------------
# Live-broker-adapter P0 (see docs/architecture.md) - order-placement routes.
# Unlike every route above (the platform operator's own ops surface, no
# login required), these place REAL money-moving orders on a real person's
# own Dhan account, so they are require_user_id-gated (a real, specific,
# authenticated user - see app/auth.py's own docstring on why) and always
# resolve that user's OWN BYO credentials via get_user_dhan_credentials_strict
# (raises rather than silently falling back to the platform-default
# credential, unlike every read-only quote/candle/option-chain route in this
# service). Only NSE/MCX (Dhan) support real order placement today - CRYPTO
# is a different broker (Delta Exchange India) with no order API implemented
# yet at all (see the plan's own P3 item 16).
# ---------------------------------------------------------------------------


def _dhan_provider_for(exchange: str) -> DhanProvider:
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not isinstance(provider, DhanProvider):
        raise HTTPException(status_code=400, detail=f"real order placement is not supported for exchange={exchange!r} yet")
    return provider


def _strict_credentials(user_id: UUID):
    """get_user_dhan_credentials_strict raises RuntimeError both when this
    user has no Dhan credentials configured and when accounts itself is
    unreachable - a caller condition (400), not this service's own fault
    (502), in the first case; every route below treats both the same way
    a person would want to see it (a clear 400, not an unhandled 500)."""
    try:
        return get_user_dhan_credentials_strict(user_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/dhan/orders", response_model=OrderResponse)
def place_order(payload: PlaceOrderRequest, user_id: UUID = Depends(require_user_id)):
    provider = _dhan_provider_for(payload.exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.place_order(
            symbol=payload.symbol,
            transaction_type=payload.transaction_type,
            quantity=payload.quantity,
            order_type=payload.order_type,
            product_type=payload.product_type,
            price=payload.price,
            trigger_price=payload.trigger_price,
            correlation_id=payload.correlation_id,
            credentials=credentials,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.put("/dhan/orders/{order_id}", response_model=OrderResponse)
def modify_order(order_id: str, payload: ModifyOrderRequest, exchange: str, user_id: UUID = Depends(require_user_id)):
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.modify_order(
            order_id=order_id,
            order_type=payload.order_type,
            quantity=payload.quantity,
            price=payload.price,
            trigger_price=payload.trigger_price,
            credentials=credentials,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.delete("/dhan/orders/{order_id}", response_model=OrderResponse)
def cancel_order(order_id: str, exchange: str, user_id: UUID = Depends(require_user_id)):
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.cancel_order(order_id, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.get("/dhan/orders/{order_id}", response_model=OrderResponse)
def get_order(order_id: str, exchange: str, user_id: UUID = Depends(require_user_id)):
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.get_order(order_id, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if raw is None:
        raise HTTPException(status_code=404, detail=f"no such order '{order_id}'")
    return OrderResponse(raw=raw)


@router.get("/dhan/order-book", response_model=OrderBookResponse)
def get_order_book(exchange: str, user_id: UUID = Depends(require_user_id)):
    """The reconciliation job's own source of truth for a broker_orders row
    stuck SUBMITTING with no broker_order_id yet - see
    DhanProvider.get_order_book's own docstring."""
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        orders = provider.get_order_book(credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderBookResponse(orders=orders)


@router.get("/dhan/funds", response_model=FundsResponse)
def get_funds(exchange: str, user_id: UUID = Depends(require_user_id)):
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.get_funds(credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return FundsResponse(raw=raw)


def _require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    if x_internal_secret != settings.internal_service_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid internal service secret")


@router.get("/internal/dhan/order-book", dependencies=[Depends(_require_internal_secret)])
def internal_get_order_book(user_id: UUID, exchange: str):
    """service-to-service counterpart to GET /dhan/order-book above - for
    execution's own reconciliation job (app/scheduler.py there), which has
    no live user bearer token to forward (a scheduled job runs with no
    request/session context at all). Mirrors systems/accounts' identical
    GET /internal/credentials/{user_id}/dhan pattern: a shared secret
    header stands in for a JWT when the caller is a trusted service acting
    on a specific user's behalf, not a person with a live session."""
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        orders = provider.get_order_book(credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"orders": orders}


@router.post("/internal/dhan/orders", dependencies=[Depends(_require_internal_secret)])
def internal_place_order(payload: InternalPlaceOrderRequest):
    """service-to-service counterpart to POST /dhan/orders above - live-
    broker-adapter P2 (see docs/architecture.md), for execution's
    scheduler jobs (a REAL market exit when the exit-monitor/square-off
    job itself needs to close a live position - never a new entry, which
    only ever happens from a real logged-in HTTP request). See GET
    /internal/dhan/order-book's own docstring for the shared-secret-
    instead-of-JWT reasoning."""
    provider = _dhan_provider_for(payload.exchange)
    credentials = _strict_credentials(payload.user_id)
    try:
        raw = provider.place_order(
            symbol=payload.symbol,
            transaction_type=payload.transaction_type,
            quantity=payload.quantity,
            order_type=payload.order_type,
            product_type=payload.product_type,
            price=payload.price,
            trigger_price=payload.trigger_price,
            correlation_id=payload.correlation_id,
            credentials=credentials,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.put("/internal/dhan/orders/{order_id}", dependencies=[Depends(_require_internal_secret)])
def internal_modify_order(order_id: str, payload: InternalModifyOrderRequest):
    """service-to-service counterpart to PUT /dhan/orders/{id} above - the
    throttled trailing-SL reconciliation job's own mechanism to move a
    resting order's trigger price, called from execution's scheduler
    (no live user token available there)."""
    provider = _dhan_provider_for(payload.exchange)
    credentials = _strict_credentials(payload.user_id)
    try:
        raw = provider.modify_order(
            order_id=order_id,
            order_type=payload.order_type,
            quantity=payload.quantity,
            price=payload.price,
            trigger_price=payload.trigger_price,
            credentials=credentials,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.delete("/internal/dhan/orders/{order_id}", dependencies=[Depends(_require_internal_secret)])
def internal_cancel_order(order_id: str, user_id: UUID, exchange: str):
    """service-to-service counterpart to DELETE /dhan/orders/{id} above -
    cancels a resting order from the scheduler (e.g. a resting stop-loss
    that must be pulled before a reactive market exit fires for the same
    position, to avoid two real closing orders in flight at once - see
    position_manager._settle_live_exit's own docstring)."""
    provider = _dhan_provider_for(exchange)
    credentials = _strict_credentials(user_id)
    try:
        raw = provider.cancel_order(order_id, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return OrderResponse(raw=raw)


@router.post("/dhan/order-update/{secret}")
def dhan_order_update_postback(secret: str, payload: DhanOrderUpdatePostback):
    """Dhan's own order-status postback - registered with Dhan as
    https://<this-host>/dhan/order-update/<dhan_postback_secret> (see
    config.py's own comment: Dhan doesn't cryptographically sign postback
    requests, so this shared-secret PATH segment is the only thing
    keeping the URL from being spoofable by anyone who guesses it).
    market-data holds no order state of its own (see broker_orders' own
    "each system owns its own schema" placement in execution) - this
    route only validates the secret and relays the raw payload on to
    execution's internal ingestion endpoint, which is what actually
    updates the matching broker_orders row."""
    if secret != settings.dhan_postback_secret:
        raise HTTPException(status_code=404)
    try:
        resp = requests.post(
            f"{settings.execution_base_url}/internal/dhan/order-update",
            json=payload.model_dump(),
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=10,
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException:
        logger.exception("failed to relay Dhan order-update postback to execution: %s", payload.model_dump())
        raise HTTPException(status_code=502, detail="could not relay postback to execution")
    return {"relayed": True}

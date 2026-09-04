"""Thin HTTP client to the market-data system. execution never embeds a
broker SDK or credentials directly - see docs/architecture.md."""

import logging
from datetime import date
from typing import Optional

import requests

from app.config import settings

logger = logging.getLogger(__name__)


def get_ltp(exchange: str, symbol: str) -> float:
    resp = requests.get(
        f"{settings.market_data_base_url}/quotes/ltp",
        params={"exchange": exchange, "symbol": symbol},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return float(resp.json()["ltp"])


def _auth_headers(token: Optional[str]) -> Optional[dict]:
    """Phase 3 (BYO Dhan credentials, see docs/architecture.md) - when the
    calling route has a real user's own bearer token in scope (the
    manual-order/square-off routes, since Phase 2), forwarding it lets
    market-data resolve and use THAT user's own Dhan credentials/rate
    budget instead of the platform default. None (the default - the
    scheduler jobs and the automated orders_consumer.py flow, neither of
    which has a single user to attribute a call to) sends no
    Authorization header at all, which market-data treats identically to
    today - see market-data's app/auth.py's own docstring."""
    return {"Authorization": f"Bearer {token}"} if token else None


def get_ltp_batch(exchange: str, symbols: list[str], token: Optional[str] = None) -> dict[str, float]:
    """All symbols for one exchange in a single market-data call - see
    position_manager.compute_unrealized_pnl/square_off_all_open, which
    call this once per exchange instead of once per position.

    A network/timeout failure (market-data or its upstream Dhan being slow
    or rate-limited) returns `{}`, NOT an exception: every consumer already
    treats a missing quote as "degrade gracefully" (P&L shows blank, an
    exit-monitor tick skips the position and retries, a manual square-off
    returns `quote_unavailable` for the UI to surface and retry). Letting
    the raw `requests` exception propagate instead turned a transient Dhan
    slowdown into a 500 / "Failed to fetch" on the user's square-off."""
    if not symbols:
        return {}
    try:
        resp = requests.post(
            f"{settings.market_data_base_url}/quotes/ltp/batch",
            json={"exchange": exchange, "symbols": symbols},
            headers=_auth_headers(token),
            timeout=settings.market_data_timeout_seconds,
        )
        resp.raise_for_status()
        return resp.json()["prices"]
    except requests.exceptions.RequestException as exc:
        logger.warning("get_ltp_batch failed for %s (%d symbols): %s", exchange, len(symbols), exc)
        return {}


def get_previous_candle(exchange: str, symbol: str, interval: str, token: Optional[str] = None) -> Optional[dict]:
    """Most recently completed candle only (see market-data's GET
    /candles/previous) - None if unavailable (unknown symbol, or no
    completed candle yet e.g. just after market open), not an error."""
    resp = requests.get(
        f"{settings.market_data_base_url}/candles/previous",
        params={"exchange": exchange, "symbol": symbol, "interval": interval},
        headers=_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_candle_history(
    exchange: str, symbol: str, interval: str, from_date: date, to_date: date, token: Optional[str] = None
) -> list[dict]:
    """A general multi-bar series over [from_date, to_date] (see
    market-data's GET /candles/history) - unlike get_previous_candle
    above, which only ever returns one value. Only used by
    stop_loss_method='indicator' (position_manager.py), which needs
    enough history to warm up a computation like EMA, not just the latest
    completed bar. Oldest-first, matching signal-generation's own client
    wrapper of the same route (app/adapters/market_data/client.py there) -
    duplicated, not shared, per the systems/* self-containment rule.
    Empty list (not None) if unavailable - callers already treat "not
    enough bars" and "no bars at all" the same way."""
    resp = requests.get(
        f"{settings.market_data_base_url}/candles/history",
        params={"exchange": exchange, "symbol": symbol, "interval": interval, "from": from_date.isoformat(), "to": to_date.isoformat()},
        headers=_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    return resp.json()


def resolve_symbol_by_security_id(exchange: str, security_id: str) -> Optional[str]:
    """Given a raw Dhan security ID (an option leg's own security_id, from
    signal-processing's resolved order - see docs/architecture.md Phase
    4d), the trading symbol it belongs to - None if unknown. Called once
    per leg at option-group open time; everything after that reuses the
    ordinary symbol-keyed get_ltp_batch/get_lot_size unchanged."""
    resp = requests.get(
        f"{settings.market_data_base_url}/instruments/resolve-by-security-id",
        params={"exchange": exchange, "security_id": security_id},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()["symbol"]


def resolve_underlying(segment: str, underlying: str) -> Optional[dict]:
    """What to reference an option chain against for a logical underlying
    (e.g. "GOLDM", "NIFTY", "BTCUSD") - chart_symbol specifically, not
    trade_symbol: an NSE index option's underlying is the index SPOT
    (chart_symbol), not the active-month future actually traded
    (trade_symbol) - see market-data's DhanProvider.resolve_underlying.
    Only used by open_manual_option_group (Manual tab's option path) -
    the signal-driven path never calls this itself, since signal-
    processing already resolved everything before publishing to
    orders.resolved. None if unresolvable. Raw dict (chart_symbol,
    chart_exchange, trade_symbol, trade_exchange, lot_size, expiry), not
    re-modeled - callers only ever read chart_symbol/chart_exchange."""
    resp = requests.get(
        f"{settings.market_data_base_url}/instruments/resolve",
        params={"segment": segment, "underlying": underlying},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_expiry_list(exchange: str, symbol: str, token: Optional[str] = None) -> Optional[list[str]]:
    """Active option expiry dates (YYYY-MM-DD) for `symbol` on `exchange` -
    None if unresolvable (unknown underlying, or market-data has no
    option-chain support for this exchange). Only used by
    open_manual_option_group, to validate the user-picked expiry is a
    real, currently-tradeable one before building legs against it."""
    resp = requests.get(
        f"{settings.market_data_base_url}/options/expiries",
        params={"exchange": exchange, "symbol": symbol},
        headers=_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()["expiries"]


def get_option_chain(exchange: str, symbol: str, expiry: str, token: Optional[str] = None) -> Optional[dict]:
    """Full option chain for `symbol` at `expiry` - the raw JSON shape
    market-data's GET /options/chain returns, not re-modeled here since
    app/domain/option_templates.py only ever reads a few fields off it.
    None if unresolvable."""
    resp = requests.get(
        f"{settings.market_data_base_url}/options/chain",
        params={"exchange": exchange, "symbol": symbol, "expiry": expiry},
        headers=_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def _require_auth_headers(token: str) -> dict:
    """Unlike _auth_headers above (Optional, degrades to the platform-
    default credential), every live-broker-adapter order-placement call
    below MUST be attributed to a real, specific user - market-data's own
    require_user_id route dependency 401s outright with no token at all,
    and get_user_dhan_credentials_strict never falls back to the platform
    default even if one were forwarded. A blank/missing token here is a
    caller bug (a real order route invoked outside a real user's request
    context), not a degrade-gracefully case - see live-broker-adapter
    plan P0 item 1."""
    if not token:
        raise RuntimeError("a real user bearer token is required to place/modify/cancel a real Dhan order")
    return {"Authorization": f"Bearer {token}"}


def place_broker_order(
    exchange: str,
    symbol: str,
    transaction_type: str,
    quantity: int,
    order_type: str,
    product_type: str,
    token: str,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
    correlation_id: Optional[str] = None,
) -> dict:
    """POST market-data's /dhan/orders - places a REAL order. `correlation_id`
    should always be the caller's own broker_orders.client_order_id (see
    that table's own comment on the submit-then-crash idempotency story)."""
    resp = requests.post(
        f"{settings.market_data_base_url}/dhan/orders",
        json={
            "exchange": exchange,
            "symbol": symbol,
            "transaction_type": transaction_type,
            "quantity": quantity,
            "order_type": order_type,
            "product_type": product_type,
            "price": price,
            "trigger_price": trigger_price,
            "correlation_id": correlation_id,
        },
        headers=_require_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def modify_broker_order(
    exchange: str,
    broker_order_id: str,
    order_type: str,
    quantity: int,
    token: str,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
) -> dict:
    """PUT market-data's /dhan/orders/{id} - the throttled trailing-SL
    reconciliation job's own mechanism to move a resting SL/SL-M order's
    trigger price (live-broker-adapter plan P2)."""
    resp = requests.put(
        f"{settings.market_data_base_url}/dhan/orders/{broker_order_id}",
        params={"exchange": exchange},
        json={"order_type": order_type, "quantity": quantity, "price": price, "trigger_price": trigger_price},
        headers=_require_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def cancel_broker_order(exchange: str, broker_order_id: str, token: str) -> dict:
    resp = requests.delete(
        f"{settings.market_data_base_url}/dhan/orders/{broker_order_id}",
        params={"exchange": exchange},
        headers=_require_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def get_broker_order_book(exchange: str, token: str) -> list[dict]:
    """Every order currently on this user's Dhan account, regardless of our
    own DB state - the reconciliation job's own source of truth for a
    broker_orders row stuck 'submitting' with no broker_order_id yet."""
    resp = requests.get(
        f"{settings.market_data_base_url}/dhan/order-book",
        params={"exchange": exchange},
        headers=_require_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["orders"]


def get_broker_funds(exchange: str, token: str) -> dict:
    """Real available funds/margin (Dhan's Fund Limit API, via market-data) -
    replaces trusting the simulated execution.accounts.current_balance
    ledger for any live_trading_enabled account - live-broker-adapter plan
    P0 item 5."""
    resp = requests.get(
        f"{settings.market_data_base_url}/dhan/funds",
        params={"exchange": exchange},
        headers=_require_auth_headers(token),
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def get_broker_order_book_internal(exchange: str, user_id: str) -> list[dict]:
    """service-to-service counterpart to get_broker_order_book above - for
    the reconciliation job (app/scheduler.py), which runs with no live
    user bearer token to forward (a scheduled job has no request/session
    context at all). Calls market-data's shared-secret-gated GET
    /internal/dhan/order-book instead - see that route's own docstring."""
    resp = requests.get(
        f"{settings.market_data_base_url}/internal/dhan/order-book",
        params={"exchange": exchange, "user_id": user_id},
        headers={"X-Internal-Secret": settings.internal_service_secret},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["orders"]


def place_broker_order_internal(
    exchange: str,
    symbol: str,
    transaction_type: str,
    quantity: int,
    order_type: str,
    product_type: str,
    user_id: str,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
    correlation_id: Optional[str] = None,
) -> dict:
    """service-to-service counterpart to place_broker_order above - for the
    exit-monitor/square-off scheduler jobs (app/scheduler.py), which have
    no live user bearer token to forward. Used ONLY to close an already-
    open live position for real (never to open a new one - a live entry
    only ever happens from a real logged-in HTTP request) - see
    app/domain/live_broker.py's submit_exit_order_scheduled."""
    resp = requests.post(
        f"{settings.market_data_base_url}/internal/dhan/orders",
        json={
            "exchange": exchange,
            "symbol": symbol,
            "transaction_type": transaction_type,
            "quantity": quantity,
            "order_type": order_type,
            "product_type": product_type,
            "price": price,
            "trigger_price": trigger_price,
            "correlation_id": correlation_id,
            "user_id": user_id,
        },
        headers={"X-Internal-Secret": settings.internal_service_secret},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def modify_broker_order_internal(
    exchange: str,
    broker_order_id: str,
    order_type: str,
    quantity: int,
    user_id: str,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
) -> dict:
    """service-to-service counterpart to modify_broker_order above - the
    throttled trailing-SL reconciliation job's own mechanism, called from
    the exit-monitor scheduler job (no live user token available there)."""
    resp = requests.put(
        f"{settings.market_data_base_url}/internal/dhan/orders/{broker_order_id}",
        json={
            "exchange": exchange,
            "order_type": order_type,
            "quantity": quantity,
            "price": price,
            "trigger_price": trigger_price,
            "user_id": user_id,
        },
        headers={"X-Internal-Secret": settings.internal_service_secret},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def cancel_broker_order_internal(exchange: str, broker_order_id: str, user_id: str) -> dict:
    """service-to-service counterpart to cancel_broker_order above - pulls a
    resting order from the scheduler (e.g. a resting stop-loss that must be
    cancelled before a reactive market exit fires for the same position -
    see position_manager._settle_live_exit's own docstring on why)."""
    resp = requests.delete(
        f"{settings.market_data_base_url}/internal/dhan/orders/{broker_order_id}",
        params={"exchange": exchange, "user_id": user_id},
        headers={"X-Internal-Secret": settings.internal_service_secret},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["raw"]


def get_lot_size(exchange: str, symbol: str) -> Optional[float]:
    """Lot size for an already-resolved trading symbol (see market-data's
    GET /instruments/lot-size) - None if unknown, not an error. Only
    called for instrument_type='future' orders (see
    position_manager.open_position) - the NSE-spot path never pays this
    extra call. int for NSE/MCX F&O; a real fraction for Delta Exchange
    India CRYPTO perpetuals (e.g. BTCUSD=0.001) - previously truncated to
    int() here, which silently zeroed every CRYPTO future's lot size and
    crashed sizing with a division by zero (reproduced live)."""
    resp = requests.get(
        f"{settings.market_data_base_url}/instruments/lot-size",
        params={"exchange": exchange, "symbol": symbol},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return float(resp.json()["lot_size"])

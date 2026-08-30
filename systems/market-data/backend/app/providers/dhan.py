"""Dhan v2 API provider - NSE equity/index/index-futures and MCX
commodity futures.

The instrument master (trading symbol -> security ID) is Dhan's own
reference data, downloaded fresh on a schedule rather than treated as
something we own long-term - see https://dhanhq.co/docs/v2/instruments/.

One DhanProvider instance covers one *exchange* (matching router.py's
exchange-keyed dispatch), but can hold several SegmentConfigs - e.g. the
NSE instance holds cash-equity, index-spot, and index-futures configs,
since Dhan's own API segments those independently even though they're
all "NSE" as far as the rest of this platform is concerned. Every
Dhan-specific field value used below (SEM_* CSV columns, the ltp/candle
"segment key" strings) was checked against a live download of the real
instrument-master CSV before being hardcoded here - see
docs/architecture.md Phase 3 for the verification note. The CSV columns
(SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_INSTRUMENT_NAME, SM_SYMBOL_NAME,
SEM_LOT_UNITS, SEM_EXPIRY_DATE) are confirmed directly from that
download; the marketfeed/charts "segment key" strings themselves
(NSE_EQ, MCX_COMM, NSE_FNO, IDX_I) aren't present in the CSV at all -
NSE_EQ is proven correct by this file's pre-existing working code, the
other three are Dhan's documented exchangeSegment values. One thing that
DIDN'T hold up under a live download despite an earlier assumption
baked into this file's own tests: SEM_TRADING_SYMBOL for options only
encodes month+year, not the exact day (unlike futures, where Dhan's own
symbols already include the day) - real weekly/monthly contracts at the
same strike collide on one symbol string as a result. A second, related
gap surfaced right after fixing the first: SEM_STRIKE_PRICE isn't always
a whole number either (e.g. IOC/CANBK both list a .5 strike alongside
the whole-number one, same expiry) - naively coercing it to int
reintroduces the identical collision class one field over. See
_disambiguated_option_symbol's own docstring - both confirmed live
2026-08-14 against real Dhan data, not assumed.
"""

import base64
import csv
import io
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Callable, Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.domain.candle_aggregation import aggregate_candles, resolve_interval_minutes
from app.domain.models import (
    Candle,
    DataAvailability,
    OptionChain,
    OptionChainStrike,
    OptionGreeks,
    OptionLegCandle,
    OptionLegQuote,
    ResolvedUnderlying,
)
from app.domain.moneyness import classify_moneyness, infer_strike_step
from app.providers.base import QuoteProvider

logger = logging.getLogger(__name__)

INSTRUMENT_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
LTP_URL = "https://api.dhan.co/v2/marketfeed/ltp"
CANDLE_URL = "https://api.dhan.co/v2/charts/intraday"
# Dhan's separate daily-bars endpoint (see the DHAN_CANDLE_INTERVAL_MINUTES
# comment below for why interval='daily' can't go through CANDLE_URL) -
# same auth/response-field shape as charts/intraday per Dhan's own docs,
# just date-keyed instead of interval-keyed, and with no 90-day-per-request
# cap ("available back upto the date of its inception") - see
# _fetch_historical_candles.
HISTORICAL_URL = "https://api.dhan.co/v2/charts/historical"
RENEW_TOKEN_URL = "https://api.dhan.co/v2/RenewToken"
OPTION_CHAIN_URL = "https://api.dhan.co/v2/optionchain"
OPTION_EXPIRY_LIST_URL = "https://api.dhan.co/v2/optionchain/expirylist"
ROLLING_OPTION_URL = "https://api.dhan.co/v2/charts/rollingoption"
# Dhan Order API v2 (place/modify/cancel/get/order-book/funds) -
# https://dhanhq.co/docs/v2/orders/ and /docs/v2/funds/. UNLIKE every URL
# above, these field names/shapes are NOT yet verified against a live
# Dhan response the way this file's own module docstring says every
# other endpoint here was - place_order/modify_order/cancel_order/
# get_order/get_order_book/get_funds below are best-effort from general
# API documentation, written before any real order was ever placed
# through this platform (see docs/architecture.md's "live broker
# adapter" roadmap item). CONFIRM every field name/response shape against
# a live Dhan sandbox call before this is ever pointed at a real account.
ORDERS_URL = "https://api.dhan.co/v2/orders"
FUNDS_URL = "https://api.dhan.co/v2/fundlimit"

# Dhan's charts/intraday only *natively* supports these interval values
# (minutes) - notably 25, not 30, and no daily granularity at all
# ('daily' is served by the separate HISTORICAL_URL endpoint instead - see
# get_candle_history's own dispatch and _fetch_historical_candles). Any
# other "Nmin" interval (3min, 2min, 10min, 20min, 30min, ...) is served by
# fetching native 1min bars and aggregating them locally - see
# _interval_minutes/_aggregate_candles below - so the interval vocabulary
# used by Strategy's interval (signal-generation) is NOT limited to this
# dict; it's just which values skip local aggregation.
DHAN_CANDLE_INTERVAL_MINUTES = {"1min": 1, "5min": 5, "15min": 15, "25min": 25, "60min": 60}

# Dhan's own hard per-request cap on charts/intraday - confirmed live
# (2026-08-16) via the exact rejection: {"errorType":"Input_Exception",
# "errorCode":"DH-905","errorMessage":"Data for Intraday Charts can be
# fetched for 90 days at a time"}. Real history goes back years (verified
# same day: real 1min/60min bars for NSE:TCS as far back as 2017), but
# get_candle_history above makes exactly one request and doesn't chunk a
# wider range the way option_backtest.py's get_option_leg_history does -
# so 90 days is the actual usable ceiling for a single backtest today.
DHAN_INTRADAY_MAX_DAYS_PER_REQUEST = 90


def _interval_minutes(interval: str) -> int:
    """Dhan's own native-interval dict, delegated to the shared
    provider-agnostic resolver (app/domain/candle_aggregation.py) - see
    there for why this got extracted (app/providers/delta.py needs the
    exact same logic against its own, different native set)."""
    return resolve_interval_minutes(interval, DHAN_CANDLE_INTERVAL_MINUTES)


def _aggregate_candles(one_min_candles: list[Candle], interval: str, minutes: int) -> list[Candle]:
    """Delegates to the shared aggregate_candles - see
    app/domain/candle_aggregation.py."""
    return aggregate_candles(one_min_candles, interval, minutes)

# Dhan doesn't publish a specific rate limit for charts/intraday (unlike
# marketfeed/ltp's documented-and-empirically-confirmed 1 req/sec) - this
# is a conservative default, not a known requirement. Kept as independent
# throttle state from the LTP throttle below (own lock, own timestamp)
# since these hit a different Dhan endpoint - no reason for one to
# serialize behind the other.
MIN_CANDLE_CALL_INTERVAL_SECONDS = 2.0

# Dhan's LTP endpoint is limited to 1 request/second, but empirically a
# ~1.05s gap still gets 429'd - build in real margin rather than shaving
# it close. It supports up to 1000 instruments per call, so get_ltp_batch
# fetches everything needed in ONE throttled call regardless of how many
# distinct symbols are open - a per-symbol loop here would mean N*2s to
# refresh N symbols, which is structurally slower than most poll
# intervals once N is more than a couple (this was found the hard way -
# see docs/architecture.md).
MIN_LTP_CALL_INTERVAL_SECONDS = 2.0

# Short-lived cache so repeated lookups within a few seconds (e.g.
# execution's frontend polling every 5s) hit memory instead of making a
# fresh Dhan call at all. A stepping stone toward a Dhan WebSocket feed
# (ticks kept in memory, no per-request outbound call at all) - see
# docs/architecture.md.
QUOTE_CACHE_TTL_SECONDS = 3.0

# If the throttle wait already implied by another in-flight request is
# longer than this, fail fast instead of piling another thread onto the
# queue - callers already treat a failed quote as "unavailable, try again
# later" rather than something to block indefinitely on.
MAX_THROTTLE_WAIT_SECONDS = 4.0

# Dhan's documented order-API rate limit is NOT yet confirmed against
# current docs (unlike MIN_LTP_CALL_INTERVAL_SECONDS/
# MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS below, which were) - this is a
# deliberately conservative placeholder. Narrow it only after checking
# Dhan's current published order-API rate limit.
MIN_ORDER_CALL_INTERVAL_SECONDS = 1.0

# Dhan documents this one explicitly (unlike LTP/candle above, which are
# empirically-derived): 1 unique request per 3 seconds. Own lock/timestamp
# - a different Dhan endpoint, no reason to serialize behind LTP/candle.
MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS = 3.0
# 30s, not a QUOTE_CACHE_TTL_SECONDS-style few-second value: get_option_chain
# is called synchronously from signal-processing's option-strategy
# resolution on every incoming signal - a short TTL meant a near-guaranteed
# cache miss (and therefore a full throttle-wait + live Dhan round trip) on
# every single resolution, which could exceed the caller's own request
# timeout under any throttle contention (MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS
# above already costs up to 3s of queueing on its own). Strike structure
# doesn't meaningfully change within 30s; only OI/last-traded-price/greeks
# inside a cached chain go stale, and those aren't what position entry
# price is sourced from (execution fetches a fresh LTP at open time
# instead - see docs/architecture.md). See EXPIRY_LIST_CACHE_TTL_SECONDS
# below for get_expiry_list's own (longer) cache.
OPTION_CHAIN_CACHE_TTL_SECONDS = 30.0
# Longer than OPTION_CHAIN_CACHE_TTL_SECONDS deliberately: an expiry LIST
# changes far less often intraday than a chain's OI/LTP does (a new weekly
# expiry only ever appears once a week) - a 5-minute TTL is still safely
# fresh while eliminating the 3s throttle wait for the overwhelming
# majority of same-burst resolutions (e.g. a multi-symbol Chartink alert,
# or repeated manual tests against the same underlying) - previously this
# endpoint had NO cache at all and paid the full throttle on every single
# resolution, confirmed live 2026-08-14 as the dominant cost of a
# multi-symbol option-strategy webhook call (~12s for 2 symbols).
EXPIRY_LIST_CACHE_TTL_SECONDS = 300.0

# How long GET /options/oi-summary's per-leg OI history is retained -
# comfortably past the 15-minute window that endpoint's widest change
# figure needs, so there's always a sample old enough to diff against
# once the buffer's been running that long.
OI_HISTORY_RETENTION_SECONDS = 20 * 60

# Dhan doesn't separately document a rate limit for charts/rollingoption -
# same conservative default as the option-chain family above, own
# lock/timestamp (a distinct endpoint, no reason to serialize behind
# option-chain calls). No response caching here (unlike option chain) -
# a historical range isn't a single value that goes stale on a fixed TTL,
# same reasoning as get_candle_history.
MIN_OPTION_HISTORY_CALL_INTERVAL_SECONDS = 3.0
# Dhan documents a hard 30-day-per-call limit on this endpoint - a wider
# caller-requested range is served by chunking into consecutive <=30-day
# slices and concatenating, same spirit as this file's other range-vs-
# single-call distinctions.
OPTION_HISTORY_MAX_DAYS_PER_CALL = 30

# rollingoption's exchangeSegment/instrument describe where the OPTION
# itself trades, not the underlying's own segment (contrast
# resolve_feed_target's ltp_segment_key, e.g. "IDX_I"/"NSE_EQ" - those are
# the UNDERLYING's segment, wrong for this endpoint). Confirmed via Dhan's
# own docs example (exchangeSegment="NSE_FNO", instrument="OPTIDX" for a
# NIFTY/index request) and annexure (instrument enum includes OPTIDX/
# OPTSTK/OPTFUT, but the only MCX exchange-segment value Dhan documents at
# all is MCX_COMM - no MCX derivatives segment). This endpoint's own docs
# ("both Index Options and Stock Options data") and independent
# confirmation ("for all NSE & BSE instruments") only ever mention NSE/BSE
# - MCX (FUTCOM underlyings) is assumed unsupported here, unlike Phase
# 4a/4b's option-chain/live-resolution paths which do cover MCX. Reconfirm
# once live Dhan access resumes - see docs/architecture.md Phase 4c.
_ROLLING_OPTION_INSTRUMENT_BY_CANDLE_INSTRUMENT = {"INDEX": "OPTIDX", "EQUITY": "OPTSTK"}
ROLLING_OPTION_EXCHANGE_SEGMENT = "NSE_FNO"

# Shared, in-memory access-token state - genuinely global (not per
# DhanProvider instance) since router.py's two instances (dhan-nse,
# dhan-mcx) share one Dhan account/token. Mirrored to
# settings.dhan_credentials_file_path on every change (see
# _persist_credentials/load_persisted_credentials below) so a
# UI-submitted token survives a container restart instead of silently
# reverting to DHAN_ACCESS_TOKEN from the environment - see
# docs/architecture.md.
_token_lock = threading.Lock()
_renewed_token: Optional[str] = None  # None until the first successful renewal
_last_renewed_at: Optional[datetime] = None
_last_renewal_response: Optional[dict] = None  # raw Dhan response, for the status endpoint


def _persist_credentials(client_id: str, access_token: str) -> None:
    """Best-effort durable copy of the active credentials - a plain JSON
    file on a Docker-mounted volume (app/config.py's
    dhan_credentials_file_path), not a DB, matching this service's own
    "in-memory cache, cheap to rebuild" design (see its README) rather
    than adding one just for this. Failures are logged, not raised - a
    write failure (e.g. the volume isn't mounted in some environment)
    should degrade to the pre-existing in-memory-only behavior, not break
    PUT /dhan/credentials itself."""
    path = settings.dhan_credentials_file_path
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Write to a temp file then rename (atomic on the same filesystem)
        # so a crash mid-write never leaves a truncated/corrupt file behind
        # for the next load_persisted_credentials() to choke on.
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w") as f:
            json.dump({"client_id": client_id, "access_token": access_token}, f)
        os.replace(tmp_path, path)
    except OSError:
        logger.exception("could not persist Dhan credentials to %s - staying in-memory-only this run", path)


def load_persisted_credentials() -> None:
    """Called once at app startup (app/main.py) - restores whatever was
    last saved via PUT /dhan/credentials, so it's active immediately
    without anyone needing to re-submit it after every restart. A no-op
    (falls through to DHAN_ACCESS_TOKEN/DHAN_CLIENT_ID from the
    environment, the pre-existing behavior) if the file doesn't exist yet
    - a brand new volume, or an environment that's never used the UI."""
    path = settings.dhan_credentials_file_path
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            data = json.load(f)
        client_id = data["client_id"]
        access_token = data["access_token"]
    except (OSError, ValueError, KeyError):
        logger.exception("could not load persisted Dhan credentials from %s - falling back to the environment seed", path)
        return

    global _renewed_token, _last_renewed_at
    settings.dhan_client_id = client_id
    with _token_lock:
        _renewed_token = access_token
        _last_renewed_at = datetime.now(timezone.utc)
    logger.info("restored persisted Dhan credentials from %s", path)


def current_access_token() -> str:
    """The token every DhanProvider request should use - the last
    successfully renewed one if there's been one, else whatever's in
    DHAN_ACCESS_TOKEN (the .env seed value, or a test's monkeypatched
    settings.dhan_access_token - existing tests never call
    renew_access_token(), so this always falls through to settings for
    them, unmodified)."""
    with _token_lock:
        return _renewed_token if _renewed_token is not None else settings.dhan_access_token


def _decode_jwt_exp(token: str) -> Optional[datetime]:
    """Dhan access tokens are JWTs with a standard `exp` claim (confirmed
    live 2026-08-18: iat/exp are exactly 24h apart) - decoding it directly
    gives a real expiry the instant a token is set, unlike expiry_time
    below which stays null until a renewal call has actually succeeded.
    No signature verification - we're only reading a claim from a token
    we already trust (it came from settings or a UI-submitted credential),
    not authenticating it."""
    try:
        payload_b64 = token.split(".")[1]
        padding = "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
        exp = payload["exp"]
        return datetime.fromtimestamp(exp, tz=timezone.utc)
    except (IndexError, ValueError, KeyError, TypeError):
        return None


def renew_token_status() -> dict:
    with _token_lock:
        token = _renewed_token if _renewed_token is not None else settings.dhan_access_token
        token_expires_at = _decode_jwt_exp(token) if token else None
        return {
            "renewed": _renewed_token is not None,
            "last_renewed_at": _last_renewed_at.isoformat() if _last_renewed_at else None,
            "expiry_time": (_last_renewal_response or {}).get("expiryTime"),
            # dhanClientName is what Dhan's docs describe; createTime is
            # what the live response actually sends instead - surfacing
            # both defensively (see renew_access_token's own note).
            "dhan_client_name": (_last_renewal_response or {}).get("dhanClientName"),
            "create_time": (_last_renewal_response or {}).get("createTime"),
            "token_expires_at": token_expires_at.isoformat() if token_expires_at else None,
        }


def renew_access_token() -> dict:
    """Calls Dhan's RenewToken (https://docs.dhanhq.co/api/v2/authentication/renew-token)
    with the current active token; updates the shared token every
    DhanProvider instance's requests read from via current_access_token().
    Only renews an already-active token - Dhan rejects renewing an
    expired one (401), which is why the scheduled job (app/scheduler.py)
    runs well before the 24h validity window closes."""
    token = current_access_token()
    if not settings.dhan_client_id or not token:
        raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

    resp = requests.get(
        RENEW_TOKEN_URL,
        # Note: this endpoint's client-id header is "dhanClientId", not
        # "client-id" like the LTP/candle endpoints below use - Dhan's own
        # API is inconsistent about this between endpoints.
        headers={"Accept": "application/json", "access-token": token, "dhanClientId": settings.dhan_client_id},
        timeout=15,
    )
    if resp.status_code == 401:
        raise RuntimeError(
            "Dhan rejected the renewal request (401) - the current token may already be expired; "
            "generate a new one from Dhan Web"
        )
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        raise RuntimeError(f"Dhan token renewal failed ({resp.status_code}): {resp.text[:200]}") from exc

    data = resp.json()
    # Dhan's own docs (https://docs.dhanhq.co/api/v2/authentication/renew-token)
    # say this field is "accessToken", but the live response actually
    # uses "token" (and "createTime" instead of dhanClientId/
    # dhanClientName/etc - confirmed empirically, docs are stale/wrong
    # here). Accept either name defensively.
    new_token = data.get("token") or data.get("accessToken")
    if not new_token:
        # Dhan doesn't always signal a rejected renewal via a non-200
        # status - e.g. an already-expired token has been observed to
        # come back as a 200 with an errorType/errorCode/errorMessage
        # body instead of a token, same shape other Dhan endpoints use
        # for a real error. Treat a response with no token as a failure
        # either way, rather than raising an unhandled KeyError.
        raise RuntimeError(f"Dhan token renewal did not return a token: {resp.text[:200]}")

    global _renewed_token, _last_renewed_at, _last_renewal_response
    with _token_lock:
        _renewed_token = new_token
        _last_renewed_at = datetime.now(timezone.utc)
        _last_renewal_response = data
    _persist_credentials(settings.dhan_client_id, new_token)
    logger.info("Dhan access token renewed, new expiry %s", data.get("expiryTime"))
    return data


def set_manual_credentials(client_id: str, access_token: str) -> None:
    """Sets both the Dhan client ID and access token at runtime - the UI's
    own 'Data provider keys' form (PUT /dhan/credentials), for pasting in
    a freshly-generated token without touching .env/restarting. Persisted
    to settings.dhan_credentials_file_path (see _persist_credentials) so
    it's also what survives a container restart now, not just what's
    active for the rest of this process's life - previously reverted
    straight back to DHAN_CLIENT_ID/DHAN_ACCESS_TOKEN from the environment
    on every restart, which caused a real outage (see docs/architecture.md).

    client_id has no separate renewed/seed split the way access_token
    does (nothing ever "renews" it independently) - written straight to
    settings.dhan_client_id, the one place every call site already reads
    it from, live immediately. access_token goes through the SAME shared
    _renewed_token slot current_access_token()/renew_access_token() use,
    so it takes priority immediately, exactly like a real renewal would.
    _last_renewal_response is cleared (not a real Dhan RenewToken response
    - renew_token_status()'s expiry_time/dhan_client_name/create_time
    fields will read None until an actual renewal happens against this
    new token), but _last_renewed_at is stamped now so the status endpoint
    still shows when the active credentials last changed."""
    global _renewed_token, _last_renewed_at, _last_renewal_response
    settings.dhan_client_id = client_id
    with _token_lock:
        _renewed_token = access_token
        _last_renewed_at = datetime.now(timezone.utc)
        _last_renewal_response = None
    _persist_credentials(client_id, access_token)


@dataclass(frozen=True)
class SegmentConfig:
    """One Dhan "segment" a DhanProvider instance can resolve/quote/chart.
    A single instance holds one of these per distinct Dhan segment it
    covers (see the NSE_* / MCX_FUTCOM constants below) - credentials and
    rate limits are shared per Dhan account regardless of segment, so
    there's no need for a separate provider *instance* per segment, only
    per exchange (matching router.py's existing exchange-keyed dispatch)."""

    exchange: str  # what Candle.exchange / execution's `exchange` field shows - "NSE" or "MCX"
    ltp_segment_key: str  # Dhan marketfeed/ltp request+response key, e.g. "NSE_EQ", "MCX_COMM"
    candle_exchange_segment: str  # charts API "exchangeSegment" - identical to ltp_segment_key for every segment seen so far
    candle_instrument: str  # charts API "instrument" - mirrors SEM_INSTRUMENT_NAME exactly
    row_matches: Callable[[dict], bool]  # CSV row filter
    # Set only for futures configs - extracts e.g. "GOLDM"/"NIFTY" from a
    # contract row, for active-month grouping (resolve_active_contract).
    underlying_of: Optional[Callable[[dict], str]] = None


def _underlying_from_trading_symbol(row: dict) -> str:
    """Derives the underlying from SEM_TRADING_SYMBOL (e.g.
    "GOLDM-04Sep2026-FUT" / "NIFTY-Oct2026-FUT" -> "GOLDM" / "NIFTY") -
    NOT from SM_SYMBOL_NAME, which is populated for MCX_FUTCOM rows but
    empirically blank for NSE_FUTIDX rows in Dhan's real instrument
    master (checked via a live download, not assumed)."""
    return row.get("SEM_TRADING_SYMBOL", "").split("-")[0]


def _disambiguated_option_symbol(row: dict) -> Optional[str]:
    """Dhan's own SEM_TRADING_SYMBOL for options only encodes month+year
    (e.g. "NIFTY-Aug2026-24400-PE"), not the exact day - unlike futures,
    where Dhan's own symbols already include the full day (e.g.
    "GOLDM-04Sep2026-FUT"). Confirmed live (2026-08-14) that this is a
    real collision, not a hypothetical: a weekly and a monthly NIFTY put
    at the same strike shared one SEM_TRADING_SYMBOL across two rows
    with different security_ids - sync_instruments()'s symbol-keyed dicts
    silently kept whichever row it processed last, making the other
    security_id (the nearest/weekly one - exactly what choose_expiry
    always picks) permanently unresolvable via resolve_symbol_by_security_id.
    Builds a day-inclusive symbol instead, from the row's own structured
    fields (SEM_EXPIRY_DATE/SEM_STRIKE_PRICE/SEM_OPTION_TYPE) rather than
    Dhan's ambiguous string - matches the same day-inclusive shape Dhan's
    own futures symbols already use, so this doesn't introduce a third
    format. Deliberately does NOT use SM_SYMBOL_NAME for the underlying -
    confirmed live it's blank for NSE_OPTIDX rows too, same gotcha
    _underlying_from_trading_symbol's own docstring already documents for
    NSE_FUTIDX - reuses that helper instead, which only depends on the
    underlying-name prefix (never ambiguous) rather than the date portion
    (the actual source of the collision).

    The strike itself must keep its fractional part rather than truncate
    to int: confirmed live (2026-08-14) that some NSE stock options list
    both a whole and a half strike in the same expiry (e.g. IOC 162 and
    162.5 CE, same day) - int(float(strike)) collapsed both to "162" and
    reintroduced the exact same class of collision this function exists
    to fix, just on the strike instead of the date. Formats via
    normalize("f") + strip so a whole strike still renders as "162" (no
    ".0" noise) while a fractional one keeps only what it needs ("162.5"),
    with no float binary-representation artifacts (e.g. "162.49999999").

    None if any required field is missing/malformed - caller falls back
    to Dhan's raw symbol in that case rather than failing the whole
    sync."""
    expiry_raw = (row.get("SEM_EXPIRY_DATE") or "").split(" ")[0]
    strike_raw = row.get("SEM_STRIKE_PRICE")
    option_type = row.get("SEM_OPTION_TYPE")
    if not expiry_raw or not strike_raw or not option_type:
        return None
    try:
        expiry_date = date.fromisoformat(expiry_raw)
        strike_decimal = Decimal(str(strike_raw)).normalize()
        strike = format(strike_decimal, "f")
    except (ValueError, InvalidOperation):
        return None
    underlying = _underlying_from_trading_symbol(row)
    if not underlying:
        return None
    return f"{underlying}-{expiry_date.strftime('%d%b%Y')}-{strike}-{option_type}"


NSE_EQ = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_EQ",
    candle_exchange_segment="NSE_EQ",
    candle_instrument="EQUITY",
    row_matches=lambda r: (
        r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_SEGMENT") == "E" and r.get("SEM_SERIES") == "EQ"
    ),
)

# NSE index spot values (NIFTY, BANKNIFTY, and every other NSE index Dhan
# publishes) - what's actually charted for RSI on an index underlying,
# no expiry/rollover concept at all. Not restricted to a hardcoded
# symbol allowlist - any SEM_TRADING_SYMBOL match resolves, so a new
# underlying (e.g. FINNIFTY) works with zero code changes, same
# generality as MCX_FUTCOM below.
NSE_INDEX = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="IDX_I",
    candle_exchange_segment="IDX_I",
    candle_instrument="INDEX",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "INDEX",
)

# NSE index futures (NIFTY/BANKNIFTY/...) - the interim tradeable
# instrument for an index underlying (chart the spot above, trade the
# active-month future here) per docs/architecture.md's "future signals
# now, options later" decision.
NSE_FUTIDX = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_FNO",
    candle_exchange_segment="NSE_FNO",
    candle_instrument="FUTIDX",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "FUTIDX",
    underlying_of=_underlying_from_trading_symbol,
)

# MCX commodity futures (GOLDM, CRUDEOILM, ...) - no spot to chart, chart
# and trade the same active-month contract.
MCX_FUTCOM = SegmentConfig(
    exchange="MCX",
    ltp_segment_key="MCX_COMM",
    candle_exchange_segment="MCX_COMM",
    candle_instrument="FUTCOM",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "MCX" and r.get("SEM_INSTRUMENT_NAME") == "FUTCOM",
    underlying_of=_underlying_from_trading_symbol,
)

# Option contracts (Phase 4d of the options trading module - see
# docs/architecture.md) - unlike the futures configs above, these don't
# set underlying_of: execution never needs "the active option contract
# for underlying X" the way it needs "the active future for X" - it
# already has the EXACT security_id for the specific leg it wants, from
# signal-processing's resolved order (Phase 4b). These configs exist
# purely so sync_instruments() populates _symbol_to_security_id/
# _symbol_to_lot_size/_security_id_to_symbol for option rows too, reusing
# the exact same symbol-keyed quoting/lot-size machinery every other
# instrument type already uses - see resolve_symbol_by_security_id.
# exchangeSegment/instrument values confirmed against Dhan's annexure
# during Phase 4c's research (same vocabulary rollingoption uses) - NSE
# index and stock options both trade in the NSE_FNO segment (not NSE_EQ/
# IDX_I, the underlying's OWN segment); MCX has no separate derivatives
# segment at all, so MCX options share MCX_COMM with MCX futures.
NSE_OPTIDX = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_FNO",
    candle_exchange_segment="NSE_FNO",
    candle_instrument="OPTIDX",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "OPTIDX",
)

NSE_OPTSTK = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_FNO",
    candle_exchange_segment="NSE_FNO",
    candle_instrument="OPTSTK",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "OPTSTK",
)

MCX_OPTFUT = SegmentConfig(
    exchange="MCX",
    ltp_segment_key="MCX_COMM",
    candle_exchange_segment="MCX_COMM",
    candle_instrument="OPTFUT",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "MCX" and r.get("SEM_INSTRUMENT_NAME") == "OPTFUT",
)


@dataclass(frozen=True)
class ContractInfo:
    trading_symbol: str
    expiry_date: date


def _parse_lot_size_overrides(raw: str) -> dict[str, int]:
    """Parses settings.mcx_lot_size_overrides (e.g. "GOLD:10,GOLDM:10,
    CRUDEOIL:10,CRUDEOILM:10") into {underlying: lot_size}. Keyed by
    underlying (the SEM_TRADING_SYMBOL prefix - see
    _underlying_from_trading_symbol), not by the full contract symbol,
    since that changes every expiry/strike and one override entry needs
    to cover every contract for that underlying. A malformed entry is
    skipped with a warning rather than failing the whole sync - this is
    a manually-maintained env var, not validated input."""
    overrides: dict[str, int] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        underlying, _, qty_raw = entry.partition(":")
        underlying = underlying.strip()
        try:
            qty = int(qty_raw.strip())
        except ValueError:
            logger.warning("skipping malformed MCX_LOT_SIZE_OVERRIDES entry: %r", entry)
            continue
        overrides[underlying] = qty
    return overrides


_LOT_SIZE_OVERRIDES = _parse_lot_size_overrides(settings.mcx_lot_size_overrides)


@dataclass(frozen=True)
class DhanCredentials:
    """A specific user's own Dhan client_id/access_token - an optional
    override of the platform-wide global credential (current_access_token()/
    settings.dhan_client_id above), threaded through DhanProvider's public
    methods for BYO credentials (Phase 3 of the manual-trading SaaS, see
    docs/architecture.md). Resolved per-request from systems/accounts by
    app/adapters/accounts_client.py, never constructed here directly.
    throttle_key scopes rate-limit state independently per user - their
    own Dhan account has its own real rate budget, so shouldn't contend
    with the platform's or another user's (see DhanProvider's throttle
    dicts below) - always str(user_id), never logged or used for
    anything else."""

    client_id: str
    access_token: str
    throttle_key: str


class DhanProvider(QuoteProvider):
    def __init__(self, segment_configs: Optional[list[SegmentConfig]] = None, name: str = "dhan") -> None:
        # Defaults to NSE-cash-equity-only, matching this class's
        # original single-segment behavior - existing callers/tests that
        # construct DhanProvider() with no args are unaffected.
        self._configs = segment_configs or [NSE_EQ]
        self._default_config = self._configs[0]
        self.name = name

        self._lock = threading.Lock()
        self._symbol_to_security_id: dict[str, str] = {}
        # Per-symbol metadata beyond the security id - which Dhan segment
        # it belongs to and its lot size. Kept as a SEPARATE dict (not
        # merged into _symbol_to_security_id's value type) so that dict
        # stays a plain symbol->id str mapping exactly as before this
        # multi-segment refactor - existing tests poke it directly.
        self._symbol_to_config: dict[str, SegmentConfig] = {}
        self._symbol_to_lot_size: dict[str, int] = {}
        # security_id -> symbol - the reverse of _symbol_to_security_id,
        # populated for every synced row (not just options), a trivial
        # byproduct of the same sync loop. Phase 4d's execution needs this
        # because a resolved option order's leg only ever carries
        # security_id (from Phase 4a's option-chain response), never a
        # trading symbol - see resolve_symbol_by_security_id.
        self._security_id_to_symbol: dict[str, str] = {}
        # underlying (e.g. "GOLDM") -> its contracts across all expiries,
        # sorted by expiry ascending - only populated for configs that
        # set underlying_of.
        self._underlying_to_contracts: dict[str, list[ContractInfo]] = {}
        self._last_synced_at: Optional[datetime] = None
        # Rate-limit throttle timestamps, keyed by a throttle key (None =
        # the platform-default credential; a BYO user's own str(user_id)
        # otherwise - see DhanCredentials/_throttle above/below) rather
        # than a single scalar, so a user with their own Dhan account gets
        # their own independent rate budget instead of contending with
        # the platform's (or another user's) - see docs/architecture.md
        # Phase 3.
        self._last_ltp_call_at: dict[Optional[str], float] = {}
        self._quote_cache: dict[str, tuple[float, float]] = {}  # symbol -> (price, fetched_at)
        self._quote_cache_lock = threading.Lock()

        self._candle_lock = threading.Lock()
        self._last_candle_call_at: dict[Optional[str], float] = {}
        # (symbol, interval) -> (candle, fetched_at) - TTL is the
        # interval's own length (see _cached_candle), not the 3s quote
        # TTL, since a completed candle doesn't change until the next one
        # closes.
        self._candle_cache: dict[tuple[str, str], tuple[Candle, float]] = {}
        self._candle_cache_lock = threading.Lock()

        self._option_chain_lock = threading.Lock()
        self._last_option_chain_call_at: dict[Optional[str], float] = {}
        self._option_chain_cache: dict[tuple[str, str], tuple[OptionChain, float]] = {}
        self._option_chain_cache_lock = threading.Lock()

        self._expiry_list_cache: dict[str, tuple[list[str], float]] = {}
        self._expiry_list_cache_lock = threading.Lock()

        # Order-placement throttle - same per-credential-key shape as the
        # quote/candle/option-chain throttles above, deliberately kept
        # entirely separate (own lock, own timestamp dict) so a burst of
        # order activity never contends with or is contended by ordinary
        # quote polling.
        self._order_lock = threading.Lock()
        self._last_order_call_at: dict[Optional[str], float] = {}

        # In-memory OI time series backing GET /options/oi-summary's
        # 5m/15m change figures - see _record_oi_history's own comment.
        # Deliberately NOT persisted (market-data holds no DB by design,
        # in-memory cache only) - resets on every restart, same tradeoff
        # this class's other caches already accept.
        self._oi_history_lock = threading.Lock()
        # (symbol, expiry, strike, option_type) -> [(unix ts, oi), ...] oldest first
        self._oi_history: dict[tuple[str, str, float, str], list[tuple[float, int]]] = {}

        # Same shape/lifecycle as _oi_history above, but for last_price -
        # backs the buildup (long/short buildup, short covering, long
        # unwinding) classification in app/domain/oi_summary.py, which
        # needs a price direction alongside the OI direction. Kept as a
        # separate dict/lock rather than widening _oi_history's tuples so
        # the existing OI-only tests/call sites don't have to change.
        self._price_history_lock = threading.Lock()
        # (symbol, expiry, strike, option_type) -> [(unix ts, last_price), ...] oldest first
        self._price_history: dict[tuple[str, str, float, str], list[tuple[float, float]]] = {}

    def status(self) -> dict:
        return {
            "provider": self.name,
            "symbol_count": len(self._symbol_to_security_id),
            "last_synced_at": self._last_synced_at.isoformat() if self._last_synced_at else None,
        }

    def _throttle(self, lock: threading.Lock, timestamps: dict, key: Optional[str], min_interval: float, label: str) -> None:
        """Shared wait-then-stamp logic for the LTP/candle/option-chain
        throttle families below - `timestamps` is one of
        self._last_ltp_call_at/_last_candle_call_at/_last_option_chain_call_at,
        keyed by `key` (None = platform-default credential, str(user_id)
        for a BYO one - see DhanCredentials's own docstring) so each gets
        an independent rate-limit clock."""
        with lock:
            wait = min_interval - (time.monotonic() - timestamps.get(key, 0.0))
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Dhan {label} queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            timestamps[key] = time.monotonic()

    def sync_instruments(self) -> dict:
        logger.info("syncing Dhan instrument master from %s (%s)", INSTRUMENT_MASTER_URL, self.name)
        resp = requests.get(INSTRUMENT_MASTER_URL, timeout=60)
        resp.raise_for_status()

        symbol_to_id: dict[str, str] = {}
        symbol_to_config: dict[str, SegmentConfig] = {}
        symbol_to_lot: dict[str, int] = {}
        underlying_to_contracts: dict[str, list[ContractInfo]] = {}

        reader = csv.DictReader(io.StringIO(resp.text))
        for row in reader:
            for config in self._configs:
                if not config.row_matches(row):
                    continue
                symbol = row["SEM_TRADING_SYMBOL"]
                if row.get("SEM_INSTRUMENT_NAME") in ("OPTIDX", "OPTSTK", "OPTFUT"):
                    disambiguated = _disambiguated_option_symbol(row)
                    if disambiguated is not None:
                        symbol = disambiguated
                    else:
                        logger.warning(
                            "could not build a disambiguated option symbol for security_id %s "
                            "(row: %s) - falling back to Dhan's own SEM_TRADING_SYMBOL, which may "
                            "collide with a different contract",
                            row.get("SEM_SMST_SECURITY_ID"), row.get("SEM_TRADING_SYMBOL"),
                        )
                security_id = row["SEM_SMST_SECURITY_ID"]
                if symbol in symbol_to_id and symbol_to_id[symbol] != security_id:
                    logger.warning(
                        "symbol collision during instrument sync (%s): '%s' already mapped to "
                        "security_id %s, now also claimed by security_id %s - the earlier "
                        "contract just became unresolvable by symbol",
                        self.name, symbol, symbol_to_id[symbol], security_id,
                    )
                symbol_to_id[symbol] = security_id
                symbol_to_config[symbol] = config
                lot_size = int(float(row.get("SEM_LOT_UNITS") or 1))
                if row.get("SEM_EXM_EXCH_ID") == "MCX":
                    override = _LOT_SIZE_OVERRIDES.get(_underlying_from_trading_symbol(row))
                    if override is not None:
                        lot_size = override
                symbol_to_lot[symbol] = lot_size

                if config.underlying_of is not None:
                    underlying = config.underlying_of(row)
                    expiry_raw = (row.get("SEM_EXPIRY_DATE") or "").split(" ")[0]
                    try:
                        expiry_date = date.fromisoformat(expiry_raw)
                    except ValueError:
                        continue  # malformed/missing expiry - skip, can't be resolved by active-month logic
                    underlying_to_contracts.setdefault(underlying, []).append(
                        ContractInfo(trading_symbol=symbol, expiry_date=expiry_date)
                    )
                break  # a row belongs to at most one of this instance's configs

        for contracts in underlying_to_contracts.values():
            contracts.sort(key=lambda c: c.expiry_date)

        security_id_to_symbol = {security_id: symbol for symbol, security_id in symbol_to_id.items()}

        with self._lock:
            self._symbol_to_security_id = symbol_to_id
            self._symbol_to_config = symbol_to_config
            self._symbol_to_lot_size = symbol_to_lot
            self._security_id_to_symbol = security_id_to_symbol
            self._underlying_to_contracts = underlying_to_contracts
            self._last_synced_at = datetime.now(timezone.utc)

        logger.info("Dhan instrument master synced (%s): %d symbols", self.name, len(symbol_to_id))
        return self.status()

    def _security_id(self, symbol: str) -> Optional[str]:
        if not self._symbol_to_security_id:
            self.sync_instruments()
        return self._symbol_to_security_id.get(symbol)

    def resolve_symbol_by_security_id(self, security_id: str) -> Optional[str]:
        """The reverse of _security_id - given a raw Dhan security ID
        (e.g. from an option leg's security_id, Phase 4a's option-chain
        response), the trading symbol it belongs to on this provider's
        exchange. None if unknown. Once execution has this symbol, every
        downstream operation (quoting, lot size) reuses the ordinary
        symbol-keyed methods unchanged - see docs/architecture.md Phase
        4d."""
        if not self._symbol_to_security_id:
            self.sync_instruments()
        return self._security_id_to_symbol.get(security_id)

    def resolve_feed_target(self, symbol: str) -> Optional[tuple[str, str]]:
        """(ltp_segment_key, security_id) for subscribing `symbol` on
        Dhan's live market feed WebSocket (app/providers/dhan_feed.py) -
        the same segment-key vocabulary ("NSE_EQ", "IDX_I", ...) and
        security-id lookup get_ltp_batch already uses for the REST LTP
        endpoint. None if the symbol is unknown."""
        security_id = self._security_id(symbol)
        if security_id is None:
            return None
        return self._config_for(symbol).ltp_segment_key, security_id

    def _config_for(self, symbol: str) -> SegmentConfig:
        """Falls back to this instance's first/default config for a
        symbol with no recorded segment - covers tests (and any caller)
        that stuff _symbol_to_security_id directly without going through
        a real sync, reproducing this class's original single-segment
        behavior exactly."""
        return self._symbol_to_config.get(symbol, self._default_config)

    def resolve_active_contract(self, underlying: str) -> Optional[ContractInfo]:
        """The nearest not-yet-expired contract for `underlying` - "active
        month," re-resolved from whatever the most recent instrument sync
        produced (no separate caching/rollover-detection needed beyond
        that daily resync)."""
        contracts = self._underlying_to_contracts.get(underlying)
        if not contracts:
            return None
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        unexpired = [c for c in contracts if c.expiry_date >= today]
        return min(unexpired, key=lambda c: c.expiry_date) if unexpired else None

    def resolve_underlying(self, underlying: str) -> Optional[ResolvedUnderlying]:
        """chart_symbol/chart_exchange = what to fetch candles for and
        compute indicators on; trade_symbol/trade_exchange = what an
        actual signal should be opened on. Equal for commodities (no
        spot to chart); different for indices (chart the spot, trade the
        active-month future) - see docs/architecture.md."""
        if not self._symbol_to_security_id:
            self.sync_instruments()

        index_symbol = underlying if underlying in self._symbol_to_config else None
        if index_symbol is not None and self._config_for(index_symbol).candle_instrument != "INDEX":
            index_symbol = None  # matched a non-index symbol of the same name - not what we want

        contract = self.resolve_active_contract(underlying)

        if index_symbol is not None and contract is not None:
            return ResolvedUnderlying(
                chart_symbol=index_symbol,
                chart_exchange=self._config_for(index_symbol).exchange,
                trade_symbol=contract.trading_symbol,
                trade_exchange=self._config_for(contract.trading_symbol).exchange,
                lot_size=self._symbol_to_lot_size.get(contract.trading_symbol, 1),
                expiry=contract.expiry_date.isoformat(),
            )
        if contract is not None:
            return ResolvedUnderlying(
                chart_symbol=contract.trading_symbol,
                chart_exchange=self._config_for(contract.trading_symbol).exchange,
                trade_symbol=contract.trading_symbol,
                trade_exchange=self._config_for(contract.trading_symbol).exchange,
                lot_size=self._symbol_to_lot_size.get(contract.trading_symbol, 1),
                expiry=contract.expiry_date.isoformat(),
            )

        # A directly-tradeable instrument with no separate underlying/
        # rollover concept at all - e.g. an NSE cash equity (NSE_EQ),
        # where the "underlying" IS the traded symbol itself, unlike a
        # future (resolved via `contract` above) or an index (charted
        # separately from what's traded). Checked last so it can never
        # shadow the index/futures resolutions above - only NSE_EQ rows
        # (underlying_of=None, candle_instrument="EQUITY") match; an
        # index row with no active future found still correctly resolves
        # to nothing rather than silently trading the index itself.
        if underlying in self._symbol_to_config:
            config = self._config_for(underlying)
            if config.underlying_of is None and config.candle_instrument == "EQUITY":
                return ResolvedUnderlying(
                    chart_symbol=underlying,
                    chart_exchange=config.exchange,
                    trade_symbol=underlying,
                    trade_exchange=config.exchange,
                    lot_size=self._symbol_to_lot_size.get(underlying, 1),
                    expiry=None,
                )
        return None

    def get_lot_size(self, symbol: str) -> Optional[int]:
        if not self._symbol_to_security_id:
            self.sync_instruments()
        if symbol not in self._symbol_to_security_id:
            return None
        return self._symbol_to_lot_size.get(symbol, 1)

    def _cached_quote(self, symbol: str) -> Optional[float]:
        with self._quote_cache_lock:
            cached = self._quote_cache.get(symbol)
        if cached is None:
            return None
        price, fetched_at = cached
        if (time.monotonic() - fetched_at) >= QUOTE_CACHE_TTL_SECONDS:
            return None
        return price

    def _store_quotes(self, prices: dict[str, float]) -> None:
        now = time.monotonic()
        with self._quote_cache_lock:
            for symbol, price in prices.items():
                self._quote_cache[symbol] = (price, now)

    def get_ltp(self, symbol: str, credentials: Optional[DhanCredentials] = None) -> float:
        result = self.get_ltp_batch([symbol], credentials=credentials)
        if symbol not in result:
            raise ValueError(f"no LTP available for '{symbol}' - unknown symbol or Dhan omitted it")
        return result[symbol]

    def get_ltp_batch(self, symbols: list[str], credentials: Optional[DhanCredentials] = None) -> dict[str, float]:
        """credentials=None (the default) uses the platform-wide global
        credential exactly as before Phase 3 - a specific user's own
        DhanCredentials (resolved from systems/accounts by
        app/adapters/accounts_client.py) both authenticates the outbound
        call AND scopes the rate-limit throttle to their own independent
        budget, see DhanCredentials's own docstring."""
        if not symbols:
            return {}

        result: dict[str, float] = {}
        # security_id -> (symbol, ltp_segment_key) - a batch can span
        # multiple Dhan segments (e.g. an NSE_EQ symbol and an NSE_FNO
        # symbol in the same request), grouped into the request body by
        # segment key below.
        pending: dict[str, tuple[str, str]] = {}
        for symbol in symbols:
            cached = self._cached_quote(symbol)
            if cached is not None:
                result[symbol] = cached
                continue
            security_id = self._security_id(symbol)
            if security_id is None:
                logger.warning("unknown symbol '%s' (%s) - instrument master may need a sync", symbol, self.name)
                continue
            pending[security_id] = (symbol, self._config_for(symbol).ltp_segment_key)

        if not pending:
            return result  # everything was cached (or unknown)

        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle(self._lock, self._last_ltp_call_at, credentials.throttle_key if credentials else None, MIN_LTP_CALL_INTERVAL_SECONDS, "quote")

        body: dict[str, list[int]] = {}
        for security_id, (_symbol, segment_key) in pending.items():
            body.setdefault(segment_key, []).append(int(security_id))

        resp = requests.post(
            LTP_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": access_token,
                "client-id": client_id,
            },
            json=body,
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) - LTP is limited to 1 request/second, retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json().get("data", {})

        fresh: dict[str, float] = {}
        for security_id, (symbol, segment_key) in pending.items():
            entry = data.get(segment_key, {}).get(security_id)
            if entry is None:
                logger.warning("Dhan response missing %s (%s, segment=%s)", symbol, security_id, segment_key)
                continue
            fresh[symbol] = float(entry["last_price"])

        self._store_quotes(fresh)
        result.update(fresh)
        return result

    def _cached_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        with self._candle_cache_lock:
            cached = self._candle_cache.get((symbol, interval))
        if cached is None:
            return None
        candle, fetched_at = cached
        if (time.monotonic() - fetched_at) >= _interval_minutes(interval) * 60:
            return None
        return candle

    def _store_candle(self, symbol: str, interval: str, candle: Candle) -> None:
        with self._candle_cache_lock:
            self._candle_cache[(symbol, interval)] = (candle, time.monotonic())

    def _fetch_candles(
        self, symbol: str, interval: str, from_dt: datetime, to_dt: datetime, credentials: Optional[DhanCredentials] = None
    ) -> list[Candle]:
        """Shared entry point for both get_previous_candle and
        get_candle_history. For a native Dhan granularity, this is a
        single request. For anything else (e.g. "3min"), Dhan has no
        native candle for it - so this fetches native 1min bars over the
        same range and buckets them locally (_aggregate_candles). Either
        way, returns only *completed* bars, oldest first."""
        minutes = _interval_minutes(interval)
        if interval in DHAN_CANDLE_INTERVAL_MINUTES:
            return self._fetch_native_candles(symbol, interval, minutes, from_dt, to_dt, credentials)
        one_min_candles = self._fetch_native_candles(symbol, "1min", 1, from_dt, to_dt, credentials)
        return _aggregate_candles(one_min_candles, interval, minutes)

    def _fetch_native_candles(
        self,
        symbol: str,
        interval: str,
        interval_minutes: int,
        from_dt: datetime,
        to_dt: datetime,
        credentials: Optional[DhanCredentials] = None,
    ) -> list[Candle]:
        """The actual Dhan charts/intraday request/parse - `interval` must
        be one of Dhan's own native granularities (a key of
        DHAN_CANDLE_INTERVAL_MINUTES), used both directly (native
        intervals) and as the "1min" building block for local aggregation
        (see _fetch_candles). Returns only *completed* bars (excludes any
        still-forming trailing bar), oldest first. credentials - see
        get_ltp_batch's own docstring, identical meaning here."""
        security_id = self._security_id(symbol)
        if security_id is None:
            logger.warning("unknown symbol '%s' (%s) - instrument master may need a sync", symbol, self.name)
            return []

        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle(
            self._candle_lock, self._last_candle_call_at, credentials.throttle_key if credentials else None,
            MIN_CANDLE_CALL_INTERVAL_SECONDS, "candle",
        )

        config = self._config_for(symbol)
        tz = ZoneInfo(settings.timezone)
        now_epoch = datetime.now(tz).timestamp()

        resp = requests.post(
            CANDLE_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": access_token,
                "client-id": client_id,
            },
            json={
                "securityId": security_id,
                "exchangeSegment": config.candle_exchange_segment,
                "instrument": config.candle_instrument,
                "interval": str(interval_minutes),
                "oi": False,
                "fromDate": from_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "toDate": to_dt.strftime("%Y-%m-%d %H:%M:%S"),
            },
            timeout=30,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on charts/intraday - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json()
        timestamps = data.get("timestamp") or []
        if not timestamps:
            return []

        opens, highs, lows, closes = data.get("open", []), data.get("high", []), data.get("low", []), data.get("close", [])
        volumes = data.get("volume", [])
        interval_seconds = interval_minutes * 60
        # Dhan may include a still-forming final bar - only trust bars
        # whose full interval has already elapsed.
        completed = [i for i, ts in enumerate(timestamps) if ts + interval_seconds <= now_epoch]

        return [
            Candle(
                exchange=config.exchange,
                symbol=symbol,
                interval=interval,
                open=float(opens[i]),
                high=float(highs[i]),
                low=float(lows[i]),
                close=float(closes[i]),
                # volumes may be absent/short on some Dhan responses (option
                # legs, older data) - 0.0 rather than crashing, same
                # graceful-degradation spirit as the rest of this parse.
                volume=float(volumes[i]) if i < len(volumes) else 0.0,
                timestamp=datetime.fromtimestamp(timestamps[i], tz=tz).isoformat(),
                provider=self.name,
            )
            for i in completed
        ]

    def _fetch_historical_candles(
        self, symbol: str, from_date: date, to_date: date, credentials: Optional[DhanCredentials] = None
    ) -> list[Candle]:
        """The actual Dhan charts/historical request/parse - real daily
        bars, a separate endpoint from charts/intraday (see HISTORICAL_URL's
        own comment), not a repurposing of it. Plain YYYY-MM-DD date
        strings (no datetime.combine/timezone dance the intraday path
        needs) and no `interval` field at all - this endpoint is
        daily-only. Reuses the exact same throttle state as
        _fetch_native_candles (self._candle_lock/MIN_CANDLE_CALL_INTERVAL_SECONDS)
        rather than an independent one - both are charts/* endpoints on the
        same Dhan API key, and there's no confirmed evidence they carry
        separate rate budgets; split this out later if live use shows that
        assumption wrong. Returns only *completed* days (excludes any
        still-forming trailing bar), oldest first."""
        security_id = self._security_id(symbol)
        if security_id is None:
            logger.warning("unknown symbol '%s' (%s) - instrument master may need a sync", symbol, self.name)
            return []

        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle(
            self._candle_lock, self._last_candle_call_at, credentials.throttle_key if credentials else None,
            MIN_CANDLE_CALL_INTERVAL_SECONDS, "candle",
        )

        config = self._config_for(symbol)
        tz = ZoneInfo(settings.timezone)
        now_epoch = datetime.now(tz).timestamp()

        resp = requests.post(
            HISTORICAL_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": access_token,
                "client-id": client_id,
            },
            json={
                "securityId": security_id,
                "exchangeSegment": config.candle_exchange_segment,
                "instrument": config.candle_instrument,
                "fromDate": from_date.isoformat(),
                "toDate": to_date.isoformat(),
                "oi": False,
            },
            timeout=30,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on charts/historical - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json()
        timestamps = data.get("timestamp") or []
        if not timestamps:
            return []

        opens, highs, lows, closes = data.get("open", []), data.get("high", []), data.get("low", []), data.get("close", [])
        volumes = data.get("volume", [])
        # A full trading day, not an interval_minutes-derived duration
        # (this endpoint has no interval concept) - excludes today's own
        # not-yet-complete day, same "still-forming bar" defensiveness
        # _fetch_native_candles applies at intraday granularity.
        completed = [i for i, ts in enumerate(timestamps) if ts + 86400 <= now_epoch]

        return [
            Candle(
                exchange=config.exchange,
                symbol=symbol,
                interval="daily",
                open=float(opens[i]),
                high=float(highs[i]),
                low=float(lows[i]),
                close=float(closes[i]),
                volume=float(volumes[i]) if i < len(volumes) else 0.0,
                timestamp=datetime.fromtimestamp(timestamps[i], tz=tz).isoformat(),
                provider=self.name,
            )
            for i in completed
        ]

    def get_previous_candle(
        self, symbol: str, interval: str, credentials: Optional[DhanCredentials] = None
    ) -> Optional[Candle]:
        """The most recently *completed* candle only - not a historical
        range (use get_candle_history for that). No true multi-symbol
        batching like get_ltp_batch - Dhan's charts/intraday endpoint is
        per-security-id, so callers needing several symbols must call
        this once each; the interval-length cache above is what keeps
        repeated calls (e.g. execution's exit-monitor job polling every
        30s) from re-hitting Dhan every tick. credentials is only ever
        consulted on a cache miss - see get_ltp_batch's own docstring for
        what it does."""
        _interval_minutes(interval)  # raises ValueError for a malformed interval; native or "Nmin" aggregate both fine

        cached = self._cached_candle(symbol, interval)
        if cached is not None:
            return cached

        tz = ZoneInfo(settings.timezone)
        now = datetime.now(tz)
        # 6h comfortably covers the trading session so far without
        # reaching back into a previous day - "previous candle" is scoped
        # to today; if the market just opened and no candle has completed
        # yet, this correctly returns None below.
        candles = self._fetch_candles(symbol, interval, now - timedelta(hours=6), now, credentials)
        if not candles:
            return None

        candle = candles[-1]  # _fetch_candles returns oldest-first, completed-only
        self._store_candle(symbol, interval, candle)
        return candle

    def get_candle_history(
        self, symbol: str, interval: str, from_date: date, to_date: date, credentials: Optional[DhanCredentials] = None
    ) -> list[Candle]:
        """A general multi-bar series over a caller-supplied date range -
        NOT cached (unlike get_previous_candle, a historical range isn't
        a single value that goes stale on a fixed TTL). Used to warm up
        indicator state (RSI/SMA) for the in-house signal engine and for
        backtesting - see signal-generation's app/domain/engine.py and
        backtest.py. credentials - see get_ltp_batch's own docstring.
        interval='daily' is a genuinely different endpoint (see
        _fetch_historical_candles) - dispatched here, before the
        _interval_minutes validation below, which correctly has no 'daily'
        entry for every other interval."""
        if interval == "daily":
            return self._fetch_historical_candles(symbol, from_date, to_date, credentials)

        _interval_minutes(interval)  # raises ValueError for a malformed interval; native or "Nmin" aggregate both fine

        tz = ZoneInfo(settings.timezone)
        from_dt = datetime.combine(from_date, datetime.min.time(), tzinfo=tz)
        to_dt = datetime.combine(to_date, datetime.max.time().replace(microsecond=0), tzinfo=tz)
        return self._fetch_candles(symbol, interval, from_dt, to_dt, credentials)

    def get_data_availability(self, symbol: str, interval: str) -> DataAvailability:
        """A fixed, documented constant - not a live probe. See
        DHAN_INTRADAY_MAX_DAYS_PER_REQUEST above for how this was
        confirmed; unlike Delta's real history-depth question, this
        never changes, so there's nothing to check live. interval='daily'
        goes through the separate charts/historical endpoint
        (_fetch_historical_candles), which per Dhan's own docs has no
        per-request day cap at all - report None (same "only one of the
        two optional fields populated" convention DataAvailability already
        uses for Delta's earliest_available_date-only case), not the
        90-day intraday figure, which doesn't apply to it."""
        if interval == "daily":
            return DataAvailability(
                exchange=self._config_for(symbol).exchange,
                symbol=symbol,
                interval=interval,
                max_days_per_request=None,
                earliest_available_date=None,
                note="Dhan's daily-candle endpoint has no fixed per-request cap - available back to the scrip's own inception.",
            )
        return DataAvailability(
            exchange=self._config_for(symbol).exchange,
            symbol=symbol,
            interval=interval,
            max_days_per_request=DHAN_INTRADAY_MAX_DAYS_PER_REQUEST,
            earliest_available_date=None,
            note=(
                f"Dhan holds several years of intraday history, but a single backtest request can only span "
                f"{DHAN_INTRADAY_MAX_DAYS_PER_REQUEST} days at a time."
            ),
        )

    def _option_chain_headers(self, access_token: str, client_id: str) -> dict:
        return {"Accept": "application/json", "Content-Type": "application/json", "access-token": access_token, "client-id": client_id}

    def _throttle_option_chain_call(self, key: Optional[str] = None) -> None:
        self._throttle(self._option_chain_lock, self._last_option_chain_call_at, key, MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS, "option-chain")

    def get_expiry_list(self, symbol: str, credentials: Optional[DhanCredentials] = None) -> Optional[list[str]]:
        """Every active option expiry date (YYYY-MM-DD) for `symbol` (e.g.
        "NIFTY") - None if `symbol` doesn't resolve on this provider.
        Self-throttled to Dhan's documented 1-request-per-3s limit and
        short-cached (EXPIRY_LIST_CACHE_TTL_SECONDS)."""
        cached = self._cached_expiry_list(symbol)
        if cached is not None:
            return cached

        target = self.resolve_feed_target(symbol)
        if target is None:
            return None
        segment_key, security_id = target

        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle_option_chain_call(credentials.throttle_key if credentials else None)
        resp = requests.post(
            OPTION_EXPIRY_LIST_URL,
            headers=self._option_chain_headers(access_token, client_id),
            json={"UnderlyingScrip": int(security_id), "UnderlyingSeg": segment_key},
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on optionchain/expirylist - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        expiries = resp.json().get("data", [])
        self._store_expiry_list(symbol, expiries)
        return expiries

    def _cached_expiry_list(self, symbol: str) -> Optional[list[str]]:
        with self._expiry_list_cache_lock:
            cached = self._expiry_list_cache.get(symbol)
        if cached is None:
            return None
        expiries, fetched_at = cached
        if (time.monotonic() - fetched_at) >= EXPIRY_LIST_CACHE_TTL_SECONDS:
            return None
        return expiries

    def _store_expiry_list(self, symbol: str, expiries: list[str]) -> None:
        with self._expiry_list_cache_lock:
            self._expiry_list_cache[symbol] = (expiries, time.monotonic())

    def _cached_option_chain(self, symbol: str, expiry: str) -> Optional[OptionChain]:
        with self._option_chain_cache_lock:
            cached = self._option_chain_cache.get((symbol, expiry))
        if cached is None:
            return None
        chain, fetched_at = cached
        if (time.monotonic() - fetched_at) >= OPTION_CHAIN_CACHE_TTL_SECONDS:
            return None
        return chain

    def _store_option_chain(self, symbol: str, expiry: str, chain: OptionChain) -> None:
        with self._option_chain_cache_lock:
            self._option_chain_cache[(symbol, expiry)] = (chain, time.monotonic())

    def _record_oi_history(self, symbol: str, expiry: str, chain: OptionChain) -> None:
        """Appends one OI sample per leg from a freshly-fetched `chain` -
        called only on a real cache miss inside get_option_chain (never on
        a cache-hit return), since OI can't have changed between two
        responses served from the same OPTION_CHAIN_CACHE_TTL_SECONDS-
        cached fetch. Each leg's list is pruned to OI_HISTORY_RETENTION_
        SECONDS on every append rather than by a separate sweep - this
        dict has no background task, so pruning has to happen somewhere
        every leg actually gets touched."""
        now = time.time()
        cutoff = now - OI_HISTORY_RETENTION_SECONDS
        with self._oi_history_lock:
            for row in chain.strikes:
                for leg, option_type in ((row.ce, "CE"), (row.pe, "PE")):
                    if leg is None:
                        continue
                    key = (symbol, expiry, row.strike, option_type)
                    samples = self._oi_history.setdefault(key, [])
                    samples.append((now, leg.oi))
                    while samples and samples[0][0] < cutoff:
                        samples.pop(0)

    def get_oi_changes(
        self, symbol: str, expiry: str, strike: float, option_type: str, current_oi: int
    ) -> tuple[Optional[int], Optional[int]]:
        """(change_5m, change_15m) for one leg, built from the history
        _record_oi_history has been accumulating since this backend last
        started. Each is `current_oi` minus the sample recorded closest
        to (but not after) that many minutes ago - None if no sample is
        old enough yet (a fresh restart, or a strike/expiry nobody's
        fetched before). `current_oi` is passed in rather than read from
        the buffer's own last sample so this always diffs against
        whatever chain the caller actually has in hand, not a
        theoretically-identical-but-separately-fetched one."""
        with self._oi_history_lock:
            samples = list(self._oi_history.get((symbol, expiry, strike, option_type), []))

        now = time.time()

        def anchor(minutes: float) -> Optional[int]:
            target = now - minutes * 60
            found: Optional[int] = None
            for ts, oi in samples:
                if ts <= target:
                    found = oi
                else:
                    break
            return found

        anchor_5m = anchor(5)
        anchor_15m = anchor(15)
        change_5m = current_oi - anchor_5m if anchor_5m is not None else None
        change_15m = current_oi - anchor_15m if anchor_15m is not None else None
        return change_5m, change_15m

    def _record_price_history(self, symbol: str, expiry: str, chain: OptionChain) -> None:
        """Price-history sibling of _record_oi_history above - same
        real-fetch-only call site, same retention/pruning."""
        now = time.time()
        cutoff = now - OI_HISTORY_RETENTION_SECONDS
        with self._price_history_lock:
            for row in chain.strikes:
                for leg, option_type in ((row.ce, "CE"), (row.pe, "PE")):
                    if leg is None:
                        continue
                    key = (symbol, expiry, row.strike, option_type)
                    samples = self._price_history.setdefault(key, [])
                    samples.append((now, leg.last_price))
                    while samples and samples[0][0] < cutoff:
                        samples.pop(0)

    def get_price_changes(
        self, symbol: str, expiry: str, strike: float, option_type: str, current_price: float
    ) -> tuple[Optional[float], Optional[float]]:
        """(change_5m, change_15m) for one leg's premium - price-history
        sibling of get_oi_changes above, same anchor logic."""
        with self._price_history_lock:
            samples = list(self._price_history.get((symbol, expiry, strike, option_type), []))

        now = time.time()

        def anchor(minutes: float) -> Optional[float]:
            target = now - minutes * 60
            found: Optional[float] = None
            for ts, price in samples:
                if ts <= target:
                    found = price
                else:
                    break
            return found

        anchor_5m = anchor(5)
        anchor_15m = anchor(15)
        change_5m = current_price - anchor_5m if anchor_5m is not None else None
        change_15m = current_price - anchor_15m if anchor_15m is not None else None
        return change_5m, change_15m

    @staticmethod
    def _parse_option_leg(raw: Optional[dict], strike: float, spot: float, option_type: str, strike_step: float) -> Optional[OptionLegQuote]:
        if raw is None:
            return None
        greeks = raw.get("greeks") or {}
        return OptionLegQuote(
            security_id=str(raw["security_id"]),
            last_price=raw["last_price"],
            oi=raw["oi"],
            previous_oi=raw["previous_oi"],
            volume=raw["volume"],
            implied_volatility=raw["implied_volatility"],
            top_bid_price=raw["top_bid_price"],
            top_ask_price=raw["top_ask_price"],
            greeks=OptionGreeks(delta=greeks["delta"], theta=greeks["theta"], gamma=greeks["gamma"], vega=greeks["vega"]),
            moneyness=classify_moneyness(strike, spot, option_type, strike_step),
        )

    def get_option_chain(
        self, symbol: str, expiry: str, credentials: Optional[DhanCredentials] = None
    ) -> Optional[OptionChain]:
        """Full option chain for `symbol` (e.g. "NIFTY") at `expiry`
        (YYYY-MM-DD, from get_expiry_list) - OI/Greeks/IV/bid-ask per
        strike, each leg's ITM/ATM/OTM classification computed via
        app/domain/moneyness.py. None if `symbol` doesn't resolve on this
        provider. Self-throttled to Dhan's documented 1-request-per-3s
        limit and short-cached (OPTION_CHAIN_CACHE_TTL_SECONDS).
        credentials - see get_ltp_batch's own docstring; also forwarded
        to the internal get_ltp_batch call below (spot LTP override) so
        that stays consistent with whichever credential fetched the chain
        itself."""
        cached = self._cached_option_chain(symbol, expiry)
        if cached is not None:
            return cached

        target = self.resolve_feed_target(symbol)
        if target is None:
            return None
        segment_key, security_id = target
        config = self._config_for(symbol)

        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle_option_chain_call(credentials.throttle_key if credentials else None)
        resp = requests.post(
            OPTION_CHAIN_URL,
            headers=self._option_chain_headers(access_token, client_id),
            json={"UnderlyingScrip": int(security_id), "UnderlyingSeg": segment_key, "Expiry": expiry},
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on optionchain - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json().get("data", {})
        # Dhan's own optionchain response embeds an underlying `last_price`
        # that can be meaningfully stale/wrong for some instruments -
        # reproduced live 2026-08-25: MCX CRUDEOILM's optionchain reported
        # 8138 while the same instrument's own real-time LTP (GET
        # /quotes/ltp, backed by this provider's own get_ltp_batch) was
        # ~7867 - a ~270-point/~3.4% gap that silently classified every
        # strike's moneyness against the wrong spot, picking a CE/PE 3
        # strikes further OTM than the real ATM (option_templates.py's
        # _find_atm_index just returns whichever strike THIS classification
        # marked "ATM" - it has no independent notion of spot to sanity-
        # check against). Prefer a fresh, independently-fetched LTP (same
        # quote path /quotes/ltp uses, and very likely already cached from
        # a recent call on the same symbol - resolve_underlying/order
        # placement fetch one moments before this in the real Manual tab
        # flow) for spot when available; fall back to the optionchain
        # response's own price only if that lookup fails for any reason,
        # rather than fail the whole chain fetch over a transient LTP hiccup.
        spot = data.get("last_price", 0.0)
        try:
            live_ltp = self.get_ltp_batch([symbol], credentials=credentials).get(symbol)
            if live_ltp is not None:
                spot = live_ltp
        except Exception:
            logger.warning("live LTP override for '%s' option-chain spot failed - using optionchain's own last_price", symbol)
        raw_strikes = data.get("oc", {})
        strike_prices = [float(s) for s in raw_strikes]
        strike_step = infer_strike_step(strike_prices) if len(strike_prices) >= 2 else 1.0

        strikes = [
            OptionChainStrike(
                strike=float(strike_str),
                ce=self._parse_option_leg(raw.get("ce"), float(strike_str), spot, "CE", strike_step),
                pe=self._parse_option_leg(raw.get("pe"), float(strike_str), spot, "PE", strike_step),
            )
            for strike_str, raw in sorted(raw_strikes.items(), key=lambda item: float(item[0]))
        ]

        chain = OptionChain(
            underlying_symbol=symbol,
            underlying_exchange=config.exchange,
            expiry=expiry,
            underlying_last_price=spot,
            strikes=strikes,
        )
        self._store_option_chain(symbol, expiry, chain)
        self._record_oi_history(symbol, expiry, chain)
        self._record_price_history(symbol, expiry, chain)
        return chain

    def _rolling_option_instrument(self, underlying_symbol: str) -> Optional[str]:
        """rollingoption's `instrument` value for `underlying_symbol`'s own
        type (OPTIDX/OPTSTK) - None if this underlying's type isn't
        covered (MCX/FUTCOM, or unknown) - see
        _ROLLING_OPTION_INSTRUMENT_BY_CANDLE_INSTRUMENT's own comment for
        why MCX is excluded here even though Phase 4a's option chain
        covers it."""
        if underlying_symbol not in self._symbol_to_config:
            return None
        return _ROLLING_OPTION_INSTRUMENT_BY_CANDLE_INSTRUMENT.get(self._config_for(underlying_symbol).candle_instrument)

    def get_option_leg_history(
        self,
        underlying_symbol: str,
        option_type: str,
        strike: str,
        expiry_flag: str,
        expiry_code: int,
        interval: str,
        from_date: date,
        to_date: date,
    ) -> Optional[list[OptionLegCandle]]:
        """Historical premium for ONE option leg, tracked relative to spot
        (`strike` e.g. "ATM"/"ATM+2") via Dhan's rolling/expired-options
        endpoint (POST /charts/rollingoption) - backtesting data source
        for Phase 4c (see docs/architecture.md), NOT the live Phase 4a/4b
        path (that's get_option_chain/get_expiry_list, a real chain
        snapshot keyed by actual strike price). None if `underlying_symbol`
        doesn't resolve on this provider, or its type isn't covered by
        this endpoint (MCX today - see _rolling_option_instrument).
        Chunks [from_date, to_date] into <=OPTION_HISTORY_MAX_DAYS_PER_CALL
        slices (Dhan's own documented per-call limit) and concatenates,
        oldest-first - NOT cached, same reasoning as get_candle_history."""
        if not self._symbol_to_security_id:
            self.sync_instruments()
        security_id = self._symbol_to_security_id.get(underlying_symbol)
        instrument = self._rolling_option_instrument(underlying_symbol)
        if security_id is None or instrument is None:
            return None

        access_token = current_access_token()
        if not settings.dhan_client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        drv_option_type = "CALL" if option_type == "CE" else "PUT"

        candles: list[OptionLegCandle] = []
        chunk_start = from_date
        while chunk_start <= to_date:
            chunk_end = min(chunk_start + timedelta(days=OPTION_HISTORY_MAX_DAYS_PER_CALL - 1), to_date)

            # Not credentials-aware (unlike get_ltp_batch/get_option_chain/
            # get_expiry_list) - this endpoint backs signal-generation's
            # backtesting only, not the Manual-tab order-placement path
            # Phase 3 scoped BYO credentials to - always the platform-
            # default credential/throttle slot (key=None).
            self._throttle(
                self._option_chain_lock, self._last_option_chain_call_at, None, MIN_OPTION_HISTORY_CALL_INTERVAL_SECONDS, "option-history"
            )

            resp = requests.post(
                ROLLING_OPTION_URL,
                headers=self._option_chain_headers(access_token, settings.dhan_client_id),
                json={
                    "securityId": int(security_id),
                    "exchangeSegment": ROLLING_OPTION_EXCHANGE_SEGMENT,
                    "instrument": instrument,
                    "expiryFlag": expiry_flag,
                    "expiryCode": expiry_code,
                    "strike": strike,
                    "drvOptionType": drv_option_type,
                    "requiredData": ["open", "high", "low", "close"],
                    "fromDate": chunk_start.isoformat(),
                    "toDate": chunk_end.isoformat(),
                    "interval": interval,
                },
                timeout=30,
            )
            if resp.status_code == 401:
                raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
            if resp.status_code == 429:
                raise RuntimeError("Dhan API rate limit hit (429) on charts/rollingoption - retry shortly")
            try:
                resp.raise_for_status()
            except requests.exceptions.HTTPError as exc:
                raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

            leg = (resp.json().get("data") or {}).get("ce" if option_type == "CE" else "pe") or {}
            timestamps = leg.get("timestamp") or []
            opens, highs, lows, closes = leg.get("open", []), leg.get("high", []), leg.get("low", []), leg.get("close", [])
            tz = ZoneInfo(settings.timezone)
            candles.extend(
                OptionLegCandle(
                    symbol=underlying_symbol,
                    option_type=option_type,
                    strike=strike,
                    expiry_flag=expiry_flag,
                    expiry_code=expiry_code,
                    interval=interval,
                    timestamp=datetime.fromtimestamp(ts, tz=tz).isoformat(),
                    open=float(opens[i]),
                    high=float(highs[i]),
                    low=float(lows[i]),
                    close=float(closes[i]),
                )
                for i, ts in enumerate(timestamps)
            )

            chunk_start = chunk_end + timedelta(days=1)

        return candles

    # --- Order placement (P0 of the live-broker-adapter roadmap item, see
    # docs/architecture.md) - see this module's own ORDERS_URL/FUNDS_URL
    # comment above: unlike every read-only method in this file, the exact
    # request/response field names below are NOT yet confirmed against a
    # live Dhan call. Every method here is credentials-aware the same way
    # get_ltp_batch/get_option_chain already are (BYO per-user, falling
    # back to the platform-default only when `credentials` is None) -
    # `execution` never holds a Dhan credential directly, only market-data
    # does, so this is the one place a real order can be placed from at
    # all. -------------------------------------------------------------

    def _order_headers(self, access_token: str, client_id: str) -> dict:
        return {"Accept": "application/json", "Content-Type": "application/json", "access-token": access_token, "client-id": client_id}

    def _order_credentials(self, credentials: Optional["DhanCredentials"]) -> tuple[str, str]:
        access_token = credentials.access_token if credentials else current_access_token()
        client_id = credentials.client_id if credentials else settings.dhan_client_id
        if not client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")
        return access_token, client_id

    def _raise_for_order_response(self, resp, label: str) -> None:
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError(f"Dhan API rate limit hit (429) on {label} - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}) on {label}: {resp.text[:200]}") from exc

    def place_order(
        self,
        symbol: str,
        transaction_type: str,
        quantity: int,
        order_type: str,
        product_type: str,
        price: Optional[float] = None,
        trigger_price: Optional[float] = None,
        correlation_id: Optional[str] = None,
        credentials: Optional["DhanCredentials"] = None,
    ) -> dict:
        """Places a REAL order on Dhan - `symbol` resolves to a security
        ID/exchange segment the same way resolve_feed_target already does
        for the live market-feed WebSocket (this provider's own
        instrument-master cache, not a caller-supplied Dhan ID - execution
        never needs to know Dhan's internal IDs). `transaction_type`
        ('BUY'/'SELL'), `order_type` ('MARKET'/'LIMIT'/'STOP_LOSS'/
        'STOP_LOSS_MARKET'), and `product_type' ('CNC'/'INTRADAY'/'MARGIN'/
        'MTF') are passed through to Dhan as-is - validating that the
        combination makes sense (e.g. a STOP_LOSS order needs both `price`
        and `trigger_price`) is the caller's job, not this transport-layer
        method's. `correlation_id`, if given, is forwarded as Dhan's own
        client-supplied order reference (their `correlationId` field per
        general v2 docs) - execution's own broker_orders.client_order_id
        should be threaded through here for the submit-then-crash
        idempotency story the live-broker-adapter plan calls for; whether
        Dhan actually honors it as a dedup key (vs. just an opaque label
        echoed back) needs confirming live, not assumed."""
        target = self.resolve_feed_target(symbol)
        if target is None:
            raise RuntimeError(f"unknown symbol '{symbol}' ({self.name}) - instrument master may need a sync")
        segment_key, security_id = target

        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "order")

        body = {
            "dhanClientId": client_id,
            "correlationId": correlation_id,
            "transactionType": transaction_type,
            "exchangeSegment": segment_key,
            "productType": product_type,
            "orderType": order_type,
            "validity": "DAY",
            "securityId": security_id,
            "quantity": quantity,
            "disclosedQuantity": 0,
            "price": price or 0,
            "triggerPrice": trigger_price or 0,
            "afterMarketOrder": False,
        }
        resp = requests.post(ORDERS_URL, headers=self._order_headers(access_token, client_id), json=body, timeout=15)
        self._raise_for_order_response(resp, "place-order")
        return resp.json()

    def modify_order(
        self,
        order_id: str,
        order_type: str,
        quantity: int,
        price: Optional[float] = None,
        trigger_price: Optional[float] = None,
        credentials: Optional["DhanCredentials"] = None,
    ) -> dict:
        """Modifies an already-placed order still resting on the exchange -
        the mechanism the live-broker-adapter plan's throttled trailing-SL
        reconciliation calls to move a resting SL/SL-M order's trigger
        price, instead of Dhan's own order book tracking a full order
        history. See place_order's own docstring on unverified field
        shapes - this one especially, since Dhan's modify payload only
        needs to carry what's CHANGING, and which fields are optional-vs-
        required here isn't confirmed."""
        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "modify-order")

        body = {
            "dhanClientId": client_id,
            "orderId": order_id,
            "orderType": order_type,
            "quantity": quantity,
            "price": price or 0,
            "triggerPrice": trigger_price or 0,
            "validity": "DAY",
        }
        resp = requests.put(f"{ORDERS_URL}/{order_id}", headers=self._order_headers(access_token, client_id), json=body, timeout=15)
        self._raise_for_order_response(resp, "modify-order")
        return resp.json()

    def cancel_order(self, order_id: str, credentials: Optional["DhanCredentials"] = None) -> dict:
        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "cancel-order")

        resp = requests.delete(f"{ORDERS_URL}/{order_id}", headers=self._order_headers(access_token, client_id), timeout=15)
        self._raise_for_order_response(resp, "cancel-order")
        return resp.json()

    def get_order(self, order_id: str, credentials: Optional["DhanCredentials"] = None) -> Optional[dict]:
        """None on a 404 (unknown order id) - every other non-2xx still
        raises, same convention _security_id-based lookups elsewhere in
        this file use for "doesn't exist" vs. "something's actually
        wrong"."""
        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "get-order")

        resp = requests.get(f"{ORDERS_URL}/{order_id}", headers=self._order_headers(access_token, client_id), timeout=15)
        if resp.status_code == 404:
            return None
        self._raise_for_order_response(resp, "get-order")
        return resp.json()

    def get_order_book(self, credentials: Optional["DhanCredentials"] = None) -> list[dict]:
        """Every order for this credential's account, regardless of our
        own DB state - the reconciliation job's own source of truth when a
        broker_orders row is stuck SUBMITTING with no broker_order_id yet
        (a crash between calling place_order and recording its response),
        matched back to our own row by correlationId (see place_order's
        own docstring on why that match isn't yet confirmed to actually
        work against Dhan's real API)."""
        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "order-book")

        resp = requests.get(ORDERS_URL, headers=self._order_headers(access_token, client_id), timeout=15)
        self._raise_for_order_response(resp, "order-book")
        data = resp.json()
        return data if isinstance(data, list) else data.get("data", [])

    def get_funds(self, credentials: Optional["DhanCredentials"] = None) -> dict:
        """Real available funds/margin - replaces trusting the simulated
        execution.accounts.current_balance ledger (never reconciled
        against anything real) for any live_trading_enabled account, per
        the live-broker-adapter plan's own P0 scope."""
        access_token, client_id = self._order_credentials(credentials)
        self._throttle(self._order_lock, self._last_order_call_at, credentials.throttle_key if credentials else None, MIN_ORDER_CALL_INTERVAL_SECONDS, "funds")

        resp = requests.get(FUNDS_URL, headers=self._order_headers(access_token, client_id), timeout=15)
        self._raise_for_order_response(resp, "funds")
        return resp.json()

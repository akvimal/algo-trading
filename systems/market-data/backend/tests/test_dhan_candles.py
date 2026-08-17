import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import responses

from app.config import settings
from app.domain.models import Candle
from app.providers.dhan import CANDLE_URL, INSTRUMENT_MASTER_URL, DhanProvider, _aggregate_candles, _interval_minutes

FAKE_CSV = (
    "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,"
    "SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,"
    "SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n"
    "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
)


def _candle_response(interval_minutes: int) -> dict:
    """3 completed bars (3/2/1 intervals ago) plus 1 still-forming bar
    (started 5s ago) - every supported interval here is >=60s, so 5s
    comfortably guarantees that last bar hasn't completed yet."""
    tz = ZoneInfo("Asia/Kolkata")
    now = datetime.now(tz)
    interval_seconds = interval_minutes * 60
    timestamps = [int((now - timedelta(seconds=interval_seconds * n)).timestamp()) for n in (3, 2, 1)]
    timestamps.append(int((now - timedelta(seconds=5)).timestamp()))

    n = len(timestamps)
    return {
        "open": [100.0 + i for i in range(n)],
        "high": [105.0 + i for i in range(n)],
        "low": [95.0 + i for i in range(n)],
        "close": [102.0 + i for i in range(n)],
        "volume": [1000] * n,
        "timestamp": timestamps,
    }


@responses.activate
def test_get_previous_candle_returns_most_recent_completed_bar(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    responses.add(responses.POST, CANDLE_URL, json=_candle_response(5), status=200)

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}  # skip the sync call

    candle = provider.get_previous_candle("RELIANCE", "5min")

    assert candle is not None
    # index 2 (1 interval ago) is the most recent *completed* bar - index 3 (5s ago) is still forming
    assert candle.open == 102.0
    assert candle.high == 107.0
    assert candle.low == 97.0
    assert candle.close == 104.0
    assert candle.symbol == "RELIANCE"
    assert candle.interval == "5min"
    assert candle.provider == "dhan"

    sent_body = responses.calls[0].request.body
    assert b'"securityId": "2885"' in sent_body or b'"securityId":"2885"' in sent_body
    assert b'"interval": "5"' in sent_body or b'"interval":"5"' in sent_body


@responses.activate
def test_get_previous_candle_no_completed_bar_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    tz = ZoneInfo("Asia/Kolkata")
    now = datetime.now(tz)
    only_forming = {
        "open": [100.0], "high": [105.0], "low": [95.0], "close": [102.0], "volume": [1000],
        "timestamp": [int((now - timedelta(seconds=5)).timestamp())],
    }
    responses.add(responses.POST, CANDLE_URL, json=only_forming, status=200)

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    assert provider.get_previous_candle("RELIANCE", "5min") is None


@responses.activate
def test_get_previous_candle_unknown_symbol_returns_none_without_network_call(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)
    # No CANDLE_URL response registered - a call to it would raise ConnectionError,
    # proving get_previous_candle short-circuits before reaching Dhan for an unknown symbol.

    provider = DhanProvider()
    assert provider.get_previous_candle("NOPE", "5min") is None


def test_get_previous_candle_unsupported_interval_raises():
    """"daily" isn't a native Dhan intraday granularity and isn't an
    "Nmin" shape either, so it can't be served by local aggregation -
    unlike "30min"/"3min", which now work via _aggregate_candles."""
    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}
    try:
        provider.get_previous_candle("RELIANCE", "daily")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "unsupported candle interval" in str(exc)


@responses.activate
def test_get_previous_candle_second_call_within_interval_ttl_hits_cache(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    # Only one response registered - a second network call would raise ConnectionError.
    responses.add(responses.POST, CANDLE_URL, json=_candle_response(5), status=200)

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    first = provider.get_previous_candle("RELIANCE", "5min")
    second = provider.get_previous_candle("RELIANCE", "5min")

    assert first == second


def test_get_previous_candle_without_credentials_raises(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}
    try:
        provider.get_previous_candle("RELIANCE", "5min")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "DHAN_CLIENT_ID" in str(exc)


def test_get_previous_candle_fails_fast_when_throttle_queue_too_deep(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}
    provider._last_candle_call_at = time.monotonic() + 3.0

    try:
        provider.get_previous_candle("RELIANCE", "5min")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)


def test_candle_throttle_is_independent_of_ltp_throttle(monkeypatch):
    """A backed-up LTP queue must not block a candle fetch, and vice versa -
    the two throttles are separate state (see dhan.py comments)."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}
    provider._last_ltp_call_at = time.monotonic() + 3.0  # LTP queue backed up

    with responses.RequestsMock() as rsps:
        rsps.add(responses.POST, CANDLE_URL, json=_candle_response(5), status=200)
        candle = provider.get_previous_candle("RELIANCE", "5min")

    assert candle is not None


# ---- local aggregation ("3min" and other non-native "Nmin" intervals) ----


def _one_min_candle(minute_offset: int, o: float, h: float, l: float, c: float) -> Candle:
    """A 1-minute candle starting at 09:15 + minute_offset IST, on an
    arbitrary fixed date - only the time-of-day matters for bucket
    alignment."""
    tz = ZoneInfo("Asia/Kolkata")
    ts = datetime(2026, 8, 12, 9, 15, tzinfo=tz) + timedelta(minutes=minute_offset)
    return Candle(
        exchange="NSE", symbol="RELIANCE", interval="1min",
        open=o, high=h, low=l, close=c, timestamp=ts.isoformat(), provider="dhan",
    )


def test_interval_minutes_parses_native_and_generic_shapes():
    assert _interval_minutes("5min") == 5  # native
    assert _interval_minutes("3min") == 3  # generic "Nmin", locally aggregated
    assert _interval_minutes("30min") == 30
    try:
        _interval_minutes("daily")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_aggregate_candles_buckets_aligned_to_clock_multiples():
    # 9 one-minute bars starting at the 09:15 session open (555 minutes
    # since midnight, divisible by 3) -> exactly 3 complete 3-minute buckets.
    ones = [_one_min_candle(i, 100 + i, 105 + i, 95 + i, 102 + i) for i in range(9)]

    aggregated = _aggregate_candles(ones, "3min", 3)

    assert len(aggregated) == 3
    assert [c.interval for c in aggregated] == ["3min", "3min", "3min"]
    first = aggregated[0]
    # open = first member's open, close = last member's close, high/low = extremes across the bucket
    assert first.open == ones[0].open
    assert first.close == ones[2].close
    assert first.high == max(ones[0].high, ones[1].high, ones[2].high)
    assert first.low == min(ones[0].low, ones[1].low, ones[2].low)
    assert first.timestamp == ones[0].timestamp  # bucket start == first member's own timestamp (09:15 aligned)


def test_aggregate_candles_drops_incomplete_trailing_bucket():
    # 7 bars = 2 complete 3-minute buckets (6 bars) + 1 leftover bar that
    # can't form a full bucket yet - must be dropped, not emitted early.
    ones = [_one_min_candle(i, 100 + i, 105 + i, 95 + i, 102 + i) for i in range(7)]

    aggregated = _aggregate_candles(ones, "3min", 3)

    assert len(aggregated) == 2


def test_aggregate_candles_empty_input_returns_empty():
    assert _aggregate_candles([], "3min", 3) == []


@responses.activate
def test_get_candle_history_aggregates_3min_from_native_1min_bars(monkeypatch):
    """A non-native interval must fetch native 1min bars (interval="1" in
    the Dhan request body) and aggregate them locally - exactly one Dhan
    call, not one call per bucket."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    # Anchored to an actual clock-aligned 3-minute boundary an hour in the
    # past (not a hardcoded date) so every 1-min bar is safely *completed*
    # by the time this runs, regardless of when the test executes.
    tz = ZoneInfo("Asia/Kolkata")
    anchor = datetime.now(tz) - timedelta(hours=1)
    aligned_minutes = ((anchor.hour * 60 + anchor.minute) // 3) * 3
    start = anchor.replace(hour=aligned_minutes // 60, minute=aligned_minutes % 60, second=0, microsecond=0)
    timestamps = [int((start + timedelta(minutes=i)).timestamp()) for i in range(6)]  # 2 complete 3min buckets
    responses.add(
        responses.POST,
        CANDLE_URL,
        json={
            "open": [100.0 + i for i in range(6)],
            "high": [105.0 + i for i in range(6)],
            "low": [95.0 + i for i in range(6)],
            "close": [102.0 + i for i in range(6)],
            "timestamp": timestamps,
        },
        status=200,
    )

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    candles = provider.get_candle_history("RELIANCE", "3min", date(2026, 8, 12), date(2026, 8, 12))

    assert len(responses.calls) == 1  # a single underlying 1min fetch, not per-bucket calls
    sent_body = responses.calls[0].request.body
    assert b'"interval": "1"' in sent_body or b'"interval":"1"' in sent_body
    assert len(candles) == 2
    assert all(c.interval == "3min" for c in candles)
    assert candles[0].open == 100.0
    assert candles[0].close == 104.0
    assert candles[1].open == 103.0
    assert candles[1].close == 107.0


@responses.activate
def test_get_candle_history_native_interval_makes_no_aggregation_overhead(monkeypatch):
    """A native interval (5min) must be requested directly from Dhan, not
    routed through the 1min-fetch-and-aggregate path - regression guard
    for the local-aggregation fallback added for non-native intervals."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    base = int(datetime.now().timestamp()) - 3600
    timestamps = [base + i * 300 for i in range(5)]
    responses.add(
        responses.POST,
        CANDLE_URL,
        json={
            "open": [100.0] * 5, "high": [105.0] * 5, "low": [95.0] * 5, "close": [102.0] * 5,
            "timestamp": timestamps,
        },
        status=200,
    )

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    candles = provider.get_candle_history("RELIANCE", "5min", date.today() - timedelta(days=1), date.today())

    assert len(responses.calls) == 1
    sent_body = responses.calls[0].request.body
    assert b'"interval": "5"' in sent_body or b'"interval":"5"' in sent_body
    assert len(candles) == 5
    assert all(c.interval == "5min" for c in candles)


# --- get_data_availability -----------------------------------------------------------------


def test_get_data_availability_reports_fixed_90_day_cap_without_any_http_call():
    # A fixed, documented constant (DHAN_INTRADAY_MAX_DAYS_PER_REQUEST) -
    # no live probe, so this must not touch the network at all (no
    # responses.activate/CANDLE_URL registration - a stray call would 501
    # with ConnectionError from the `responses` library if this changed).
    provider = DhanProvider()

    result = provider.get_data_availability("RELIANCE", "5min")

    assert result.exchange == "NSE"
    assert result.symbol == "RELIANCE"
    assert result.interval == "5min"
    assert result.max_days_per_request == 90
    assert result.earliest_available_date is None

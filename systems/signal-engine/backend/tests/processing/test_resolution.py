from datetime import datetime, timezone

import pytest
import requests
import responses

from app.config import settings
from app.domain.processing.models import SignalIngest
from app.domain.processing.resolution.errors import ResolutionError
from app.domain.processing.resolution.pipeline import resolve

STRATEGY_ID = "11111111-1111-1111-1111-111111111111"


def _signal(**overrides) -> SignalIngest:
    defaults = dict(
        strategy_id=STRATEGY_ID,
        symbol="RELIANCE",
        exchange="NSE",
        action="BUY",
        price=2500.0,
        timestamp=datetime.now(timezone.utc),
        source="chartink",
        source_meta={"scan_name": "Bullish Breakout"},
    )
    defaults.update(overrides)
    return SignalIngest(**defaults)


def _fetch(strategy: dict):
    """A resolve() fetch_strategy fake that always returns `strategy` -
    stands in for the real in-process app/domain/processing/resolution/
    generation_lookup.py (a DB lookup) the same way this used to stand in
    for an HTTP call to signal-generation, before the signal-engine merge
    (2026-08-28, see docs/architecture.md)."""
    return lambda strategy_id: strategy


def _fetch_raises(exc: Exception):
    def _raise(strategy_id):
        raise exc

    return _raise


def test_resolve_uses_live_strategy_config():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "MCX",
    }

    resolved = resolve(_signal(), _fetch(strategy))

    assert resolved.horizon == "intraday"
    assert resolved.instrument_type == "spot"
    assert resolved.segment == "MCX"  # passed through unchanged, for execution's account routing
    assert resolved.strategy is None  # spot -> no option-strategy legs
    # Not present in the fetched Strategy dict above - defaults apply, same
    # as trailing_stop_enabled's own missing-key default.
    assert resolved.duplicate_signal_policy == "skip"
    assert resolved.counter_signal_policy == "close_and_flip"
    assert resolved.option_sl_scope is None  # instrument_type='spot' -> always None, never defaulted


def test_resolve_passes_through_signal_conflict_policy():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "duplicate_signal_policy": "skip",
        "counter_signal_policy": "close_and_flip",
    }

    resolved = resolve(_signal(), _fetch(strategy))

    assert resolved.duplicate_signal_policy == "skip"
    assert resolved.counter_signal_policy == "close_and_flip"


def test_resolve_rejects_non_live_strategy():
    strategy = {
        "id": STRATEGY_ID,
        "status": "draft",
        "horizon": "intraday",
        "instrument_type": "spot",
    }

    with pytest.raises(ResolutionError, match="not live"):
        resolve(_signal(), _fetch(strategy))


def test_resolve_allows_manual_signal_for_non_live_strategy():
    # source="manual" (the frontend's "Send test signal"/Manual tab) is
    # exempt from the live-status check specifically so a strategy can be
    # exercised end-to-end before being promoted to live.
    strategy = {
        "id": STRATEGY_ID,
        "status": "draft",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
    }

    resolved = resolve(_signal(source="manual"), _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_rejects_unknown_strategy():
    with pytest.raises(ResolutionError, match="not found"):
        resolve(_signal(), _fetch_raises(ResolutionError(f"strategy {STRATEGY_ID} not found")))


# --- active_windows (per-strategy signal-acceptance window(s)) -------------------------------


def test_resolve_rejects_signal_outside_active_window():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [{"start": "09:15:00", "end": "11:00:00"}],
    }
    # 03:00 UTC = 08:30 IST - before the window opens.
    signal = _signal(timestamp=datetime(2026, 8, 12, 3, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="outside strategy's active window"):
        resolve(signal, _fetch(strategy))


def test_resolve_accepts_signal_inside_active_window():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [{"start": "09:15:00", "end": "11:00:00"}],
    }
    # 05:00 UTC = 10:30 IST - inside the window.
    signal = _signal(timestamp=datetime(2026, 8, 12, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_accepts_signal_inside_second_of_multiple_active_windows():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [
            {"start": "09:15:00", "end": "10:30:00"},
            {"start": "13:00:00", "end": "14:30:00"},
        ],
    }
    # 08:00 UTC = 13:30 IST - inside the second window only.
    signal = _signal(timestamp=datetime(2026, 8, 12, 8, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_rejects_signal_between_multiple_active_windows():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [
            {"start": "09:15:00", "end": "10:30:00"},
            {"start": "13:00:00", "end": "14:30:00"},
        ],
    }
    # 06:30 UTC = 12:00 IST - between the two windows.
    signal = _signal(timestamp=datetime(2026, 8, 12, 6, 30, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="outside strategy's active window"):
        resolve(signal, _fetch(strategy))


def test_resolve_ignores_unset_active_window():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
    }
    # No windows configured (key absent entirely) - any timestamp resolves, backward compatible.
    signal = _signal(timestamp=datetime(2026, 8, 12, 0, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_ignores_empty_active_windows_list():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [],
    }
    signal = _signal(timestamp=datetime(2026, 8, 12, 0, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_rejects_cleanly_when_active_window_set_but_timestamp_missing():
    """Reproduces a real bug (2026-08-14): no intake path (Chartink,
    manual, in-house) ever actually sets SignalIngest.timestamp - it's
    None on arrival, normalized to "now" only by create_signal_from_ingest
    right before calling resolve(). If resolve() is ever reached with
    timestamp still None (this test bypasses that normalization on
    purpose), it must raise a clean ResolutionError - matching this
    function's own documented contract - not an unhandled AttributeError
    from None.astimezone() that would 500 the whole request. This exact
    crash went undetected until a Strategy finally had an active window
    set for the first time, since `if active_windows:` had always
    short-circuited before reaching is_within_active_window on every
    earlier signal."""
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_windows": [{"start": "09:15:00", "end": "11:00:00"}],
    }
    signal = _signal(timestamp=None)

    with pytest.raises(ResolutionError, match="no timestamp"):
        resolve(signal, _fetch(strategy))


# --- active_weekdays (per-strategy day-of-week signal-acceptance filter) ----------------------


def test_resolve_rejects_signal_on_a_day_outside_active_weekdays():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    }
    # 2026-08-15 is a Saturday (IST date matches UTC date at this hour).
    signal = _signal(timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="outside strategy's active weekday"):
        resolve(signal, _fetch(strategy))


def test_resolve_accepts_signal_on_a_day_inside_active_weekdays():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    }
    # 2026-08-12 is a Wednesday.
    signal = _signal(timestamp=datetime(2026, 8, 12, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_ignores_unset_active_weekdays():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
    }
    # No active_weekdays configured (key absent entirely) - a Saturday still resolves.
    signal = _signal(timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_ignores_empty_active_weekdays_list():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_weekdays": [],
    }
    signal = _signal(timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(strategy))

    assert resolved.horizon == "intraday"


def test_resolve_rejects_cleanly_when_active_weekday_set_but_timestamp_missing():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "active_weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    }
    signal = _signal(timestamp=None)

    with pytest.raises(ResolutionError, match="no timestamp"):
        resolve(signal, _fetch(strategy))


# Note: there used to be a test here for "signal-generation unreachable"
# (an HTTP ConnectionError fetching the strategy) - that failure mode no
# longer exists since the signal-engine merge (2026-08-28): fetch_strategy
# is an in-process DB lookup now, not a cross-service HTTP call, so there's
# nothing left to be "unreachable". See generation_lookup.py.


# --- instrument_type='option' (Phase 4b of the options trading module) -----------------------


def _resolve_url() -> str:
    return f"{settings.market_data_base_url}/instruments/resolve"


def _expiries_url() -> str:
    return f"{settings.market_data_base_url}/options/expiries"


def _chain_url() -> str:
    return f"{settings.market_data_base_url}/options/chain"


def _resolved_underlying_json(**overrides) -> dict:
    defaults = dict(
        chart_symbol="NIFTY",
        chart_exchange="NSE",
        trade_symbol="NIFTY-FUT",
        trade_exchange="NSE",
        lot_size=50,
    )
    defaults.update(overrides)
    return defaults


def _option_strategy_json(**overrides) -> dict:
    defaults = dict(
        id=STRATEGY_ID,
        status="live",
        horizon="intraday",
        instrument_type="option",
        segment="NSE",
    )
    defaults.update(overrides)
    return defaults


_FAKE_CHAIN = {
    "underlying_symbol": "NIFTY",
    "underlying_exchange": "NSE",
    "expiry": "2026-08-14",
    "underlying_last_price": 24000.0,
    "strikes": [
        {
            "strike": 23900.0,
            "ce": {"security_id": "ce-23900", "moneyness": "ITM", "oi": 5000},
            "pe": {"security_id": "pe-23900", "moneyness": "OTM", "oi": 5000},
        },
        {
            "strike": 24000.0,
            "ce": {"security_id": "ce-24000", "moneyness": "ATM", "oi": 5000},
            "pe": {"security_id": "pe-24000", "moneyness": "ATM", "oi": 5000},
        },
        {
            "strike": 24100.0,
            "ce": {"security_id": "ce-24100", "moneyness": "OTM", "oi": 5000},
            "pe": {"security_id": "pe-24100", "moneyness": "ITM", "oi": 5000},
        },
    ],
}


@responses.activate
def test_resolve_option_strategy_bull_call_spread_for_buy_signal():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json()))

    assert resolved.instrument_type == "option"
    assert resolved.strategy == {
        "type": "bull_call_spread",
        "legs": [
            {"action": "BUY", "option_type": "CE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "ce-24000"},
            {"action": "SELL", "option_type": "CE", "strike": 24100.0, "expiry": "2026-08-14", "security_id": "ce-24100"},
        ],
    }


@responses.activate
def test_resolve_option_strategy_bear_put_spread_for_sell_signal():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="SELL"), _fetch(_option_strategy_json()))

    assert resolved.strategy["type"] == "bear_put_spread"
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_for_mcx_uses_resolved_futures_contract():
    # MCX has no separate spot instrument - the option chain must be looked
    # up against the active-month futures contract symbol (chart_symbol),
    # never the bare underlying name ("GOLDM") the signal itself carries.
    responses.add(
        responses.GET,
        _resolve_url(),
        json=_resolved_underlying_json(
            chart_symbol="GOLDM-04Sep2026-FUT",
            chart_exchange="MCX",
            trade_symbol="GOLDM-04Sep2026-FUT",
            trade_exchange="MCX",
            lot_size=100,
        ),
        status=200,
    )
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(
        responses.GET,
        _chain_url(),
        json={**_FAKE_CHAIN, "underlying_symbol": "GOLDM-04Sep2026-FUT", "underlying_exchange": "MCX"},
        status=200,
    )

    resolved = resolve(
        _signal(symbol="GOLDM", exchange="MCX", action="BUY"), _fetch(_option_strategy_json(segment="MCX"))
    )

    assert resolved.strategy["type"] == "bull_call_spread"
    # calls[0] = resolve_underlying, [1] = expiries, [2] = chain (the
    # strategy fetch is no longer an HTTP call at all - see _fetch above)
    assert responses.calls[1].request.params["symbol"] == "GOLDM-04Sep2026-FUT"
    assert responses.calls[1].request.params["exchange"] == "MCX"
    assert responses.calls[2].request.params["symbol"] == "GOLDM-04Sep2026-FUT"


@responses.activate
def test_resolve_option_strategy_for_crypto_uses_delta_chain():
    # CRYPTO has no separate spot either (like MCX) - chart_symbol ==
    # trade_symbol == the perpetual itself ("BTCUSD"), and Delta's own
    # security_id is a stringified product_id, not Dhan's - same generic
    # code path, just proving it actually works for the third exchange.
    responses.add(
        responses.GET,
        _resolve_url(),
        json=_resolved_underlying_json(
            chart_symbol="BTCUSD", chart_exchange="CRYPTO", trade_symbol="BTCUSD", trade_exchange="CRYPTO", lot_size=1
        ),
        status=200,
    )
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-15"]}, status=200)
    responses.add(
        responses.GET,
        _chain_url(),
        json={
            **_FAKE_CHAIN,
            "underlying_symbol": "BTCUSD",
            "underlying_exchange": "CRYPTO",
            "expiry": "2026-08-15",
            "underlying_last_price": 63500.0,
            "strikes": [
                {
                    "strike": 63000.0,
                    "ce": {"security_id": "139801", "moneyness": "ITM", "oi": 120},
                    "pe": {"security_id": "139802", "moneyness": "OTM", "oi": 90},
                },
                {
                    "strike": 63500.0,
                    "ce": {"security_id": "139823", "moneyness": "ATM", "oi": 200},
                    "pe": {"security_id": "139824", "moneyness": "ATM", "oi": 180},
                },
                {
                    "strike": 64000.0,
                    "ce": {"security_id": "139845", "moneyness": "OTM", "oi": 150},
                    "pe": {"security_id": "139846", "moneyness": "ITM", "oi": 110},
                },
            ],
        },
        status=200,
    )

    resolved = resolve(
        _signal(symbol="BTCUSD", exchange="CRYPTO", action="BUY"), _fetch(_option_strategy_json(segment="CRYPTO"))
    )

    assert resolved.instrument_type == "option"
    assert resolved.strategy == {
        "type": "bull_call_spread",
        "legs": [
            {"action": "BUY", "option_type": "CE", "strike": 63500.0, "expiry": "2026-08-15", "security_id": "139823"},
            {"action": "SELL", "option_type": "CE", "strike": 64000.0, "expiry": "2026-08-15", "security_id": "139845"},
        ],
    }
    # calls[0] = resolve_underlying, [1] = expiries, [2] = chain
    assert responses.calls[0].request.params["segment"] == "CRYPTO"
    assert responses.calls[1].request.params["symbol"] == "BTCUSD"
    assert responses.calls[1].request.params["exchange"] == "CRYPTO"


@responses.activate
def test_resolve_option_strategy_for_crypto_sell_signal_uses_bear_put_spread():
    responses.add(
        responses.GET,
        _resolve_url(),
        json=_resolved_underlying_json(
            chart_symbol="BTCUSD", chart_exchange="CRYPTO", trade_symbol="BTCUSD", trade_exchange="CRYPTO", lot_size=1
        ),
        status=200,
    )
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-15"]}, status=200)
    responses.add(responses.GET, _chain_url(), json={**_FAKE_CHAIN, "underlying_symbol": "BTCUSD"}, status=200)

    resolved = resolve(
        _signal(symbol="BTCUSD", exchange="CRYPTO", action="SELL"), _fetch(_option_strategy_json(segment="CRYPTO"))
    )

    assert resolved.strategy["type"] == "bear_put_spread"
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_naked_call_for_buy_signal():
    # option_position_style='naked' -> single BUY leg, no short leg -
    # signal-processing has no exchange-specific logic either way, so an
    # NSE fixture is enough to exercise the branch (see
    # test_resolve_option_strategy_for_crypto_uses_delta_chain above for
    # the exchange-agnostic confirmation).
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(
        _signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json(option_position_style="naked"))
    )

    assert resolved.strategy == {
        "type": "naked_call",
        "legs": [
            {"action": "BUY", "option_type": "CE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "ce-24000"},
        ],
    }


@responses.activate
def test_resolve_option_strategy_naked_put_for_sell_signal():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(
        _signal(symbol="NIFTY", action="SELL"), _fetch(_option_strategy_json(option_position_style="naked"))
    )

    assert resolved.strategy["type"] == "naked_put"
    assert len(resolved.strategy["legs"]) == 1
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_defaults_to_spread_when_style_unset():
    # Backward compatibility: a strategy fetched before option_position_style
    # existed (or one that never set it) has no such key in the JSON at
    # all - resolve() must default to 'spread', not crash/None.
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json()))

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_passes_through_non_atm_moneyness():
    # option_strike_moneyness threads all the way from the fetched
    # Strategy dict through pipeline.py -> choose_option_strategy -> the
    # template - confirmed here by the primary leg landing on 24100
    # (OTM1, one strike above ATM=24000), not the literal ATM strike.
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(
        _signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json(option_strike_moneyness="OTM1"))
    )

    assert resolved.strategy["legs"][0]["strike"] == 24100.0


@responses.activate
def test_resolve_option_strategy_defaults_sl_scope_to_combined():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json()))

    assert resolved.option_sl_scope == "combined"


@responses.activate
def test_resolve_option_strategy_passes_through_individual_sl_scope():
    # option_sl_scope only affects how execution monitors an already-
    # resolved group, not which legs get built - confirmed here by the
    # legs staying exactly the same shape (bull_call_spread, ATM/OTM2
    # strikes from _FAKE_CHAIN) regardless of the sl_scope value.
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(
        _signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json(option_sl_scope="individual"))
    )

    assert resolved.option_sl_scope == "individual"
    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_defaults_fixed_lots_to_none():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json()))

    assert resolved.fixed_lots is None


@responses.activate
def test_resolve_option_strategy_passes_through_fixed_lots():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"), _fetch(_option_strategy_json(fixed_lots=5)))

    assert resolved.fixed_lots == 5


def test_resolve_spot_strategy_passes_through_fixed_lots():
    # fixed_lots is no longer options-only (renamed from option_fixed_lots)
    # - a spot strategy's own value must reach the resolved order too.
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
        "fixed_lots": 5,
    }

    resolved = resolve(_signal(), _fetch(strategy))

    assert resolved.fixed_lots == 5


@responses.activate
def test_resolve_option_strategy_resolves_when_today_is_expiry_day():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)
    # intraday always picks the nearest expiry (2026-08-14) - today matches it.
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 14, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal, _fetch(_option_strategy_json(contract_day_filter="expiry")))

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_rejects_when_today_is_not_expiry_day():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 13, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="contract_day_filter='expiry'"):
        resolve(signal, _fetch(_option_strategy_json(contract_day_filter="expiry")))


@responses.activate
def test_resolve_option_strategy_resolves_when_today_is_start_day():
    # positional + only "2026-08-14" qualifying (< 7 days out from
    # 2026-08-15) falls back to it anyway (choose_expiry's
    # "no qualifying expiry -> furthest available" rule) - but with a
    # second, later expiry present, MIN_POSITIONAL_DAYS_TO_EXPIRY=7 pushes
    # the pick to "2026-08-21" (idx=1), whose previous list entry is
    # "2026-08-14" - so the contract "started" the day after, 2026-08-15.
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    responses.add(responses.GET, _chain_url(), json={**_FAKE_CHAIN, "expiry": "2026-08-21"}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(
        signal, _fetch(_option_strategy_json(horizon="positional", contract_day_filter="start"))
    )

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_rejects_when_today_is_not_start_day():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 16, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="contract_day_filter='start'"):
        resolve(
            signal, _fetch(_option_strategy_json(horizon="positional", contract_day_filter="start"))
        )


@responses.activate
def test_resolve_option_strategy_rejects_start_when_no_earlier_expiry_known():
    # Only one live expiry - the chosen one is always idx 0, so there's no
    # "previous" entry in the list to compute day-after from.
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="no earlier expiry known"):
        resolve(signal, _fetch(_option_strategy_json(contract_day_filter="start")))


@responses.activate
def test_resolve_option_strategy_crypto_bypasses_day_filter():
    responses.add(
        responses.GET,
        _resolve_url(),
        json=_resolved_underlying_json(
            chart_symbol="BTCUSD", chart_exchange="CRYPTO", trade_symbol="BTCUSD", trade_exchange="CRYPTO", lot_size=1
        ),
        status=200,
    )
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-15"]}, status=200)
    responses.add(responses.GET, _chain_url(), json={**_FAKE_CHAIN, "underlying_symbol": "BTCUSD"}, status=200)
    # Today is nowhere near the chosen expiry - would fail if enforced.
    signal = _signal(symbol="BTCUSD", exchange="CRYPTO", action="BUY", timestamp=datetime(2026, 1, 1, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(
        signal, _fetch(_option_strategy_json(segment="CRYPTO", contract_day_filter="expiry"))
    )

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_rejects_when_market_data_unreachable():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), body=requests.exceptions.ConnectionError("refused"))

    with pytest.raises(ResolutionError, match="could not resolve option expiries"):
        resolve(_signal(symbol="NIFTY"), _fetch(_option_strategy_json()))


@responses.activate
def test_resolve_option_rejects_unresolvable_underlying():
    responses.add(responses.GET, _resolve_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="could not resolve underlying"):
        resolve(_signal(symbol="NOTREAL"), _fetch(_option_strategy_json()))


@responses.activate
def test_resolve_option_rejects_unresolvable_expiries():
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="could not resolve option expiries"):
        resolve(_signal(symbol="NIFTY"), _fetch(_option_strategy_json()))


def test_resolve_passes_through_exit_condition():
    exit_condition = {
        "interval": "5min",
        "left": {"kind": "cci", "period": 200, "offset_bars": 0, "scale": 1.0, "value": None, "field": None},
        "operator": "<",
        "right": {"kind": "constant", "period": None, "offset_bars": 0, "scale": 1.0, "value": 200.0, "field": None},
    }
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "future",
        "segment": "MCX",
        "exit_condition": exit_condition,
    }

    resolved = resolve(_signal(), _fetch(strategy))

    assert resolved.exit_condition == exit_condition


def test_resolve_exit_condition_defaults_to_none_when_absent():
    strategy = {
        "id": STRATEGY_ID,
        "status": "live",
        "horizon": "intraday",
        "instrument_type": "spot",
        "segment": "NSE",
    }
    assert resolve(_signal(), _fetch(strategy)).exit_condition is None

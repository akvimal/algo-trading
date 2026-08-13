from datetime import datetime, timezone

import pytest
import requests
import responses

from app.config import settings
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.pipeline import resolve

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


def _strategy_url() -> str:
    return f"{settings.signal_generation_base_url}/strategies/{STRATEGY_ID}"


@responses.activate
def test_resolve_uses_live_strategy_config():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "MCX",
        },
        status=200,
    )

    resolved = resolve(_signal())

    assert resolved.horizon == "intraday"
    assert resolved.instrument_type == "spot"
    assert resolved.segment == "MCX"  # passed through unchanged, for execution's account routing
    assert resolved.strategy is None  # spot -> no option-strategy legs
    # Not present in the fetched Strategy dict above - defaults apply, same
    # as trailing_stop_enabled's own missing-key default.
    assert resolved.duplicate_signal_policy == "skip"
    assert resolved.counter_signal_policy == "close_and_flip"
    assert resolved.option_sl_scope is None  # instrument_type='spot' -> always None, never defaulted


@responses.activate
def test_resolve_passes_through_signal_conflict_policy():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
            "duplicate_signal_policy": "skip",
            "counter_signal_policy": "close_and_flip",
        },
        status=200,
    )

    resolved = resolve(_signal())

    assert resolved.duplicate_signal_policy == "skip"
    assert resolved.counter_signal_policy == "close_and_flip"


@responses.activate
def test_resolve_rejects_non_live_strategy():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "draft",
            "horizon": "intraday",
            "instrument_type": "spot",
        },
        status=200,
    )

    with pytest.raises(ResolutionError, match="not live"):
        resolve(_signal())


@responses.activate
def test_resolve_allows_manual_signal_for_non_live_strategy():
    # source="manual" (the frontend's "Send test signal"/Manual tab) is
    # exempt from the live-status check specifically so a strategy can be
    # exercised end-to-end before being promoted to live.
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "draft",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
        },
        status=200,
    )

    resolved = resolve(_signal(source="manual"))

    assert resolved.horizon == "intraday"


@responses.activate
def test_resolve_rejects_unknown_strategy():
    responses.add(responses.GET, _strategy_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="not found"):
        resolve(_signal())


# --- active_from_time/active_to_time (per-strategy signal-acceptance window) -----------------


@responses.activate
def test_resolve_rejects_signal_outside_active_window():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
            "active_from_time": "09:15:00",
            "active_to_time": "11:00:00",
        },
        status=200,
    )
    # 03:00 UTC = 08:30 IST - before the window opens.
    signal = _signal(timestamp=datetime(2026, 8, 12, 3, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="outside strategy's active window"):
        resolve(signal)


@responses.activate
def test_resolve_accepts_signal_inside_active_window():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
            "active_from_time": "09:15:00",
            "active_to_time": "11:00:00",
        },
        status=200,
    )
    # 05:00 UTC = 10:30 IST - inside the window.
    signal = _signal(timestamp=datetime(2026, 8, 12, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal)

    assert resolved.horizon == "intraday"


@responses.activate
def test_resolve_ignores_unset_active_window():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
        },
        status=200,
    )
    # No window configured - any timestamp resolves, backward compatible.
    signal = _signal(timestamp=datetime(2026, 8, 12, 0, 0, tzinfo=timezone.utc))

    resolved = resolve(signal)

    assert resolved.horizon == "intraday"



@responses.activate
def test_resolve_rejects_when_signal_generation_unreachable():
    responses.add(responses.GET, _strategy_url(), body=requests.exceptions.ConnectionError("refused"))

    with pytest.raises(ResolutionError, match="could not reach"):
        resolve(_signal())


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
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

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
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="SELL"))

    assert resolved.strategy["type"] == "bear_put_spread"
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_for_mcx_uses_resolved_futures_contract():
    # MCX has no separate spot instrument - the option chain must be looked
    # up against the active-month futures contract symbol (chart_symbol),
    # never the bare underlying name ("GOLDM") the signal itself carries.
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(segment="MCX"), status=200)
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

    resolved = resolve(_signal(symbol="GOLDM", exchange="MCX", action="BUY"))

    assert resolved.strategy["type"] == "bull_call_spread"
    # calls[0] = strategy fetch, [1] = resolve_underlying, [2] = expiries, [3] = chain
    assert responses.calls[2].request.params["symbol"] == "GOLDM-04Sep2026-FUT"
    assert responses.calls[2].request.params["exchange"] == "MCX"
    assert responses.calls[3].request.params["symbol"] == "GOLDM-04Sep2026-FUT"


@responses.activate
def test_resolve_option_strategy_for_crypto_uses_delta_chain():
    # CRYPTO has no separate spot either (like MCX) - chart_symbol ==
    # trade_symbol == the perpetual itself ("BTCUSD"), and Delta's own
    # security_id is a stringified product_id, not Dhan's - same generic
    # code path, just proving it actually works for the third exchange.
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(segment="CRYPTO"), status=200)
    responses.add(
        responses.GET,
        _resolve_url(),
        json=_resolved_underlying_json(
            chart_symbol="BTCUSD",
            chart_exchange="CRYPTO",
            trade_symbol="BTCUSD",
            trade_exchange="CRYPTO",
            lot_size=1,
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

    resolved = resolve(_signal(symbol="BTCUSD", exchange="CRYPTO", action="BUY"))

    assert resolved.instrument_type == "option"
    assert resolved.strategy == {
        "type": "bull_call_spread",
        "legs": [
            {"action": "BUY", "option_type": "CE", "strike": 63500.0, "expiry": "2026-08-15", "security_id": "139823"},
            {"action": "SELL", "option_type": "CE", "strike": 64000.0, "expiry": "2026-08-15", "security_id": "139845"},
        ],
    }
    # calls[0] = strategy fetch, [1] = resolve_underlying, [2] = expiries, [3] = chain
    assert responses.calls[1].request.params["segment"] == "CRYPTO"
    assert responses.calls[2].request.params["symbol"] == "BTCUSD"
    assert responses.calls[2].request.params["exchange"] == "CRYPTO"


@responses.activate
def test_resolve_option_strategy_for_crypto_sell_signal_uses_bear_put_spread():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(segment="CRYPTO"), status=200)
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

    resolved = resolve(_signal(symbol="BTCUSD", exchange="CRYPTO", action="SELL"))

    assert resolved.strategy["type"] == "bear_put_spread"
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_naked_call_for_buy_signal():
    # option_position_style='naked' -> single BUY leg, no short leg -
    # signal-processing has no exchange-specific logic either way, so an
    # NSE fixture is enough to exercise the branch (see
    # test_resolve_option_strategy_for_crypto_uses_delta_chain above for
    # the exchange-agnostic confirmation).
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(option_position_style="naked"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.strategy == {
        "type": "naked_call",
        "legs": [
            {"action": "BUY", "option_type": "CE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "ce-24000"},
        ],
    }


@responses.activate
def test_resolve_option_strategy_naked_put_for_sell_signal():
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(option_position_style="naked"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="SELL"))

    assert resolved.strategy["type"] == "naked_put"
    assert len(resolved.strategy["legs"]) == 1
    assert resolved.strategy["legs"][0]["option_type"] == "PE"


@responses.activate
def test_resolve_option_strategy_defaults_to_spread_when_style_unset():
    # Backward compatibility: a strategy fetched before option_position_style
    # existed (or one that never set it) has no such key in the JSON at
    # all - resolve() must default to 'spread', not crash/None.
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_passes_through_non_atm_moneyness():
    # option_strike_moneyness threads all the way from the fetched
    # Strategy dict through pipeline.py -> choose_strategy -> the
    # template - confirmed here by the primary leg landing on 24100
    # (OTM1, one strike above ATM=24000), not the literal ATM strike.
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(option_strike_moneyness="OTM1"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.strategy["legs"][0]["strike"] == 24100.0


@responses.activate
def test_resolve_option_strategy_defaults_sl_scope_to_combined():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.option_sl_scope == "combined"


@responses.activate
def test_resolve_option_strategy_passes_through_individual_sl_scope():
    # option_sl_scope only affects how execution monitors an already-
    # resolved group, not which legs get built - confirmed here by the
    # legs staying exactly the same shape (bull_call_spread, ATM/OTM2
    # strikes from _FAKE_CHAIN) regardless of the sl_scope value.
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(option_sl_scope="individual"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.option_sl_scope == "individual"
    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_defaults_fixed_lots_to_none():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.option_fixed_lots is None


@responses.activate
def test_resolve_option_strategy_passes_through_fixed_lots():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(option_fixed_lots=5), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)

    resolved = resolve(_signal(symbol="NIFTY", action="BUY"))

    assert resolved.option_fixed_lots == 5


@responses.activate
def test_resolve_spot_strategy_fixed_lots_always_none():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
            "option_fixed_lots": 5,  # present on the strategy dict but irrelevant - instrument_type='spot'
        },
        status=200,
    )

    resolved = resolve(_signal())

    assert resolved.option_fixed_lots is None


@responses.activate
def test_resolve_option_strategy_resolves_when_today_is_expiry_day():
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(contract_day_filter="expiry"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    responses.add(responses.GET, _chain_url(), json=_FAKE_CHAIN, status=200)
    # intraday always picks the nearest expiry (2026-08-14) - today matches it.
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 14, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal)

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_rejects_when_today_is_not_expiry_day():
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(contract_day_filter="expiry"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 13, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="contract_day_filter='expiry'"):
        resolve(signal)


@responses.activate
def test_resolve_option_strategy_resolves_when_today_is_start_day():
    # positional + only "2026-08-14" qualifying (< 7 days out from
    # 2026-08-15) falls back to it anyway (choose_expiry's
    # "no qualifying expiry -> furthest available" rule) - but with a
    # second, later expiry present, MIN_POSITIONAL_DAYS_TO_EXPIRY=7 pushes
    # the pick to "2026-08-21" (idx=1), whose previous list entry is
    # "2026-08-14" - so the contract "started" the day after, 2026-08-15.
    responses.add(
        responses.GET,
        _strategy_url(),
        json=_option_strategy_json(horizon="positional", contract_day_filter="start"),
        status=200,
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    responses.add(responses.GET, _chain_url(), json={**_FAKE_CHAIN, "expiry": "2026-08-21"}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    resolved = resolve(signal)

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_strategy_rejects_when_today_is_not_start_day():
    responses.add(
        responses.GET,
        _strategy_url(),
        json=_option_strategy_json(horizon="positional", contract_day_filter="start"),
        status=200,
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14", "2026-08-21"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 16, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="contract_day_filter='start'"):
        resolve(signal)


@responses.activate
def test_resolve_option_strategy_rejects_start_when_no_earlier_expiry_known():
    # Only one live expiry - the chosen one is always idx 0, so there's no
    # "previous" entry in the list to compute day-after from.
    responses.add(
        responses.GET, _strategy_url(), json=_option_strategy_json(contract_day_filter="start"), status=200
    )
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"expiries": ["2026-08-14"]}, status=200)
    signal = _signal(symbol="NIFTY", action="BUY", timestamp=datetime(2026, 8, 15, 5, 0, tzinfo=timezone.utc))

    with pytest.raises(ResolutionError, match="no earlier expiry known"):
        resolve(signal)


@responses.activate
def test_resolve_option_strategy_crypto_bypasses_day_filter():
    responses.add(
        responses.GET,
        _strategy_url(),
        json=_option_strategy_json(segment="CRYPTO", contract_day_filter="expiry"),
        status=200,
    )
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

    resolved = resolve(signal)

    assert resolved.strategy["type"] == "bull_call_spread"


@responses.activate
def test_resolve_option_rejects_when_market_data_unreachable():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), body=requests.exceptions.ConnectionError("refused"))

    with pytest.raises(ResolutionError, match="could not resolve option expiries"):
        resolve(_signal(symbol="NIFTY"))


@responses.activate
def test_resolve_option_rejects_unresolvable_underlying():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="could not resolve underlying"):
        resolve(_signal(symbol="NOTREAL"))


@responses.activate
def test_resolve_option_rejects_unresolvable_expiries():
    responses.add(responses.GET, _strategy_url(), json=_option_strategy_json(), status=200)
    responses.add(responses.GET, _resolve_url(), json=_resolved_underlying_json(), status=200)
    responses.add(responses.GET, _expiries_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="could not resolve option expiries"):
        resolve(_signal(symbol="NIFTY"))

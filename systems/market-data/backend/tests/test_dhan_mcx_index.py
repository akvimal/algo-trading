"""Tests for the multi-segment refactor - MCX commodity futures and NSE
index/index-futures support. Fixture rows are shaped exactly like a real
Dhan instrument-master CSV download (columns, segment/instrument-name
values, SEM_LOT_UNITS) - see docs/architecture.md Phase 3 for the
verification note; this is what that verification confirmed."""

import json
from datetime import date, datetime, timedelta

import responses

from app.config import settings
from app.providers.dhan import (
    CANDLE_URL,
    INSTRUMENT_MASTER_URL,
    LTP_URL,
    MCX_FUTCOM,
    NSE_EQ,
    NSE_FUTIDX,
    NSE_INDEX,
    DhanProvider,
    _parse_lot_size_overrides,
)

HEADER = (
    "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,"
    "SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,"
    "SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n"
)


def _mcx_csv(near_expiry: date, far_expiry: date) -> str:
    return HEADER + (
        f"MCX,M,563946,FUTCOM,0,GOLDM-{near_expiry:%d%b%Y}-FUT,1.0,GOLDM,{near_expiry:%Y-%m-%d} 23:30:00,0,XX,100.0,M,FUTCOM,2,GOLDM\n"
        f"MCX,M,569003,FUTCOM,0,GOLDM-{far_expiry:%d%b%Y}-FUT,1.0,GOLDM,{far_expiry:%Y-%m-%d} 23:30:00,0,XX,100.0,M,FUTCOM,2,GOLDM\n"
        f"MCX,M,560978,FUTCOM,0,CRUDEOILM-{near_expiry:%d%b%Y}-FUT,1.0,CRUDEOILM,{near_expiry:%Y-%m-%d} 23:30:00,0,XX,100.0,M,FUTCOM,2,CRUDEOILM\n"
        # a non-FUTCOM MCX row (option) must be filtered out
        "MCX,M,999999,OPTFUT,0,GOLDM-OPT,1.0,GOLDM OPT,2026-09-04 23:30:00,7000,CE,1.0,M,OPTFUT,2,GOLDM\n"
    )


def _nse_index_and_futidx_csv(near_expiry: date, far_expiry: date) -> str:
    # SM_SYMBOL_NAME (last column) is deliberately left BLANK on the
    # FUTIDX rows below - that's what Dhan's real instrument master
    # actually does for NSE index futures (confirmed via a live CSV
    # download), unlike MCX_FUTCOM rows where it's populated. Underlying
    # extraction must not depend on it - see _underlying_from_trading_symbol.
    return HEADER + (
        "NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,0001-01-01,,XX,0.0500,,INDEX,X,NIFTY\n"
        "NSE,I,25,INDEX,0,BANKNIFTY,1.0,Nifty Bank,0001-01-01,,XX,0.0500,,INDEX,X,BANKNIFTY\n"
        f"NSE,D,48704,FUTIDX,0,NIFTY-{near_expiry:%b%Y}-FUT,65.0,NIFTY FUT,{near_expiry:%Y-%m-%d} 14:30:00,-0.01,XX,10.0,M,FUT,,\n"
        f"NSE,D,48699,FUTIDX,0,BANKNIFTY-{near_expiry:%b%Y}-FUT,30.0,BANKNIFTY FUT,{near_expiry:%Y-%m-%d} 14:30:00,-0.01,XX,20.0,M,FUT,,\n"
        f"NSE,D,48705,FUTIDX,0,NIFTY-{far_expiry:%b%Y}-FUT,65.0,NIFTY FUT,{far_expiry:%Y-%m-%d} 14:30:00,-0.01,XX,10.0,M,FUT,,\n"
    )


def _expiries() -> tuple[date, date]:
    today = date.today()
    return today + timedelta(days=10), today + timedelta(days=40)


# --- sync_instruments: filtering + grouping ------------------------------------------------


@responses.activate
def test_sync_mcx_filters_to_futcom_and_groups_by_underlying():
    near, far = _expiries()
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=_mcx_csv(near, far), status=200)

    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    result = provider.sync_instruments()

    assert result["symbol_count"] == 3  # 2 GOLDM + 1 CRUDEOILM FUTCOM rows, OPTFUT excluded
    goldm_contracts = provider._underlying_to_contracts["GOLDM"]
    assert [c.expiry_date for c in goldm_contracts] == [near, far]  # sorted ascending
    # SEM_LOT_UNITS itself says 1 (see _mcx_csv) - confirmed wrong against a
    # real executed Dhan order (true multiplier 10), so MCX_LOT_SIZE_OVERRIDES
    # (default "GOLD:10,GOLDM:10,CRUDEOIL:10,CRUDEOILM:10") overrides it - see
    # _parse_lot_size_overrides/sync_instruments.
    assert provider._symbol_to_lot_size[f"GOLDM-{near:%d%b%Y}-FUT"] == 10
    assert provider._symbol_to_lot_size[f"CRUDEOILM-{near:%d%b%Y}-FUT"] == 10


@responses.activate
def test_sync_mcx_leaves_lot_size_alone_for_a_non_overridden_underlying():
    """The override is targeted by underlying, not a blanket MCX
    replacement - a commodity not listed in MCX_LOT_SIZE_OVERRIDES must
    still get Dhan's own (possibly correct, possibly not yet checked)
    SEM_LOT_UNITS value."""
    near, far = _expiries()
    csv_body = HEADER + (
        f"MCX,M,700111,FUTCOM,0,SILVERM-{near:%d%b%Y}-FUT,5.0,SILVERM,{near:%Y-%m-%d} 23:30:00,0,XX,100.0,M,FUTCOM,2,SILVERM\n"
    )
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=csv_body, status=200)

    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    provider.sync_instruments()

    assert provider._symbol_to_lot_size[f"SILVERM-{near:%d%b%Y}-FUT"] == 5


@responses.activate
def test_sync_nse_composite_covers_equity_index_and_index_futures():
    near, far = _expiries()
    csv_body = (
        _nse_index_and_futidx_csv(near, far)
        + "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
    )
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=csv_body, status=200)

    provider = DhanProvider([NSE_EQ, NSE_INDEX, NSE_FUTIDX], name="dhan-nse")
    result = provider.sync_instruments()

    assert "RELIANCE" in provider._symbol_to_security_id
    assert "NIFTY" in provider._symbol_to_security_id  # index spot
    assert "BANKNIFTY" in provider._symbol_to_security_id
    assert provider._symbol_to_lot_size["NIFTY"] == 1  # index spot, no lot concept
    assert result["symbol_count"] == len(provider._symbol_to_security_id)


# --- _parse_lot_size_overrides: env-var parsing ---------------------------------------------


def test_parse_lot_size_overrides_parses_default_value():
    assert _parse_lot_size_overrides("GOLD:10,GOLDM:10,CRUDEOIL:10,CRUDEOILM:10") == {
        "GOLD": 10,
        "GOLDM": 10,
        "CRUDEOIL": 10,
        "CRUDEOILM": 10,
    }


def test_parse_lot_size_overrides_skips_malformed_entries():
    assert _parse_lot_size_overrides("GOLDM:10, ,BADENTRY,CRUDEOILM:notanumber,SILVERM:5") == {
        "GOLDM": 10,
        "SILVERM": 5,
    }


def test_parse_lot_size_overrides_empty_string_yields_no_overrides():
    assert _parse_lot_size_overrides("") == {}


# --- resolve_active_contract: nearest unexpired --------------------------------------------


@responses.activate
def test_resolve_active_contract_picks_nearest_unexpired():
    near, far = _expiries()
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=_mcx_csv(near, far), status=200)

    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    provider.sync_instruments()

    contract = provider.resolve_active_contract("GOLDM")

    assert contract is not None
    assert contract.expiry_date == near
    assert contract.trading_symbol == f"GOLDM-{near:%d%b%Y}-FUT"


def test_resolve_active_contract_skips_expired_contracts():
    from app.providers.dhan import ContractInfo

    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    yesterday = date.today() - timedelta(days=1)
    tomorrow = date.today() + timedelta(days=1)
    provider._underlying_to_contracts = {
        "GOLDM": [
            ContractInfo(trading_symbol="GOLDM-EXPIRED-FUT", expiry_date=yesterday),
            ContractInfo(trading_symbol="GOLDM-ACTIVE-FUT", expiry_date=tomorrow),
        ]
    }

    contract = provider.resolve_active_contract("GOLDM")

    assert contract is not None
    assert contract.trading_symbol == "GOLDM-ACTIVE-FUT"


def test_resolve_active_contract_returns_none_for_unknown_underlying():
    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    provider._underlying_to_contracts = {}
    assert provider.resolve_active_contract("SILVERM") is None


# --- resolve_underlying: commodity (chart==trade) vs index (chart!=trade) ------------------


@responses.activate
def test_resolve_underlying_commodity_chart_equals_trade():
    near, far = _expiries()
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=_mcx_csv(near, far), status=200)

    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    resolved = provider.resolve_underlying("GOLDM")

    assert resolved is not None
    assert resolved.chart_symbol == resolved.trade_symbol == f"GOLDM-{near:%d%b%Y}-FUT"
    assert resolved.chart_exchange == resolved.trade_exchange == "MCX"
    assert resolved.lot_size == 10  # MCX_LOT_SIZE_OVERRIDES, not Dhan's own (wrong) SEM_LOT_UNITS=1
    assert resolved.expiry == near.isoformat()


@responses.activate
def test_resolve_underlying_index_charts_spot_trades_future():
    near, far = _expiries()
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=_nse_index_and_futidx_csv(near, far), status=200)

    provider = DhanProvider([NSE_INDEX, NSE_FUTIDX], name="dhan-nse")
    resolved = provider.resolve_underlying("NIFTY")

    assert resolved is not None
    assert resolved.chart_symbol == "NIFTY"  # the index spot
    assert resolved.trade_symbol == f"NIFTY-{near:%b%Y}-FUT"  # the active-month future
    assert resolved.chart_exchange == resolved.trade_exchange == "NSE"
    assert resolved.lot_size == 65


@responses.activate
def test_resolve_underlying_returns_none_when_unresolvable():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=HEADER, status=200)
    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    assert provider.resolve_underlying("NOPE") is None


@responses.activate
def test_resolve_underlying_equity_charts_and_trades_itself():
    # A plain NSE cash equity has no separate "underlying" concept at all
    # (no future to roll into, no index spot/derivative split) - the
    # symbol itself is both what's charted and what's traded. Needed for
    # a universe-scoped in-house strategy (e.g. every Nifty Bank
    # constituent) to actually resolve at all, not just NIFTY/BANKNIFTY/
    # GOLDM-style underlyings.
    csv_body = HEADER + "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=csv_body, status=200)

    provider = DhanProvider([NSE_EQ], name="dhan-nse")
    resolved = provider.resolve_underlying("RELIANCE")

    assert resolved is not None
    assert resolved.chart_symbol == resolved.trade_symbol == "RELIANCE"
    assert resolved.chart_exchange == resolved.trade_exchange == "NSE"
    assert resolved.lot_size == 1
    assert resolved.expiry is None


@responses.activate
def test_resolve_underlying_index_with_no_active_future_still_returns_none():
    # An index symbol with NO matching FUTIDX contract must not fall
    # through to the equity branch and silently "trade the index" -
    # index_symbol is set but contract is None, so this must stay
    # unresolvable, same as before the equity branch was added.
    csv_body = HEADER + "NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,0001-01-01,,XX,0.0500,,INDEX,X,NIFTY\n"
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=csv_body, status=200)

    provider = DhanProvider([NSE_INDEX], name="dhan-nse")  # no NSE_FUTIDX configured - no future can ever resolve
    assert provider.resolve_underlying("NIFTY") is None


# --- get_lot_size -----------------------------------------------------------------------


def test_get_lot_size_known_and_unknown_symbol():
    provider = DhanProvider([NSE_EQ], name="dhan-nse")
    provider._symbol_to_security_id = {"RELIANCE": "2885"}
    provider._symbol_to_lot_size = {"RELIANCE": 1}

    assert provider.get_lot_size("RELIANCE") == 1
    assert provider.get_lot_size("NOPE") is None


# --- get_ltp_batch across multiple Dhan segments in one call -------------------------------


@responses.activate
def test_get_ltp_batch_spans_multiple_segments_in_one_request(monkeypatch):
    from app.providers.dhan import ContractInfo

    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = DhanProvider([NSE_EQ, NSE_FUTIDX], name="dhan-nse")
    provider._symbol_to_security_id = {"RELIANCE": "2885", "NIFTY-Aug2026-FUT": "48704"}
    provider._symbol_to_config = {"RELIANCE": NSE_EQ, "NIFTY-Aug2026-FUT": NSE_FUTIDX}

    responses.add(
        responses.POST,
        LTP_URL,
        json={"data": {"NSE_EQ": {"2885": {"last_price": 2500.5}}, "NSE_FNO": {"48704": {"last_price": 24500.0}}}},
        status=200,
    )

    prices = provider.get_ltp_batch(["RELIANCE", "NIFTY-Aug2026-FUT"])

    assert prices == {"RELIANCE": 2500.5, "NIFTY-Aug2026-FUT": 24500.0}
    sent_body = json.loads(responses.calls[0].request.body)
    assert sent_body == {"NSE_EQ": [2885], "NSE_FNO": [48704]}


# --- get_candle_history: a real date range, multiple bars ----------------------------------


@responses.activate
def test_get_candle_history_returns_all_completed_bars_in_range(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = DhanProvider([NSE_EQ], name="dhan-nse")
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    base = int(datetime.now().timestamp()) - 3600
    timestamps = [base + i * 300 for i in range(5)]  # 5 completed 5-min bars, well in the past
    responses.add(
        responses.POST,
        CANDLE_URL,
        json={
            "open": [100.0 + i for i in range(5)],
            "high": [105.0 + i for i in range(5)],
            "low": [95.0 + i for i in range(5)],
            "close": [102.0 + i for i in range(5)],
            "timestamp": timestamps,
        },
        status=200,
    )

    today = date.today()
    candles = provider.get_candle_history("RELIANCE", "5min", today - timedelta(days=1), today)

    assert len(candles) == 5
    assert [c.close for c in candles] == [102.0, 103.0, 104.0, 105.0, 106.0]
    assert all(c.symbol == "RELIANCE" and c.exchange == "NSE" for c in candles)


def test_get_candle_history_unsupported_interval_raises():
    """"daily" isn't a native Dhan intraday granularity and isn't an
    "Nmin" shape either, so it can't be served by local aggregation -
    unlike "30min", which now works via _aggregate_candles."""
    provider = DhanProvider([NSE_EQ], name="dhan-nse")
    try:
        provider.get_candle_history("RELIANCE", "daily", date.today(), date.today())
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "unsupported candle interval" in str(exc)

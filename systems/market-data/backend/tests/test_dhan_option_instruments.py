"""Tests for the option SegmentConfigs (NSE_OPTIDX/NSE_OPTSTK/MCX_OPTFUT)
and resolve_symbol_by_security_id (Phase 4d of the options trading
module - see docs/architecture.md). Same fake-CSV-over-a-real-network-
call convention as test_dhan_provider.py."""

import responses

from app.providers.dhan import INSTRUMENT_MASTER_URL, MCX_OPTFUT, NSE_EQ, NSE_OPTIDX, NSE_OPTSTK, DhanProvider

_CSV_HEADER = (
    "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,"
    "SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,"
    "SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n"
)

FAKE_OPTION_CSV = _CSV_HEADER + (
    "NSE,D,824088,OPTSTK,0,RELIANCE-27Aug2026-1320-CE,500.0,RELIANCE OPT,2026-08-27,1320.0,CE,5.0,M,OPTSTK,,RELIANCE\n"
    "NSE,D,900123,OPTIDX,0,NIFTY-14Aug2026-24000-CE,75.0,NIFTY OPT,2026-08-14,24000.0,CE,0.05,W,OPTIDX,,NIFTY\n"
    "MCX,D,700456,OPTFUT,0,GOLDM-04Sep2026-72000-CE,100.0,GOLDM OPT,2026-09-04,72000.0,CE,1.0,M,OPTFUT,,GOLDM\n"
    # non-matching rows must be filtered out per-config
    "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
)


@responses.activate
def test_nse_optstk_config_syncs_only_optstk_rows():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([NSE_OPTSTK], name="dhan-nse")
    result = provider.sync_instruments()

    assert result["symbol_count"] == 1
    assert provider._symbol_to_security_id == {"RELIANCE-27Aug2026-1320-CE": "824088"}
    assert provider._symbol_to_lot_size == {"RELIANCE-27Aug2026-1320-CE": 500}
    assert provider._symbol_to_config["RELIANCE-27Aug2026-1320-CE"].ltp_segment_key == "NSE_FNO"


@responses.activate
def test_nse_optidx_config_syncs_only_optidx_rows():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([NSE_OPTIDX], name="dhan-nse")
    provider.sync_instruments()

    assert provider._symbol_to_security_id == {"NIFTY-14Aug2026-24000-CE": "900123"}
    assert provider._symbol_to_lot_size == {"NIFTY-14Aug2026-24000-CE": 75}


@responses.activate
def test_mcx_optfut_config_syncs_only_optfut_rows():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([MCX_OPTFUT], name="dhan-mcx")
    provider.sync_instruments()

    assert provider._symbol_to_security_id == {"GOLDM-04Sep2026-72000-CE": "700456"}
    assert provider._symbol_to_config["GOLDM-04Sep2026-72000-CE"].ltp_segment_key == "MCX_COMM"


@responses.activate
def test_resolve_symbol_by_security_id_resolves_known_id():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([NSE_OPTSTK, NSE_OPTIDX], name="dhan-nse")

    assert provider.resolve_symbol_by_security_id("824088") == "RELIANCE-27Aug2026-1320-CE"
    assert provider.resolve_symbol_by_security_id("900123") == "NIFTY-14Aug2026-24000-CE"


@responses.activate
def test_resolve_symbol_by_security_id_unknown_returns_none():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([NSE_OPTSTK], name="dhan-nse")

    assert provider.resolve_symbol_by_security_id("no-such-id") is None


@responses.activate
def test_resolve_symbol_by_security_id_works_for_non_option_rows_too():
    """The reverse dict is populated for every synced row, not just
    options - a generically useful byproduct of the same sync loop."""
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_OPTION_CSV, status=200)

    provider = DhanProvider([NSE_EQ], name="dhan-nse")

    assert provider.resolve_symbol_by_security_id("2885") == "RELIANCE"

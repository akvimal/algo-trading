import json

import responses

from app.adapters.quotes.client import get_ltp, get_ltp_batch
from app.config import settings


@responses.activate
def test_get_ltp_calls_market_data_and_parses_response():
    responses.add(
        responses.GET,
        f"{settings.market_data_base_url}/quotes/ltp",
        json={"exchange": "NSE", "symbol": "RELIANCE", "ltp": 2500.5, "provider": "dhan"},
        status=200,
    )

    price = get_ltp("NSE", "RELIANCE")

    assert price == 2500.5
    assert responses.calls[0].request.params == {"exchange": "NSE", "symbol": "RELIANCE"}


@responses.activate
def test_get_ltp_batch_calls_market_data_batch_endpoint_once():
    responses.add(
        responses.POST,
        f"{settings.market_data_base_url}/quotes/ltp/batch",
        json={"exchange": "NSE", "provider": "dhan", "prices": {"RELIANCE": 2500.5, "TCS": 3400.0}},
        status=200,
    )

    prices = get_ltp_batch("NSE", ["RELIANCE", "TCS"])

    assert prices == {"RELIANCE": 2500.5, "TCS": 3400.0}
    assert len(responses.calls) == 1
    assert json.loads(responses.calls[0].request.body) == {"exchange": "NSE", "symbols": ["RELIANCE", "TCS"]}


def test_get_ltp_batch_empty_symbols_skips_network_call():
    assert get_ltp_batch("NSE", []) == {}

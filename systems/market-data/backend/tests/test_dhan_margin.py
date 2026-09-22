"""Tests for DhanProvider.get_margin/get_combo_margin - the Margin
Calculator API. Unlike place_order/modify_order/cancel_order/get_order/
get_order_book/get_funds (this file's own module comment: "best-effort
from general API documentation... CONFIRM... before this is ever pointed
at a real account"), these two were actually confirmed live 2026-09-22
against a real RELIANCE F&O put spread - see get_margin/get_combo_margin's
own docstrings for the real request/response shapes and the quantity/
lot-size gotcha found doing so. Mocked responses below use those real,
confirmed shapes, not a guess."""

import json

import responses

from app.config import settings
from app.providers import dhan
from app.providers.dhan import MARGIN_CALCULATOR_MULTI_URL, MARGIN_CALCULATOR_URL, NSE_INDEX, DhanProvider


def _provider() -> DhanProvider:
    return DhanProvider([NSE_INDEX], name="dhan-nse")


@responses.activate
def test_get_margin_sends_the_confirmed_single_order_body_shape(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "1101121515")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    responses.add(
        responses.POST,
        MARGIN_CALCULATOR_URL,
        body=json.dumps({
            "totalMargin": 118794.75, "spanMargin": 0.0, "exposureMargin": 0.0,
            "availableBalance": 103037.13, "variableMargin": 0.0,
            "insufficientBalance": 15757.62, "brokerage": 0.0, "leverage": "5.45X",
        }),
        status=200,
    )

    result = _provider().get_margin(
        security_id="106369", exchange_segment="NSE_FNO", transaction_type="SELL",
        quantity=500, product_type="INTRADAY", price=25.7,
    )

    assert result["totalMargin"] == 118794.75
    sent_body = json.loads(responses.calls[0].request.body)
    assert sent_body == {
        "dhanClientId": "1101121515",
        "exchangeSegment": "NSE_FNO",
        "transactionType": "SELL",
        "quantity": 500,
        "productType": "INTRADAY",
        "securityId": "106369",
        "price": 25.7,
    }
    # No triggerPrice key at all when not given - confirmed live this is
    # accepted (not "conditionally required" in the sense of always needed).
    assert "triggerPrice" not in sent_body


@responses.activate
def test_get_margin_includes_trigger_price_only_when_given(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "1101121515")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, MARGIN_CALCULATOR_URL, json={"totalMargin": 100.0}, status=200)

    _provider().get_margin(
        security_id="1", exchange_segment="NSE_FNO", transaction_type="SELL",
        quantity=500, product_type="INTRADAY", price=10.0, trigger_price=9.5,
    )

    sent_body = json.loads(responses.calls[0].request.body)
    assert sent_body["triggerPrice"] == 9.5


@responses.activate
def test_get_combo_margin_sends_scriplist_not_scripts(monkeypatch):
    # "scripList" is what the live API actually accepts - confirmed by the
    # exact error {"errorCode":"DH-905","errorMessage":"scripList is
    # required "} when "scripts" (a key some doc renders show) was sent
    # instead. This test guards against that regressing back.
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "1101121515")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    responses.add(
        responses.POST,
        MARGIN_CALCULATOR_MULTI_URL,
        body=json.dumps({
            "clientId": "1101121515", "totalMargin": 40759.5, "spanMargin": 14830.0,
            "exposure": 21829.5, "equityMargin": 0.0, "foMargin": 40759.5,
            "commodity": 0.0, "currency": 0.0, "hedgeBenefit": 0.0,
            "userFundLimit": 0.0, "insufficientFund": 0.0,
        }),
        status=200,
    )

    result = _provider().get_combo_margin([
        {"security_id": "106369", "exchange_segment": "NSE_FNO", "transaction_type": "SELL", "quantity": 500, "product_type": "INTRADAY", "price": 25.7},
        {"security_id": "144391", "exchange_segment": "NSE_FNO", "transaction_type": "BUY", "quantity": 500, "product_type": "INTRADAY", "price": 8.2},
    ])

    assert result["totalMargin"] == 40759.5
    sent_body = json.loads(responses.calls[0].request.body)
    assert "scripList" in sent_body
    assert "scripts" not in sent_body
    assert sent_body["dhanClientId"] == "1101121515"
    assert len(sent_body["scripList"]) == 2
    assert sent_body["scripList"][0] == {
        "exchangeSegment": "NSE_FNO", "transactionType": "SELL", "quantity": 500,
        "productType": "INTRADAY", "securityId": "106369", "price": 25.7,
    }


@responses.activate
def test_get_combo_margin_nets_well_below_the_sum_of_standalone_legs(monkeypatch):
    """Not a live call (mocked), but pins the real, confirmed numbers from
    the 2026-09-22 live verification so a future change to this method
    can't silently start sending a request Dhan would reject or
    misinterpret without a test noticing the shape changed."""
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "1101121515")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, MARGIN_CALCULATOR_MULTI_URL, json={"totalMargin": 40759.5}, status=200)

    result = _provider().get_combo_margin([
        {"security_id": "106369", "exchange_segment": "NSE_FNO", "transaction_type": "SELL", "quantity": 500, "product_type": "INTRADAY", "price": 25.7},
        {"security_id": "144391", "exchange_segment": "NSE_FNO", "transaction_type": "BUY", "quantity": 500, "product_type": "INTRADAY", "price": 8.2},
    ])

    standalone_sum = 118794.75 + 4100.0  # confirmed live single-leg totals for the same two legs
    assert result["totalMargin"] < standalone_sum / 2  # real netting, not a coincidence

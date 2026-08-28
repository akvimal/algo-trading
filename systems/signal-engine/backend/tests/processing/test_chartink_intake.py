"""Tests for app/domain/intake/chartink.py's parse_chartink_alert - the
Python replacement for the n8n chartink-{buy,sell}-intake workflows'
"Normalize + fan-out" JS Code node (see docs/architecture.md). That JS
logic had zero test coverage before this; these are its first tests."""

from app.domain.processing.intake.chartink import parse_chartink_alert


def test_parse_chartink_alert_happy_path_multiple_symbols():
    body = {
        "stocks": "RELIANCE,TCS",
        "trigger_prices": "2500.00,3400.50",
        "triggered_at": "2:30 pm",
        "scan_name": "Bullish Breakout",
    }

    pairs = parse_chartink_alert(body)

    assert pairs == [("RELIANCE", 2500.0), ("TCS", 3400.5)]


def test_parse_chartink_alert_single_symbol():
    body = {"stocks": "INFY", "trigger_prices": "1500.25"}

    assert parse_chartink_alert(body) == [("INFY", 1500.25)]


def test_parse_chartink_alert_trims_whitespace():
    body = {"stocks": " RELIANCE , TCS ", "trigger_prices": " 2500.00 , 3400.50 "}

    assert parse_chartink_alert(body) == [("RELIANCE", 2500.0), ("TCS", 3400.5)]


def test_parse_chartink_alert_missing_price_at_index_is_none():
    # trigger_prices has fewer entries than stocks.
    body = {"stocks": "RELIANCE,TCS,INFY", "trigger_prices": "2500.00,3400.50"}

    assert parse_chartink_alert(body) == [("RELIANCE", 2500.0), ("TCS", 3400.5), ("INFY", None)]


def test_parse_chartink_alert_unparseable_price_is_none():
    body = {"stocks": "RELIANCE,TCS", "trigger_prices": "2500.00,not-a-number"}

    assert parse_chartink_alert(body) == [("RELIANCE", 2500.0), ("TCS", None)]


def test_parse_chartink_alert_drops_blank_symbols():
    body = {"stocks": "RELIANCE,,TCS", "trigger_prices": "2500.00,999,3400.50"}

    # blank symbol at index 1 is dropped entirely (not paired with 999) -
    # matches the JS Code node's `.filter(Boolean)` on stocks BEFORE
    # zipping against trigger_prices by (post-filter) index.
    assert parse_chartink_alert(body) == [("RELIANCE", 2500.0), ("TCS", 999.0)]


def test_parse_chartink_alert_empty_stocks_returns_empty_list():
    assert parse_chartink_alert({"stocks": "", "trigger_prices": ""}) == []


def test_parse_chartink_alert_missing_keys_returns_empty_list():
    assert parse_chartink_alert({}) == []

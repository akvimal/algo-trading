"""Tests for the Watchlist feature's pure-function pieces: shape validation
(app/domain/watchlist.py, app/domain/rule.py's validate_rule_watchlist_fields)
and the route layer's DB-backed existence check
(app/api/routes/rules.py's _check_watchlist_exists). Same "plain fakes, no
real Session/TestClient" convention as tests/test_strategy_rule_link.py -
there's no dedicated CRUD/HTTP route test layer in this backend; watchlist
CRUD route correctness (create/list/get/update/delete) is verified live
against the running dev stack instead, not here."""

import pytest
from fastapi import HTTPException

from app.api.routes.rules import _check_watchlist_exists
from app.domain.generation.rule import validate_rule_watchlist_fields
from app.domain.generation.watchlist import WatchlistCreate, WatchlistUpdate, validate_watchlist_symbols_field


# --- validate_watchlist_symbols_field / WatchlistCreate/Update shape validation ---------


def test_validate_watchlist_symbols_field_accepts_comma_separated_symbols():
    validate_watchlist_symbols_field("RELIANCE,TCS,INFY")  # must not raise


def test_validate_watchlist_symbols_field_rejects_empty_string():
    with pytest.raises(ValueError):
        validate_watchlist_symbols_field("")


def test_validate_watchlist_symbols_field_rejects_only_commas():
    with pytest.raises(ValueError):
        validate_watchlist_symbols_field(",,,")


def test_watchlist_create_strips_and_parses_via_model_validator():
    payload = WatchlistCreate(name="fundamentally-strong", symbols=" RELIANCE , TCS ,,INFY ")
    assert payload.symbols == " RELIANCE , TCS ,,INFY "  # stored raw, parsed on read - see parse_symbol_list


def test_watchlist_create_rejects_unparseable_symbols():
    with pytest.raises(Exception):
        WatchlistCreate(name="empty-list", symbols=",,,")


def test_watchlist_update_rejects_unparseable_symbols():
    with pytest.raises(Exception):
        WatchlistUpdate(symbols=" , ")


# --- validate_rule_watchlist_fields (app/domain/rule.py) -------------------------------


def test_validate_rule_watchlist_fields_accepts_named_watchlist():
    validate_rule_watchlist_fields("watchlist", "fundamentally-strong")  # must not raise


def test_validate_rule_watchlist_fields_rejects_blank_underlying():
    with pytest.raises(ValueError):
        validate_rule_watchlist_fields("watchlist", "")


def test_validate_rule_watchlist_fields_rejects_none_underlying():
    with pytest.raises(ValueError):
        validate_rule_watchlist_fields("watchlist", None)


def test_validate_rule_watchlist_fields_ignores_other_underlying_types():
    validate_rule_watchlist_fields("symbol", None)  # must not raise - not a watchlist rule


# --- _check_watchlist_exists (app/api/routes/rules.py) - DB-backed existence check ------


class FakeWatchlistQuery:
    def __init__(self, row):
        self._row = row

    def filter_by(self, **kwargs):
        return self

    def first(self):
        return self._row


class FakeDb:
    def __init__(self, row=None):
        self._row = row

    def query(self, model):
        return FakeWatchlistQuery(self._row)


def test_check_watchlist_exists_noop_for_non_watchlist_types():
    _check_watchlist_exists(FakeDb(row=None), "symbol", "RELIANCE")  # must not raise - db never consulted


def test_check_watchlist_exists_passes_when_watchlist_found():
    _check_watchlist_exists(FakeDb(row=object()), "watchlist", "fundamentally-strong")  # must not raise


def test_check_watchlist_exists_404s_when_watchlist_missing():
    with pytest.raises(HTTPException) as exc:
        _check_watchlist_exists(FakeDb(row=None), "watchlist", "does-not-exist")
    assert exc.value.status_code == 404

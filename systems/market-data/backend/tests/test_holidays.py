from datetime import date

import pytest

from app.domain import market_calendar as mc


@pytest.fixture(autouse=True)
def _fresh_cache():
    mc.invalidate_holidays()
    yield
    mc.invalidate_holidays()


def test_the_built_in_list_closes_nse_on_dussehra():
    assert mc.is_nse_closed(date(2026, 10, 20))
    assert not mc.is_nse_closed(date(2026, 10, 21))
    assert mc.is_nse_closed(date(2026, 10, 24))  # a Saturday


def test_the_list_must_cover_the_current_year_and_the_next_months():
    """The file is hand-maintained: when this fails, add the next holidays (or the web app's Holidays page) before the nightly OI snapshot starts
    recording closed days again."""
    from datetime import timedelta

    assert mc.coverage_through() >= date.today() + timedelta(days=30), "the holiday list is about to run out"


def test_an_admin_row_overrides_the_file_and_open_removes_a_holiday(monkeypatch):
    rows = [
        {"date": "2026-10-20", "name": "Dussehra", "nse": "open", "mcx": "closed", "detail": None},
        {"date": "2027-01-26", "name": "Republic Day", "nse": "closed", "mcx": "closed", "detail": None},
    ]
    monkeypatch.setattr(mc, "_load_holidays", lambda: (rows, date(2027, 12, 31)))
    assert not mc.is_nse_closed(date(2026, 10, 20))
    assert mc.is_nse_closed(date(2027, 1, 26))
    assert mc.coverage_through() == date(2027, 12, 31)

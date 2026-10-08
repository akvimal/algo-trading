from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.domain import market_calendar as mc
from app.domain.models import EconomicEvent
from app.main import app


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(mc.global_calendar, "get_events", lambda underlying: [])


def _events(segment, start, days=7, kind=None):
    cal = mc.upcoming(segment, today=start, days=days)
    return [e for e in cal.events if kind is None or e.kind == kind], cal


def test_nifty_weekly_expiry_is_tuesday_and_the_last_tuesday_is_the_monthly():
    ev, _ = _events("NSE", date(2026, 10, 21), days=10, kind="expiry")  # Wed 21 Oct .. Fri 30 Oct
    assert [(e.date, e.title.split(":")[0]) for e in ev] == [(date(2026, 10, 27), "Monthly F&O expiry")]
    assert ev[0].impact == "high"
    weekly, _ = _events("NSE", date(2026, 10, 12), days=3, kind="expiry")  # Mon 12 .. Wed 14 Oct
    assert [(e.date, e.title, e.impact) for e in weekly] == [(date(2026, 10, 13), "Nifty weekly options expiry", "medium")]


def test_an_expiry_on_an_exchange_holiday_moves_to_the_previous_trading_day():
    ev, _ = _events("NSE", date(2026, 10, 15), days=7, kind="expiry")  # Dussehra is Tuesday 20 Oct
    assert [e.date for e in ev] == [date(2026, 10, 19)]
    assert "Moved from Tuesday 20 Oct" in ev[0].detail


def test_the_monthly_expiry_also_moves_when_the_last_tuesday_is_a_holiday():
    ev, _ = _events("NSE", date(2026, 11, 20), days=7, kind="expiry")  # Guru Nanak Jayanti is Tuesday 24 Nov, the last Tuesday
    assert [(e.date, e.title.startswith("Monthly")) for e in ev] == [(date(2026, 11, 23), True)]


def test_rbi_decision_and_mospi_releases_with_a_weekend_release_moved_to_the_next_working_day():
    rbi, _ = _events("NSE", date(2026, 12, 1), days=5, kind="rbi")
    assert [(e.date, e.impact) for e in rbi] == [(date(2026, 12, 4), "high")] and "2-4 Dec" in rbi[0].detail
    data, _ = _events("NSE", date(2026, 11, 26), days=6, kind="data")  # IIP is scheduled Sat 28 Nov, GDP Mon 30 Nov
    assert [(e.date, e.title.split(" (")[0]) for e in data] == [(date(2026, 11, 30), "India GDP, Q2 FY2026-27"), (date(2026, 11, 30), "India industrial production")]  # same day: the bigger one first
    assert data[0].detail is None and "Scheduled for Sat 28 Nov" in data[1].detail
    cpi, _ = _events("NSE", date(2026, 10, 12), days=1, kind="data")
    assert [(e.title, e.impact, e.time) for e in cpi] == [("India CPI inflation", "high", None)]


def test_holidays_read_differently_for_nse_and_mcx():
    nse, _ = _events("NSE", date(2026, 10, 1), days=3, kind="holiday")
    mcx, _ = _events("MCX", date(2026, 10, 1), days=3, kind="holiday")
    assert [e.title for e in nse] == ["Mahatma Gandhi Jayanti: NSE closed"]
    assert [e.title for e in mcx] == ["Mahatma Gandhi Jayanti: MCX closed all day"]
    assert [e.title for e in _events("NSE", date(2026, 10, 20), days=1, kind="holiday")[0]] == ["Dussehra: NSE closed"]
    assert "morning session closed, evening session open" in _events("MCX", date(2026, 10, 20), days=1, kind="holiday")[0][0].title
    muhurat, _ = _events("NSE", date(2026, 11, 8), days=1, kind="holiday")
    assert muhurat[0].title.endswith("special trading session") and "timings" in muhurat[0].detail


def test_global_events_are_converted_to_ist_and_the_feeds_holiday_rows_are_dropped(monkeypatch):
    rows = [
        EconomicEvent(title="Unemployment Claims", currency="USD", timestamp="2026-10-08T08:30:00-04:00", impact="medium", forecast="230K", previous="225K"),
        EconomicEvent(title="Bank Holiday", currency="USD", timestamp="2026-10-09T00:00:00-04:00", impact="holiday"),
        EconomicEvent(title="Old", currency="USD", timestamp="2026-10-01T08:30:00-04:00", impact="high"),
    ]
    monkeypatch.setattr(mc.global_calendar, "get_events", lambda underlying: rows)
    ev, _ = _events("CRYPTO", date(2026, 10, 8), days=3, kind="global")
    assert [(e.date, e.time, e.title, e.forecast) for e in ev] == [(date(2026, 10, 8), "18:00", "USD: Unemployment Claims", "230K")]


def test_a_down_global_feed_is_named_in_the_notes_not_silently_empty(monkeypatch):
    def boom(underlying):
        raise RuntimeError("down")

    monkeypatch.setattr(mc.global_calendar, "get_events", boom)
    _, cal = _events("NSE", date(2026, 10, 12), days=2)
    assert any("temporarily unavailable" in n for n in cal.notes)
    assert [e.kind for e in cal.events] == ["data", "expiry"]  # the India layers still show


def test_the_global_feed_covering_one_week_is_flagged_for_a_longer_window():
    _, short = _events("NSE", date(2026, 10, 5), days=3)
    _, long = _events("NSE", date(2026, 10, 8), days=7)
    assert not any("current week only" in n for n in short.notes)
    assert any("current week only" in n for n in long.notes)


def test_mcx_says_its_expiries_are_missing_and_dates_past_the_files_end_are_flagged():
    _, mcx = _events("MCX", date(2026, 10, 8))
    assert any("MCX contract expiry dates are not included" in n for n in mcx.notes)
    _, late = _events("NSE", date(2027, 3, 30), days=5)
    assert any("only listed to 31 Mar 2027" in n for n in late.notes)


def test_crypto_shows_global_and_friday_btc_expiries_only(monkeypatch):
    class Delta:
        def get_expiry_list(self, symbol):
            return ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-16", "2026-10-23", "2026-10-30", "2026-11-27"]

    monkeypatch.setattr(mc, "get_provider", lambda exchange: Delta())
    ev, cal = _events("CRYPTO", date(2026, 10, 8), days=30)
    assert [(e.date, e.title, e.impact) for e in ev if e.kind == "expiry"] == [
        (date(2026, 10, 9), "BTC options weekly expiry", "low"),
        (date(2026, 10, 16), "BTC options weekly expiry", "low"),
        (date(2026, 10, 23), "BTC options weekly expiry", "low"),
        (date(2026, 10, 30), "BTC options monthly expiry", "medium"),
    ]
    assert not any(e.kind in ("rbi", "data", "holiday") for e in cal.events)


def test_events_sort_by_day_then_time_then_importance(monkeypatch):
    rows = [
        EconomicEvent(title="B", currency="USD", timestamp="2026-10-12T09:00:00-04:00", impact="medium"),
        EconomicEvent(title="A", currency="USD", timestamp="2026-10-12T08:00:00-04:00", impact="high"),
    ]
    monkeypatch.setattr(mc.global_calendar, "get_events", lambda underlying: rows)
    ev, _ = _events("NSE", date(2026, 10, 12), days=1)
    assert [e.title for e in ev] == ["India CPI inflation", "USD: A", "USD: B"]  # untimed rows lead their day, then by time


def test_unknown_segment_is_an_error():
    with pytest.raises(ValueError):
        mc.upcoming("FX")


def test_route_serves_the_merged_list_and_validates_input():
    client = TestClient(app)
    r = client.get("/calendar/upcoming?segment=nse&days=3")
    assert r.status_code == 200
    body = r.json()
    assert body["segment"] == "NSE" and isinstance(body["events"], list) and isinstance(body["notes"], list)
    assert client.get("/calendar/upcoming?segment=FX").status_code == 404
    assert client.get("/calendar/upcoming?segment=NSE&days=0").status_code == 422
    assert client.get("/calendar/upcoming?segment=NSE&days=15").status_code == 422

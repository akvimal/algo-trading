import pytest

from app.providers import calendar


def _row(title: str, country: str = "USD", impact: str = "High", date: str = "2026-09-15T08:30:00-04:00", **kw) -> dict:
    row = {"title": title, "country": country, "date": date, "impact": impact}
    row.update(kw)
    return row


def test_get_events_rejects_unsupported_underlying():
    with pytest.raises(ValueError):
        calendar.get_events("DOGEUSD")


def test_filters_by_currency_and_drops_low_impact(monkeypatch):
    rows = [
        _row("Fed Interest Rate Decision", country="USD", impact="High"),
        _row("ECB Press Conference", country="EUR", impact="High"),  # wrong currency
        _row("Ivey PMI", country="USD", impact="Low"),  # low impact - dropped
        _row("Bank Holiday", country="USD", impact="Holiday"),  # holiday - kept
    ]
    monkeypatch.setattr(calendar, "_fetch", lambda: rows)

    events = calendar.get_events("BTCUSD")

    assert [e.title for e in events] == ["Fed Interest Rate Decision", "Bank Holiday"]


def test_every_underlying_maps_to_a_currency():
    for underlying in calendar.SUPPORTED_UNDERLYINGS:
        assert calendar._CURRENCY_FOR_UNDERLYING[underlying]


def test_events_sorted_by_timestamp_ascending(monkeypatch):
    rows = [
        _row("CPI y/y", date="2026-09-17T08:30:00-04:00"),
        _row("Fed Rate Decision", date="2026-09-15T14:00:00-04:00"),
        _row("Core PPI m/m", date="2026-09-16T08:30:00-04:00"),
    ]
    monkeypatch.setattr(calendar, "_fetch", lambda: rows)

    events = calendar.get_events("ETHUSD")

    assert [e.title for e in events] == ["Fed Rate Decision", "Core PPI m/m", "CPI y/y"]


def test_optional_fields_default_to_none(monkeypatch):
    monkeypatch.setattr(calendar, "_fetch", lambda: [_row("NFP", forecast="", previous="187K")])

    event = calendar.get_events("BTCUSD")[0]

    assert event.forecast is None  # blank string from the feed -> None
    assert event.previous == "187K"
    assert event.actual is None


def test_cache_is_reused_within_ttl(monkeypatch):
    calls = []
    monkeypatch.setattr(calendar, "_fetch", lambda: calls.append(1) or [_row("Fed Rate Decision")])

    calendar.get_events("BTCUSD")
    calendar.get_events("ETHUSD")  # different underlying, same shared cache

    assert len(calls) == 1


def test_stale_cache_is_served_when_refresh_fails(monkeypatch):
    good_rows = [_row("Fed Rate Decision")]
    monkeypatch.setattr(calendar, "_fetch", lambda: good_rows)
    first = calendar.get_events("BTCUSD")
    assert first[0].title == "Fed Rate Decision"

    # Expire the cache, then make the next refresh fail - should fall back
    # to the stale copy instead of raising.
    rows, _fetched_at = calendar._cache
    calendar._cache = (rows, 0.0)

    def failing_fetch():
        raise RuntimeError("faireconomy.media is down")

    monkeypatch.setattr(calendar, "_fetch", failing_fetch)
    second = calendar.get_events("BTCUSD")
    assert second[0].title == "Fed Rate Decision"


def test_raises_when_nothing_cached_and_refresh_fails(monkeypatch):
    monkeypatch.setattr(calendar, "_fetch", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(RuntimeError):
        calendar.get_events("BTCUSD")

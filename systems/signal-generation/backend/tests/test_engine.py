from datetime import datetime, timezone

from app.domain.engine import history_window


def test_history_window_ends_today_and_covers_at_least_min_days():
    from_date, to_date = history_window(bar_count=10, interval="5min")

    assert to_date == datetime.now(timezone.utc).date()
    assert (to_date - from_date).days >= 3


def test_history_window_caps_at_max_days_for_large_bar_counts():
    from_date, to_date = history_window(bar_count=100000, interval="1min")
    assert (to_date - from_date).days <= 30

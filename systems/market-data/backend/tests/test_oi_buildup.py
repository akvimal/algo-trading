"""Tests for app/domain/oi_buildup.compute_eod_buildup - pure day-over-day
diffing/classification for the OI-buildup EOD screener (GET /oi-buildup),
with no Dhan/DB dependency. See app/scheduler.py's _record_oi_eod_snapshot
for the job that calls this against a real previous DB row."""

from app.domain.oi_buildup import PreviousSnapshot, compute_eod_buildup


def test_no_previous_snapshot_returns_all_none():
    result = compute_eod_buildup(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0, previous=None)

    assert result.call_oi_change_pct is None
    assert result.put_oi_change_pct is None
    assert result.price_change_pct is None
    assert result.call_buildup is None
    assert result.put_buildup is None


def test_long_buildup_when_oi_and_price_both_rise():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=110_000, total_put_oi=80_000, spot_price=1010.0, previous=previous)

    assert result.call_oi_change_pct == 10.0
    assert result.put_oi_change_pct == 0.0
    assert result.price_change_pct == 1.0
    assert result.call_buildup == "long_buildup"
    # put OI unchanged (0 diff) - _classify_buildup's "not oi_change" guard
    # treats a flat 0 the same as "nothing to classify yet".
    assert result.put_buildup is None


def test_short_buildup_when_oi_rises_and_price_falls():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=100_000, total_put_oi=90_000, spot_price=980.0, previous=previous)

    assert result.put_buildup == "short_buildup"


def test_short_covering_when_oi_falls_and_price_rises():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=90_000, total_put_oi=80_000, spot_price=1020.0, previous=previous)

    assert result.call_buildup == "short_covering"


def test_long_unwinding_when_oi_and_price_both_fall():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=90_000, total_put_oi=80_000, spot_price=980.0, previous=previous)

    assert result.call_buildup == "long_unwinding"


def test_zero_previous_oi_gives_none_pct_but_still_classifies():
    # A symbol with genuinely zero call OI yesterday - pct change is
    # undefined (division by zero), but the raw diff is still a perfectly
    # good non-zero number to classify against.
    previous = PreviousSnapshot(total_call_oi=0, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=5_000, total_put_oi=80_000, spot_price=1010.0, previous=previous)

    assert result.call_oi_change_pct is None
    assert result.call_buildup == "long_buildup"

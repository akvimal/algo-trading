"""Regression test for a real incident (2026-08-31, VPS): a signal for a
strategy with active_windows configured crashed resolution with
`TypeError: fromisoformat: argument must be str` - generation_lookup.py's
fetch_strategy used plain .model_dump() instead of .model_dump(mode="json"),
so StrategyOut.active_windows (typed as real datetime.time objects via
ActiveWindow.start/end) came back as time objects instead of the
"HH:MM:SS" strings pipeline.py's is_within_active_window expects (see
that function's own docstring: "straight from the Strategy's own JSON
response" - true before the 2026-08-28 signal-engine merge, when this was
a real HTTP call auto-JSON-serialized; silently no longer true once it
became an in-process .model_dump() call). Never caught by
test_resolution.py's own active_windows tests since those hand-build the
fetch_strategy dict directly with string times already, bypassing this
serialization step entirely.

Tests the actual Pydantic behavior generation_lookup.fetch_strategy relies
on directly (StrategyOut(...).model_dump(mode="json")) rather than faking
a full DB row - the one-line fix is exactly this serialization call, not
anything specific to the DB-fetch plumbing around it."""

from datetime import datetime, time, timezone

from app.domain.generation.models import ActiveWindow, StrategyOut


def _minimal_strategy_out(**overrides) -> StrategyOut:
    defaults = dict(
        id="11111111-1111-1111-1111-111111111111",
        name="Test Strategy",
        source_type="chartink",
        exchange="NSE",
        horizon="intraday",
        instrument_type="spot",
        segment="NSE",
        status="live",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return StrategyOut(**defaults)


def test_model_dump_json_serializes_active_windows_to_iso_time_strings():
    strategy = _minimal_strategy_out(active_windows=[ActiveWindow(start=time(9, 15), end=time(11, 0))])

    dumped = strategy.model_dump(mode="json")

    assert dumped["active_windows"] == [{"start": "09:15:00", "end": "11:00:00"}]
    # The actual contract pipeline.py's is_within_active_window relies on -
    # must be parseable back via time.fromisoformat, i.e. a str, not a
    # datetime.time object.
    for w in dumped["active_windows"]:
        assert isinstance(w["start"], str)
        assert time.fromisoformat(w["start"]) == time(9, 15)


def test_plain_model_dump_keeps_active_windows_as_time_objects_not_strings():
    """The bug this guards against, made explicit: plain .model_dump()
    (what generation_lookup.py used to call) does NOT serialize
    active_windows to strings - confirms mode="json" is load-bearing, not
    an arbitrary choice."""
    strategy = _minimal_strategy_out(active_windows=[ActiveWindow(start=time(9, 15), end=time(11, 0))])

    dumped = strategy.model_dump()

    assert isinstance(dumped["active_windows"][0]["start"], time)

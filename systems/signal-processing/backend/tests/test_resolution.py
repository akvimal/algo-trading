from datetime import datetime, timezone

import pytest
import requests
import responses

from app.config import settings
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.pipeline import resolve

STRATEGY_ID = "11111111-1111-1111-1111-111111111111"


def _signal(**overrides) -> SignalIngest:
    defaults = dict(
        strategy_id=STRATEGY_ID,
        symbol="RELIANCE",
        exchange="NSE",
        action="BUY",
        price=2500.0,
        timestamp=datetime.now(timezone.utc),
        source="chartink",
        source_meta={"scan_name": "Bullish Breakout"},
    )
    defaults.update(overrides)
    return SignalIngest(**defaults)


def _strategy_url() -> str:
    return f"{settings.signal_generation_base_url}/strategies/{STRATEGY_ID}"


@responses.activate
def test_resolve_uses_live_strategy_config():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "MCX",
        },
        status=200,
    )

    resolved = resolve(_signal())

    assert resolved.horizon == "intraday"
    assert resolved.instrument_type == "spot"
    assert resolved.segment == "MCX"  # passed through unchanged, for execution's account routing
    assert resolved.strategy is None  # spot -> no option-strategy legs
    # Not present in the fetched Strategy dict above - defaults apply, same
    # as trailing_stop_enabled's own missing-key default.
    assert resolved.duplicate_signal_policy == "add_position"
    assert resolved.counter_signal_policy == "skip"


@responses.activate
def test_resolve_passes_through_signal_conflict_policy():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "live",
            "horizon": "intraday",
            "instrument_type": "spot",
            "segment": "NSE",
            "duplicate_signal_policy": "skip",
            "counter_signal_policy": "close_and_flip",
        },
        status=200,
    )

    resolved = resolve(_signal())

    assert resolved.duplicate_signal_policy == "skip"
    assert resolved.counter_signal_policy == "close_and_flip"


@responses.activate
def test_resolve_rejects_non_live_strategy():
    responses.add(
        responses.GET,
        _strategy_url(),
        json={
            "id": STRATEGY_ID,
            "status": "draft",
            "horizon": "intraday",
            "instrument_type": "spot",
        },
        status=200,
    )

    with pytest.raises(ResolutionError, match="not live"):
        resolve(_signal())


@responses.activate
def test_resolve_rejects_unknown_strategy():
    responses.add(responses.GET, _strategy_url(), json={"detail": "not found"}, status=404)

    with pytest.raises(ResolutionError, match="not found"):
        resolve(_signal())


@responses.activate
def test_resolve_rejects_when_signal_generation_unreachable():
    responses.add(responses.GET, _strategy_url(), body=requests.exceptions.ConnectionError("refused"))

    with pytest.raises(ResolutionError, match="could not reach"):
        resolve(_signal())

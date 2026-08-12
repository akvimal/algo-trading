import pytest
import responses

from app.providers import nse_indices


@pytest.fixture(autouse=True)
def _reset_cache():
    """nse_indices keeps module-level global state (mirrors DhanProvider's
    own per-instance state) - clear it before each test so tests don't
    leak into each other."""
    nse_indices._cache.clear()
    yield
    nse_indices._cache.clear()


def _url(key: str) -> str:
    csv_name = nse_indices._INDEX_CSV_MAP[key]
    return f"{nse_indices.NSE_ARCHIVES_BASE_URL}/content/indices/{csv_name}"


_FAKE_NIFTYBANK_CSV = (
    "Company Name,Industry,Symbol,Series,ISIN Code\n"
    "HDFC Bank Ltd.,FINANCIAL SERVICES,HDFCBANK,EQ,INE040A01034\n"
    "ICICI Bank Ltd.,FINANCIAL SERVICES,ICICIBANK,EQ,INE090A01021\n"
)


@responses.activate
def test_sync_universes_populates_cache():
    for key in nse_indices._INDEX_CSV_MAP:
        body = _FAKE_NIFTYBANK_CSV if key == "NIFTYBANK" else "Company Name,Industry,Symbol,Series,ISIN Code\nX,Y,XSYM,EQ,Z\n"
        responses.add(responses.GET, _url(key), body=body, status=200)

    result = nse_indices.sync_universes()

    assert result == {"synced": len(nse_indices._INDEX_CSV_MAP), "total": len(nse_indices._INDEX_CSV_MAP)}
    assert nse_indices._cache["NIFTYBANK"] == ["HDFCBANK", "ICICIBANK"]


@responses.activate
def test_sync_universes_one_index_failing_does_not_block_others():
    for key in nse_indices._INDEX_CSV_MAP:
        if key == "NIFTYBANK":
            responses.add(responses.GET, _url(key), body=_FAKE_NIFTYBANK_CSV, status=200)
        elif key == "NIFTY50":
            responses.add(responses.GET, _url(key), status=500)
        else:
            responses.add(responses.GET, _url(key), body="Company Name,Industry,Symbol,Series,ISIN Code\nX,Y,XSYM,EQ,Z\n", status=200)

    result = nse_indices.sync_universes()

    assert result["synced"] == len(nse_indices._INDEX_CSV_MAP) - 1
    assert "NIFTYBANK" in nse_indices._cache
    assert "NIFTY50" not in nse_indices._cache


def test_list_universes_returns_full_known_set_even_before_any_sync():
    assert nse_indices._cache == {}
    universes = nse_indices.list_universes()
    assert universes == sorted(nse_indices._INDEX_CSV_MAP)


def test_get_constituents_unknown_key_returns_none():
    assert nse_indices.get_constituents("NOT_A_REAL_INDEX") is None


@responses.activate
def test_get_constituents_syncs_inline_if_cache_empty():
    for key in nse_indices._INDEX_CSV_MAP:
        body = _FAKE_NIFTYBANK_CSV if key == "NIFTYBANK" else "Company Name,Industry,Symbol,Series,ISIN Code\nX,Y,XSYM,EQ,Z\n"
        responses.add(responses.GET, _url(key), body=body, status=200)

    assert nse_indices._cache == {}
    constituents = nse_indices.get_constituents("niftybank")  # lowercase - normalized

    assert constituents == ["HDFCBANK", "ICICIBANK"]


@responses.activate
def test_get_constituents_uses_cache_without_resyncing_when_already_populated():
    nse_indices._cache["NIFTYBANK"] = ["ALREADY", "CACHED"]
    # No responses registered at all - a re-sync attempt would raise ConnectionError.
    assert nse_indices.get_constituents("NIFTYBANK") == ["ALREADY", "CACHED"]

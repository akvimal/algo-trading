"""The four-way price-against-OI reading (app/domain/oi_quadrants.py). The same cases file is run by the web Scan page's tests."""

import json
from pathlib import Path

import pytest

from app.domain import oi_quadrants as q

CASES = json.loads((Path(__file__).parent / "fixtures" / "oi_quadrant_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"][:60] for c in CASES])
def test_each_case_matches_the_shared_expectations(case):
    row = case["row"]
    got = q.total_oi_change_pct(row)
    if case["oi_change_pct"] is None:
        assert got is None
    else:
        assert got == pytest.approx(case["oi_change_pct"], abs=0.01)
    assert q.quadrant(row) == case["quadrant"]
    assert q.is_strong(row) is case["strong"]


def row(symbol, price, oi, call=None, put=None):
    """A stock whose TOTAL OI moved by `oi` percent: both sides move by it unless set."""
    return {"symbol": symbol, "total_call_oi": 1000, "total_put_oi": 1000, "price_change_pct": price,
            "call_oi_change_pct": oi if call is None else call, "put_oi_change_pct": oi if put is None else put,
            "call_buildup": "long_buildup" if price > 0 else "short_buildup", "put_buildup": "long_buildup" if price > 0 else "short_buildup"}


def test_stocks_are_ranked_by_the_size_of_their_oi_change_within_each_quadrant():
    rows = [row("A", 1.0, 12), row("B", 2.0, 40), row("C", 1.5, 25), row("D", -1.0, 30), row("E", 1.0, -20), row("F", -2.0, -8)]
    out = q.by_quadrant(rows, 5)
    assert [i["symbol"] for i in out["long_buildup"]["items"]] == ["B", "C", "A"]
    assert [i["symbol"] for i in out["short_buildup"]["items"]] == ["D"]
    assert [i["symbol"] for i in out["short_covering"]["items"]] == ["E"]
    assert [i["symbol"] for i in out["long_unwinding"]["items"]] == ["F"]


def test_only_the_top_n_are_listed_but_the_total_counts_them_all():
    rows = [row(f"S{i}", 1.0, 10 + i) for i in range(8)]
    out = q.by_quadrant(rows, 5)["long_buildup"]
    assert len(out["items"]) == 5 and out["total"] == 8 and out["items"][0]["symbol"] == "S7"


def test_all_four_quadrants_are_always_present_even_when_empty():
    out = q.by_quadrant([row("A", 1.0, 12)], 5)
    assert set(out) == set(q.QUADRANTS) and out["short_buildup"] == {"items": [], "total": 0}


def test_ties_break_on_the_price_move_then_the_symbol():
    rows = [row("ZED", 1.0, 20), row("ABC", 1.0, 20), row("MID", 3.0, 20)]
    assert [i["symbol"] for i in q.by_quadrant(rows, 5)["long_buildup"]["items"]] == ["MID", "ABC", "ZED"]


def test_the_strong_two_sided_star_survives_into_the_listing():
    items = q.by_quadrant([row("BIG", 1.0, 30), row("ONESIDE", 1.0, 30, call=60, put=0.0)], 5)["long_buildup"]["items"]
    assert {i["symbol"]: i["strong"] for i in items} == {"BIG": True, "ONESIDE": False}


def test_the_groups_and_labels_cover_the_same_four():
    assert set(q.BULLISH) | set(q.BEARISH) == set(q.QUADRANTS) == set(q.LABEL) == set(q.MEANING)

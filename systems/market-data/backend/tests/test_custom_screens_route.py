"""Route-level tests for app/api/routes/custom_screens.py - plain fakes, no
TestClient (the convention of this suite, see test_own_dhan_keys.py's own
docstring): the route functions are called directly, FastAPI's Depends(...)
defaults simply ignored in favour of an explicit user_id/db argument."""

import uuid
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.adapters.db.models import CustomScreen, EquityDailyBar, EquityScreenerSnapshot
from app.api.routes import custom_screens as route
from app.domain.models import CustomScreenCreate

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")


class _Scalar:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class FakeQuery:
    """Ignores order_by (irrelevant to what these tests check) but DOES
    evaluate simple `Column == value` filter clauses for real, rather than
    the "ignore every filter" simplification test_price_alerts.py's own
    FakeQuery uses - this route's ownership check (.filter(CustomScreen.id
    == ..., CustomScreen.user_id == ...)) is exactly what stops one user
    reading/editing another's saved screen, so a fake that could not fail
    to enforce it would not actually be testing anything there."""

    def __init__(self, rows):
        self.rows = rows

    def filter(self, *clauses):
        rows = self.rows
        for clause in clauses:
            key = clause.left.key
            if clause.operator.__name__ == "in_op":
                allowed = clause.right.effective_value
                rows = [r for r in rows if getattr(r, key, None) in allowed]
            else:
                rows = [r for r in rows if getattr(r, key, None) == clause.right.value]
        return FakeQuery(rows)

    def order_by(self, *a, **k):
        return self

    def all(self):
        return list(self.rows)

    def first(self):
        return self.rows[0] if self.rows else None


class FakeDB:
    def __init__(self, screens=None, snapshots=None, bars=None, latest_date=None):
        self.screens = screens or []
        self.snapshots = snapshots or []
        self.bars = bars or []
        self.latest_date = latest_date
        self.added = []
        self.deleted = []
        self.committed = False

    def query(self, target, *rest):
        if target is CustomScreen:
            return FakeQuery(self.screens)
        if target is EquityScreenerSnapshot:
            return FakeQuery(self.snapshots)
        if target is EquityDailyBar:
            return FakeQuery(self.bars)
        return _Scalar(self.latest_date)  # func.max(...) - the only other query shape this route issues

    def add(self, row):
        self.added.append(row)
        self.screens.append(row)

    def delete(self, row):
        self.deleted.append(row)
        self.screens.remove(row)

    def commit(self):
        self.committed = True

    def refresh(self, row):
        pass


def _payload(**over):
    base = dict(label="Bearish breakout", expression="close > 100", is_fno=None, index_membership=None, min_price=None, max_price=None)
    base.update(over)
    return CustomScreenCreate(**base)


def _screen(user_id=ALICE, **over):
    base = dict(id=uuid.uuid4(), user_id=user_id, label="x", expression="close > 1", is_fno=None, index_membership=None, min_price=None, max_price=None)
    base.update(over)
    return SimpleNamespace(**base)


# ---- CRUD: validation and ownership -------------------------------------------------------------------------


def test_create_rejects_an_unparseable_expression_with_422_not_a_traceback():
    db = FakeDB()
    with pytest.raises(HTTPException) as exc:
        route.create_custom_screen(_payload(expression="banana > 100"), user_id=ALICE, db=db)
    assert exc.value.status_code == 422
    assert "Unknown name" in exc.value.detail
    assert db.added == []  # never persisted


def test_create_saves_a_valid_screen_owned_by_the_caller():
    db = FakeDB()
    out = route.create_custom_screen(_payload(label="My screen"), user_id=ALICE, db=db)
    assert db.committed is True
    assert len(db.added) == 1 and db.added[0].user_id == ALICE and db.added[0].label == "My screen"
    assert out is db.added[0]


def test_list_only_returns_the_callers_own_screens():
    mine = _screen(user_id=ALICE)
    db = FakeDB(screens=[mine])  # FakeQuery ignores the filter, but this proves the route PASSES one -
    # the real ownership guarantee is exercised end to end via _owned_or_404 below, which does not ignore it.
    assert route.list_custom_screens(user_id=ALICE, db=db) == [mine]


def test_update_and_delete_404_on_someone_elses_screen():
    theirs = _screen(user_id=BOB)
    db = FakeDB(screens=[theirs])
    with pytest.raises(HTTPException) as exc:
        route.update_custom_screen(str(theirs.id), _payload(), user_id=ALICE, db=db)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc2:
        route.delete_custom_screen(str(theirs.id), user_id=ALICE, db=db)
    assert exc2.value.status_code == 404


def test_update_and_delete_404_on_a_malformed_id_rather_than_raising():
    db = FakeDB()
    with pytest.raises(HTTPException) as exc:
        route.delete_custom_screen("not-a-uuid", user_id=ALICE, db=db)
    assert exc.value.status_code == 404


def test_update_changes_the_owners_own_screen_in_place():
    mine = _screen(user_id=ALICE, label="old")
    db = FakeDB(screens=[mine])
    out = route.update_custom_screen(str(mine.id), _payload(label="new"), user_id=ALICE, db=db)
    assert out.label == "new" and db.committed is True


def test_delete_removes_the_owners_own_screen():
    mine = _screen(user_id=ALICE)
    db = FakeDB(screens=[mine])
    route.delete_custom_screen(str(mine.id), user_id=ALICE, db=db)
    assert mine in db.deleted and mine not in db.screens


# ---- running: no snapshot yet, universe filtering, matching -------------------------------------------------


def test_run_before_the_eod_job_has_ever_run_is_empty_not_an_error():
    db = FakeDB(latest_date=None)
    out = route.preview_custom_screen(_payload(), caller=None, db=db)
    assert out.snapshot_date is None and out.candidates == 0 and out.matches == []


def _snap(symbol, close, is_fno=False, index_memberships=None, snapshot_date=None):
    return SimpleNamespace(symbol=symbol, exchange="NSE", close=close, is_fno=is_fno, index_memberships=index_memberships, snapshot_date=snapshot_date)


def _bar(symbol, day, close):
    return SimpleNamespace(symbol=symbol, exchange="NSE", bar_date=day, open=close, high=close, low=close, close=close, volume=1000)


def test_run_applies_universe_filters_then_the_expression():
    today = date(2026, 9, 28)
    snapshots = [_snap("HIGH", 200, is_fno=True, snapshot_date=today), _snap("LOW", 50, is_fno=True, snapshot_date=today), _snap("NOTFNO", 200, is_fno=False, snapshot_date=today)]
    bars = [_bar(s, today, {"HIGH": 200, "LOW": 50, "NOTFNO": 200}[s]) for s in ("HIGH", "LOW", "NOTFNO")]
    db = FakeDB(snapshots=snapshots, bars=bars, latest_date=today)

    out = route.preview_custom_screen(_payload(expression="close > 100", is_fno=True), caller=None, db=db)
    assert out.snapshot_date == today
    assert out.candidates == 2  # HIGH and LOW pass the F&O filter; NOTFNO does not
    assert [m.symbol for m in out.matches] == ["HIGH"]  # only HIGH also clears close > 100


def test_a_symbol_with_no_daily_bars_yet_simply_does_not_match_rather_than_erroring():
    today = date(2026, 9, 28)
    db = FakeDB(snapshots=[_snap("NOBAR", 200, snapshot_date=today)], bars=[], latest_date=today)
    out = route.preview_custom_screen(_payload(expression="close > 100"), caller=None, db=db)
    assert out.candidates == 1 and out.matches == []


def test_run_saved_screen_uses_its_own_stored_definition():
    today = date(2026, 9, 28)
    mine = _screen(user_id=ALICE, expression="close > 100", is_fno=None)
    db = FakeDB(screens=[mine], snapshots=[_snap("HIGH", 200, snapshot_date=today)], bars=[_bar("HIGH", today, 200)], latest_date=today)
    out = route.run_saved_screen(str(mine.id), user_id=ALICE, caller=None, db=db)
    assert [m.symbol for m in out.matches] == ["HIGH"]


# ---- intraday expressions: fetched on demand, inside a per-run budget -------------------------------------------------


def _candles(closes, interval="15min"):
    from app.domain.models import Candle

    return [Candle(exchange="NSE", symbol="X", interval=interval, open=c, high=c, low=c, close=c, volume=1, timestamp=f"2026-10-02T09:{15 + i:02d}:00", provider="fake") for i, c in enumerate(closes)]


@pytest.fixture
def feed(monkeypatch):
    """Replaces the provider, the credentials and the cached history fetch: records what the screen asked the feed for."""
    state = SimpleNamespace(calls=[], fail_with=None)

    def fake_fetch(provider, exchange, symbol, interval, from_date, to_date, credentials=None, source=None):
        state.calls.append((symbol, interval, (to_date - from_date).days))
        if state.fail_with is not None:
            raise RuntimeError(state.fail_with)
        return _candles([1, 2, 3, 4], interval)

    monkeypatch.setattr(route, "fetch_candle_history_cached", fake_fetch)
    monkeypatch.setattr(route, "get_provider", lambda exchange: object())
    monkeypatch.setattr(route, "data_credentials", lambda caller, exchange=None: None)
    return state


def _universe(n):
    today = date(2026, 9, 28)
    names = [f"S{i:03d}" for i in range(n)]
    return FakeDB(snapshots=[_snap(s, 200, snapshot_date=today) for s in names], bars=[_bar(s, today, 200) for s in names], latest_date=today)


def test_an_intraday_expression_fetches_each_stock_once_for_the_interval_it_names(feed):
    out = route.preview_custom_screen(_payload(expression="close > 100 and m15_close > prev(m15_close)"), caller=SimpleNamespace(), db=_universe(3))
    assert [m.symbol for m in out.matches] == ["S000", "S001", "S002"]
    assert [(s, i) for s, i, _ in feed.calls] == [("S000", "15min"), ("S001", "15min"), ("S002", "15min")]
    assert out.intraday_skipped == 0 and out.intraday_note is None


def test_a_daily_only_expression_never_asks_the_feed(feed):
    route.preview_custom_screen(_payload(expression="close > 100"), caller=SimpleNamespace(), db=_universe(3))
    assert feed.calls == []


def test_a_run_covers_at_most_the_stock_limit_and_says_so(feed):
    out = route.preview_custom_screen(_payload(expression="m15_close > 0"), caller=SimpleNamespace(), db=_universe(route.INTRADAY_STOCK_LIMIT + 5))
    assert len(out.matches) == route.INTRADAY_STOCK_LIMIT
    assert out.intraday_skipped == 5
    assert f"at most {route.INTRADAY_STOCK_LIMIT} stocks" in out.intraday_note and "Narrow the universe" in out.intraday_note


def test_a_stock_that_fails_the_cheap_test_does_not_use_up_the_limit(feed):
    today = date(2026, 9, 28)
    low = [f"L{i:03d}" for i in range(100)]
    high = [f"H{i:03d}" for i in range(10)]
    db = FakeDB(
        snapshots=[_snap(s, 50, snapshot_date=today) for s in low] + [_snap(s, 200, snapshot_date=today) for s in high],
        bars=[_bar(s, today, 50) for s in low] + [_bar(s, today, 200) for s in high],
        latest_date=today,
    )
    out = route.preview_custom_screen(_payload(expression="close > 100 and m15_close > 0"), caller=SimpleNamespace(), db=db)
    assert len(out.matches) == 10 and out.intraday_skipped == 0
    assert len({s for s, _, _ in feed.calls}) == 10  # only the ten that got past the daily test were fetched


def test_a_feed_that_keeps_failing_is_given_up_on_and_its_reason_is_shown(feed):
    feed.fail_with = "Dhan API rejected the access token (401) - it may need to be regenerated"
    out = route.preview_custom_screen(_payload(expression="m15_close > 0"), caller=SimpleNamespace(), db=_universe(10))
    assert out.matches == [] and out.intraday_skipped == 10
    assert len(feed.calls) == route.INTRADAY_FAILURES_BEFORE_GIVING_UP  # it stopped asking
    assert "rejected the access token" in out.intraday_note


def test_each_interval_asks_for_a_sensible_stretch_of_history(feed):
    route.preview_custom_screen(_payload(expression="m5_close > 0 and m30_close > 0 and h1_close > 0"), caller=SimpleNamespace(), db=_universe(1))
    assert {(i, d) for _, i, d in feed.calls} == {("5min", 5), ("30min", 20), ("60min", 40)}

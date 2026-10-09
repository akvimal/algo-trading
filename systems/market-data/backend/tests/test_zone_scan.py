"""app/domain/zone_scan.py (the daily and weekly structure read and the tier) and the pieces of app/scheduler.py around it. Plain fakes, like the other
scheduler tests: the detectors are replaced with canned zones, so each test is about one rule of the shortlist, not about order-block detection (which
test_order_blocks.py covers)."""

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app import scheduler
from app.domain import zone_scan
from app.domain.models import Candle, OrderBlock
from app.domain.zone_scan import completed_weeks, oi_agrees, read_zones, tier_for


def _bars(n=130, last=date(2026, 10, 9), close=100.0):
    """n weekday bars ending on `last`, each 99-101 (so the ATR is about 2)."""
    days, d = [], last
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return [
        Candle(exchange="NSE", symbol="X", interval="daily", open=close, high=close + 1, low=close - 1, close=close, volume=1000.0, timestamp=f"{d.isoformat()}T00:00:00", provider="t")
        for d in reversed(days)
    ]


def _zone(kind, lo, hi, **over):
    proximal, distal = (hi, lo) if kind == "demand" else (lo, hi)
    return OrderBlock(kind=kind, proximal=proximal, distal=distal, origin_timestamp="2026-09-01T00:00:00", mitigated=False, **over)


@pytest.fixture
def detectors(monkeypatch):
    """Canned structure: `daily` and `weekly` zone lists and trends, chosen by the lookback each call passes."""
    state = SimpleNamespace(daily=[], weekly=[], d_trend="down", w_trend="range")
    monkeypatch.setattr(zone_scan, "structure_state", lambda candles, swing_lookback: (state.w_trend if swing_lookback == zone_scan.WEEKLY_SWING else state.d_trend, [], []))
    monkeypatch.setattr(zone_scan, "detect_order_blocks", lambda candles, lookback, trend, max_zones: state.weekly if lookback == zone_scan.WEEKLY_LOOKBACK else state.daily)
    return state


def test_too_little_history_is_no_read():
    assert read_zones(_bars(n=119)) is None


def test_price_inside_an_untested_zone_is_inside_with_no_distance(detectors):
    detectors.daily = [_zone("supply", 99.5, 102.0)]
    r = read_zones(_bars())
    assert (r.zone_kind, r.zone_position, r.zone_distance_pct, r.zone_distance_atr) == ("supply", "inside", 0.0, 0.0)


def test_a_zone_within_one_atr_on_its_near_side_is_approaching_and_further_is_not(detectors):
    detectors.daily = [_zone("supply", 101.5, 103.0)]  # 1.5 above a close of 100, ATR about 2
    r = read_zones(_bars())
    assert (r.zone_position, r.zone_distance_pct) == ("approaching", 1.5) and 0.7 < r.zone_distance_atr < 0.8
    detectors.daily = [_zone("supply", 103.5, 105.0)]  # 3.5 away: more than an ATR
    assert read_zones(_bars()).zone_kind is None
    detectors.daily = [_zone("demand", 96.0, 98.5)]  # demand just below: approaching from above
    assert read_zones(_bars()).zone_position == "approaching"
    detectors.daily = [_zone("demand", 101.5, 103.0)]  # a demand zone ABOVE price is not at price from the near side
    assert read_zones(_bars()).zone_kind is None


def test_tested_and_counter_trend_zones_are_ignored_and_the_nearest_wins(detectors):
    tested = _zone("supply", 99.5, 102.0).model_copy(update={"mitigated": True})
    against = _zone("demand", 99.0, 100.5, counter_trend=True)
    near, nearer = _zone("supply", 101.0, 103.0), _zone("supply", 100.2, 101.0)
    detectors.daily = [tested, against, near, nearer]
    r = read_zones(_bars())
    assert (r.zone_kind, r.zone_proximal) == ("supply", 100.2)
    detectors.daily = [tested, against]
    assert read_zones(_bars()).zone_kind is None


def test_the_weekly_read_marks_a_same_kind_weekly_zone_at_price_and_the_weekly_trend_on_the_zones_side(detectors):
    detectors.daily = [_zone("supply", 100.5, 102.0)]
    detectors.weekly, detectors.w_trend = [_zone("supply", 99.0, 104.0)], "down"
    r = read_zones(_bars())
    assert (r.weekly_zone, r.weekly_agrees, r.weekly_trend) == (True, True, "down")
    detectors.weekly, detectors.w_trend = [_zone("demand", 99.0, 104.0)], "range"  # the wrong kind, and no trend
    r = read_zones(_bars())
    assert (r.weekly_zone, r.weekly_agrees) == (False, False)
    detectors.weekly = [_zone("supply", 99.0, 104.0).model_copy(update={"mitigated": True})]  # a tested weekly zone does not count
    assert read_zones(_bars()).weekly_zone is False


def test_too_few_weekly_bars_leave_the_weekly_read_empty_not_range(detectors):
    detectors.daily = [_zone("supply", 100.5, 102.0)]
    r = read_zones(_bars(n=zone_scan.MIN_DAILY_BARS))  # about 24 weeks: enough
    assert r.weekly_trend is not None
    short = _bars(n=zone_scan.MIN_DAILY_BARS)[-70:]  # about 14 weeks, but under the daily floor too
    assert read_zones(short) is None


def test_the_week_still_forming_is_left_out_unless_the_last_bar_is_a_friday():
    thursday = _bars(n=30, last=date(2026, 10, 8))
    friday = _bars(n=30, last=date(2026, 10, 9))
    weeks_thu, weeks_fri = completed_weeks(thursday), completed_weeks(friday)
    assert weeks_thu[-1].timestamp[:10] < "2026-10-05"  # the Mon 5 Oct week is incomplete on Thursday 8 Oct
    assert weeks_fri[-1].timestamp[:10] == "2026-10-05"  # and complete once Friday has closed


@pytest.mark.parametrize(
    "kind,call,put,expected",
    [
        ("demand", "long_buildup", "short_covering", True),
        ("demand", "long_buildup", None, True),
        ("demand", "short_buildup", "short_buildup", False),
        ("demand", "long_buildup", "short_buildup", False),  # one label pointing the other way spoils it
        ("supply", "short_buildup", "long_unwinding", True),
        ("supply", "long_buildup", "long_buildup", False),
        ("supply", None, None, None),  # no read at all is unknown, not a disagreement
    ],
)
def test_oi_agreement_needs_the_same_direction_and_nothing_the_other_way(kind, call, put, expected):
    assert oi_agrees(kind, call, put) is expected


def test_tiers(detectors):
    detectors.daily = [_zone("supply", 100.5, 102.0)]
    detectors.weekly, detectors.w_trend = [_zone("supply", 99.0, 104.0)], "down"
    both = read_zones(_bars())
    assert tier_for(both, "short_buildup", "short_buildup") == ("A", True)  # weekly zone + OI
    assert tier_for(both, "long_buildup", "long_buildup") == ("C", False)  # OI against it: daily only
    assert tier_for(both, None, None) == ("C", None)  # OI unknown never promotes a stock
    detectors.weekly = []
    trend_only = read_zones(_bars())
    assert tier_for(trend_only, "short_buildup", None) == ("B", True)  # weekly trend on the zone's side + OI
    detectors.w_trend = "range"
    assert tier_for(read_zones(_bars()), "short_buildup", None) == ("C", True)
    detectors.daily = []
    assert tier_for(read_zones(_bars()), "short_buildup", None) == (None, None)  # no zone at price: no tier


# --- the screener job's fetch plan (incremental / backfill / Monday refresh) ---------------------------------------------------------------------

TODAY = date(2026, 10, 8)


def _dates(n, last=date(2026, 10, 7)):
    return [last - timedelta(days=n - 1 - i) for i in range(n)]


def test_a_stock_with_enough_recent_bars_fetches_only_the_new_days():
    incremental, start = scheduler._plan_daily_fetch(_dates(250), TODAY, TODAY - timedelta(days=380), False, False)
    assert incremental and start == date(2026, 10, 4)  # last stored bar minus the 3-day overlap


@pytest.mark.parametrize(
    "dates,full_refresh",
    [(_dates(150), False), (_dates(250, last=date(2026, 9, 20)), False), ([], False), (_dates(250), True)],  # thin / stale / none / Monday
)
def test_thin_stale_empty_and_monday_all_fetch_the_whole_window(dates, full_refresh):
    window = TODAY - timedelta(days=380)
    assert scheduler._plan_daily_fetch(dates, TODAY, window, False, full_refresh) == (False, window)


def test_an_fno_stock_with_only_a_year_stored_is_backfilled_to_three_years_then_goes_incremental():
    window = TODAY - timedelta(days=scheduler._RETENTION_DAYS_FNO)
    assert scheduler._plan_daily_fetch(_dates(257), TODAY, window, True, False) == (False, window)  # a year stored: backfill
    three_years = _dates(1100)  # (calendar days, roughly)
    assert scheduler._plan_daily_fetch(three_years, TODAY, window, True, False)[0] is True  # reaches back far enough
    assert scheduler._plan_daily_fetch(_dates(257), TODAY, TODAY - timedelta(days=380), False, False)[0] is True  # a non-F&O stock is unaffected


# --- the zone scan job -----------------------------------------------------------------------------------------------------------------------------

THURSDAY = datetime(2026, 10, 8, 17, 30, tzinfo=ZoneInfo("Asia/Kolkata"))
SATURDAY = datetime(2026, 10, 10, 17, 30, tzinfo=ZoneInfo("Asia/Kolkata"))


class FakeQ:
    def __init__(self, rows=None, scalar=None, first=None):
        self.rows, self._scalar, self._first = rows or [], scalar, first

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def scalar(self):
        return self._scalar

    def first(self):
        return self._first

    def __iter__(self):
        return iter(self.rows)


class FakeDb:
    """Answers the zone job's queries from canned data, keyed by what the query selects."""

    def __init__(self, symbols, bars, labels, newest, latest=date(2026, 10, 7)):
        self.symbols, self.bars, self.labels, self.newest, self.latest = symbols, bars, labels, newest, latest
        self.added, self.commits = [], 0

    def query(self, *args):
        head = str(args[0])
        if head.startswith("max(") and "snapshot_date" in head:
            return FakeQ(scalar=self.latest)
        if head.startswith("max(") and "bar_date" in head:
            return FakeQ(scalar=self.newest)
        if "EquityScreenerSnapshot.symbol" in head:
            return FakeQ(rows=[(s,) for s in self.symbols])
        if "OiEodSnapshot.symbol" in head:
            return FakeQ(rows=self.labels)
        if "EquityDailyBar" in head:
            return FakeQ(rows=self.bars)
        return FakeQ(first=None)  # the ZoneScan existence lookup

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _bar_rows(symbol, n=130, last=date(2026, 10, 8)):
    return [SimpleNamespace(symbol=symbol, exchange="NSE", bar_date=date.fromisoformat(c.timestamp[:10]), open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume) for c in _bars(n, last)]


def _freeze(monkeypatch, moment):
    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment

    monkeypatch.setattr(scheduler, "datetime", FakeDatetime)


def _run_job(monkeypatch, fake, moment=THURSDAY, detectors=None):
    _freeze(monkeypatch, moment)
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: fake)
    scheduler._record_zone_scan()


def test_the_job_writes_a_row_per_stock_with_tiers_from_todays_oi_labels(monkeypatch, detectors):
    detectors.daily = [_zone("supply", 100.5, 102.0)]
    detectors.weekly, detectors.w_trend = [_zone("supply", 99.0, 104.0)], "down"
    fake = FakeDb(["AAA", "BBB", "YOUNG"], _bar_rows("AAA") + _bar_rows("BBB") + _bar_rows("YOUNG", n=60), [("AAA", "short_buildup", "short_buildup"), ("BBB", "long_buildup", "long_buildup")], newest=date(2026, 10, 8))
    _run_job(monkeypatch, fake)
    rows = {r.symbol: r for r in fake.added}
    assert set(rows) == {"AAA", "BBB"}  # a young listing has too little history to read
    assert (rows["AAA"].tier, rows["AAA"].oi_agrees, rows["AAA"].zone_kind, rows["AAA"].weekly_zone) == ("A", True, "supply", True)
    assert (rows["BBB"].tier, rows["BBB"].oi_agrees) == ("C", False)
    assert rows["AAA"].snapshot_date == date(2026, 10, 8) and rows["AAA"].call_buildup == "short_buildup"


def test_the_job_skips_rather_than_writing_yesterdays_bars_under_todays_date(monkeypatch, detectors):
    fake = FakeDb(["AAA"], _bar_rows("AAA", last=date(2026, 10, 7)), [], newest=date(2026, 10, 7))
    _run_job(monkeypatch, fake)
    assert fake.added == []


def test_the_job_skips_weekends_and_a_missing_screener_snapshot(monkeypatch, detectors):
    fake = FakeDb(["AAA"], _bar_rows("AAA"), [], newest=date(2026, 10, 8))
    _run_job(monkeypatch, fake, moment=SATURDAY)
    assert fake.added == []
    fake = FakeDb(["AAA"], _bar_rows("AAA"), [], newest=date(2026, 10, 8), latest=None)
    _run_job(monkeypatch, fake)
    assert fake.added == []


def test_a_stock_with_no_zone_at_price_is_still_stored_for_its_trend_but_has_no_tier(monkeypatch, detectors):
    detectors.daily = []
    fake = FakeDb(["AAA"], _bar_rows("AAA"), [("AAA", "long_buildup", None)], newest=date(2026, 10, 8))
    _run_job(monkeypatch, fake)
    assert [(r.symbol, r.tier, r.zone_kind, r.daily_trend) for r in fake.added] == [("AAA", None, None, "down")]


# --- GET /zone-scan --------------------------------------------------------------------------------------------------------------------------------

def _scan_row(symbol, tier, atr, kind="supply", **over):
    base = dict(
        symbol=symbol, exchange="NSE", close=100.0, daily_trend="down", weekly_trend="down", tier=tier, zone_kind=kind, zone_position="approaching", zone_proximal=101.0,
        zone_distal=103.0, zone_distance_pct=1.0, zone_distance_atr=atr, weekly_zone=True, weekly_agrees=True, call_buildup="short_buildup", put_buildup="short_buildup", oi_agrees=True,
        snapshot_date=date(2026, 10, 8),
    )
    base.update(over)
    return SimpleNamespace(**base)


class _RouteQ:
    def __init__(self, rows, scalar=None):
        self.rows, self._scalar = rows, scalar

    def filter(self, *clauses):
        rows = self.rows
        for c in clauses:
            text = str(c)
            if "zone_scan.tier =" in text and "IS NOT NULL" not in text:
                rows = [r for r in rows if r.tier == c.right.value]
        return _RouteQ(rows, self._scalar)

    def all(self):
        return self.rows

    def scalar(self):
        return self._scalar


class _RouteDb:
    def __init__(self, rows, latest):
        self.rows, self.latest = rows, latest

    def query(self, arg):
        return _RouteQ([] if str(arg).startswith("max(") else self.rows, self.latest if str(arg).startswith("max(") else None)


def test_the_route_returns_the_latest_scans_shortlist_best_tier_then_nearest_first():
    from app.api.routes import zone_scan as route

    rows = [_scan_row("CCC", "C", 0.2), _scan_row("BBB", "B", 0.9), _scan_row("AAA", "A", 0.8), _scan_row("AA2", "A", 0.1, kind="demand")]
    out = route.get_zone_scan(day=None, tier=None, db=_RouteDb(rows, date(2026, 10, 8)))
    assert out.snapshot_date == date(2026, 10, 8)
    assert [r.symbol for r in out.rows] == ["AA2", "AAA", "BBB", "CCC"]
    assert out.rows[0].zone_kind == "demand" and out.rows[1].weekly_zone is True


def test_the_route_filters_one_tier_and_rejects_a_bad_one_and_is_empty_before_the_first_scan():
    from fastapi import HTTPException

    from app.api.routes import zone_scan as route

    rows = [_scan_row("AAA", "A", 0.8), _scan_row("CCC", "C", 0.2)]
    assert [r.symbol for r in route.get_zone_scan(day=None, tier="c", db=_RouteDb(rows, date(2026, 10, 8))).rows] == ["CCC"]
    with pytest.raises(HTTPException) as e:
        route.get_zone_scan(day=None, tier="Z", db=_RouteDb(rows, date(2026, 10, 8)))
    assert e.value.status_code == 422
    empty = route.get_zone_scan(day=None, tier=None, db=_RouteDb([], None))
    assert empty.snapshot_date is None and empty.rows == []

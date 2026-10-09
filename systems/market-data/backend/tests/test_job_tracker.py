"""The background-job run log (app/domain/job_tracker.py): what a run records, how it ends, how long ones report progress, and
that the jobs in app/scheduler.py actually use it. Plain fakes and the in-memory store, like the rest of this suite."""

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app import scheduler
from app.api.routes import jobs as jobs_route
from app.auth import require_admin
from app.domain import job_tracker
from app.domain.job_tracker import MemoryStore, derive_status, tracked


@pytest.fixture
def store(_job_tracker_in_memory):
    return _job_tracker_in_memory


# ---- how a run ends ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tally, forced, expected",
    [
        ({}, None, "succeeded"),
        ({"written": 10, "failed": 0, "unresolved": 3}, None, "succeeded"),  # skips that are normal do not spoil a run
        ({"written": 10, "failed": 2}, None, "partial"),
        ({"written": 0, "failed": 5}, None, "failed"),
        ({"written": 0, "failed": 0, "unresolved": 4}, None, "failed"),  # a batch that wrote nothing did not work
        ({"ok": 3, "failed": 0}, None, "succeeded"),
        ({"ok": 2, "failed": 1}, None, "partial"),
        ({"ok": 0, "failed": 2}, None, "failed"),
        ({"written": 9}, "skipped", "skipped"),  # the job's own say wins
        ({}, "failed", "failed"),
    ],
)
def test_the_status_is_read_off_the_tally_unless_the_job_said_otherwise(tally, forced, expected):
    assert derive_status(tally, forced) == expected


def test_a_run_is_open_while_the_job_runs_and_closed_when_it_returns(store):
    seen = {}

    @tracked("demo", "Demo job")
    def job():
        (open_run,) = store.of("demo")
        seen["status"] = open_run["status"]
        job_tracker.current().set_total(4)
        job_tracker.current().tick(4, {"ok": 4, "failed": 0})

    job()
    assert seen["status"] == "running"
    (run,) = store.of("demo")
    assert run["status"] == "succeeded" and run["finished_at"] is not None
    assert run["label"] == "Demo job" and run["total"] == 4 and run["done"] == 4 and run["tally"] == {"ok": 4, "failed": 0}


def test_a_job_that_raises_is_recorded_as_failed_and_still_raises(store):
    @tracked("boom", "Boom")
    def job():
        raise RuntimeError("Dhan 401")

    with pytest.raises(RuntimeError):
        job()
    (run,) = store.of("boom")
    assert run["status"] == "failed" and "RuntimeError: Dhan 401" in run["message"] and run["finished_at"] is not None


def test_a_job_can_skip_or_fail_on_its_own_account(store):
    @tracked("picky", "Picky")
    def job(how):
        getattr(job_tracker.current(), how)("because")

    job("skip")
    job("fail")
    assert [(r["status"], r["message"]) for r in store.of("picky")] == [("skipped", "because"), ("failed", "because")]


def test_a_skip_can_be_dropped_for_a_job_that_skips_all_night(store):
    @tracked("noisy", "Noisy", keep_skips=False)
    def job(skip):
        if skip:
            job_tracker.current().skip("closed")

    job(True)
    job(False)
    assert [r["status"] for r in store.of("noisy")] == ["succeeded"]


def test_progress_is_written_back_at_most_every_few_seconds_but_always_at_the_end(store, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(job_tracker.time, "monotonic", lambda: clock["t"])

    @tracked("long", "Long")
    def job():
        run = job_tracker.current()
        run.set_total(100)
        for i in range(100):
            clock["t"] += 0.1  # 100 steps over ten seconds
            run.tick(i, {"written": i})
            if i == 50:
                mid.append(dict(store.of("long")[0]))
        run.tick(100, {"written": 100})

    mid: list = []
    writes: list = []
    original = store.progress
    store.progress = lambda *a, **k: (writes.append(a[1]), original(*a, **k))[1]
    job()
    assert 0 < len(writes) < 15  # a handful of writes, not a hundred
    assert 0 < mid[0]["done"] <= 50  # in progress, visibly part-way
    assert store.of("long")[0]["done"] == 100 and store.of("long")[0]["status"] == "succeeded"


def test_old_runs_are_pruned_per_job_and_the_newest_kept(store):
    @tracked("many", "Many", keep=3)
    def job(n):
        job_tracker.current().note(str(n))

    for n in range(7):
        job(n)
    assert [r["message"] for r in store.of("many")] == ["4", "5", "6"]


def test_runs_a_restart_cut_off_are_closed_out_as_interrupted(store):
    run_id = store.start("oi", "OI")
    done_id = store.start("oi", "OI")
    store.finish(done_id, "succeeded", None, 1, 1, {})
    assert job_tracker.mark_interrupted_on_start() == 1
    assert store.runs[run_id]["status"] == "interrupted" and store.runs[run_id]["finished_at"] is not None
    assert "restarted" in store.runs[run_id]["message"]
    assert store.runs[done_id]["status"] == "succeeded"


def test_a_job_runs_untracked_when_there_is_no_store(monkeypatch):
    job_tracker.configure(None)
    ran = []

    @tracked("plain", "Plain")
    def job():
        job_tracker.current().tick(1, {"ok": 1})  # a no-op run, not an error
        ran.append(1)

    job()
    assert ran == [1]


def test_a_store_that_breaks_never_breaks_the_job(monkeypatch):
    class Broken(MemoryStore):
        def start(self, *a):
            raise RuntimeError("db down")

        def progress(self, *a):
            raise RuntimeError("db down")

        def finish(self, *a):
            raise RuntimeError("db down")

        def prune(self, *a):
            raise RuntimeError("db down")

    job_tracker.configure(Broken())
    ran = []

    @tracked("fragile", "Fragile")
    def job():
        job_tracker.current().set_total(3)
        job_tracker.current().tick(3, {"ok": 3})
        ran.append(1)
        return "result"

    assert job() == "result" and ran == [1]


# ---- the real jobs use it ---------------------------------------------------------------------------------------------


FRIDAY = datetime(2026, 9, 25, 15, 40, tzinfo=ZoneInfo("Asia/Kolkata"))
SATURDAY = datetime(2026, 9, 26, 15, 40, tzinfo=ZoneInfo("Asia/Kolkata"))


class _Db:
    def __getattr__(self, name):
        if name == "query":
            return lambda *a: SimpleNamespace(filter=lambda *a, **k: SimpleNamespace(order_by=lambda *a, **k: SimpleNamespace(first=lambda: None), first=lambda: None))
        return lambda *a, **k: None


class _Provider:
    def __init__(self, symbols, boom_on=()):
        self.symbols, self.boom_on = symbols, set(boom_on)

    def list_fno_stock_underlyings(self):
        return self.symbols

    def resolve_underlying(self, symbol):
        if symbol in self.boom_on:
            raise RuntimeError("Dhan 401")
        return SimpleNamespace(chart_symbol=symbol)

    def get_expiry_list(self, symbol):
        return ["2026-09-29"]

    def get_option_chain(self, symbol, expiry):
        return SimpleNamespace(strikes=[SimpleNamespace(ce=SimpleNamespace(oi=100), pe=SimpleNamespace(oi=150))], underlying_last_price=500.0)


def _freeze(monkeypatch, moment):
    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment

    monkeypatch.setattr(scheduler, "datetime", FakeDatetime)
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: _Db())
    monkeypatch.setattr(scheduler.time, "sleep", lambda _s: None)


def test_the_oi_snapshot_records_its_progress_and_tally(store, monkeypatch):
    _freeze(monkeypatch, FRIDAY)
    monkeypatch.setattr(scheduler, "get_provider", lambda name: _Provider(["TCS", "INFY", "SBIN"], boom_on={"INFY"}))
    scheduler._record_oi_eod_snapshot()
    (run,) = store.of("oi-eod-snapshot-record")
    assert run["label"] == "OI buildup snapshot" and run["total"] == 3 and run["done"] == 3
    assert run["tally"]["written"] == 2 and run["tally"]["failed"] == 1
    assert run["status"] == "partial"


def test_the_oi_snapshot_is_skipped_on_a_weekend_and_says_why(store, monkeypatch):
    _freeze(monkeypatch, SATURDAY)
    monkeypatch.setattr(scheduler, "get_provider", lambda name: _Provider(["TCS"]))
    scheduler._record_oi_eod_snapshot()
    (run,) = store.of("oi-eod-snapshot-record")
    assert run["status"] == "skipped" and run["message"] == "weekend"


def test_an_oi_snapshot_with_no_stocks_listed_is_a_failed_run_not_a_quiet_one(store, monkeypatch):
    _freeze(monkeypatch, FRIDAY)
    monkeypatch.setattr(scheduler, "get_provider", lambda name: _Provider([]))
    scheduler._record_oi_eod_snapshot()
    (run,) = store.of("oi-eod-snapshot-record")
    assert run["status"] == "failed" and "0 NSE F&O stocks" in run["message"]


def test_a_failed_token_renewal_is_a_failed_run(store, monkeypatch):
    def boom():
        raise RuntimeError("TOTP rejected")

    from app.providers import platform_dhan

    monkeypatch.setattr(platform_dhan, "renew_if_due", boom)
    scheduler._renew_dhan_token()
    (run,) = store.of("dhan-token-renew")
    assert run["status"] == "failed" and "TOTP rejected" in run["message"]


def test_a_renewal_that_could_not_be_saved_back_to_settings_is_flagged_on_the_run(store, monkeypatch):
    from app.config import settings
    from app.providers import platform_dhan

    monkeypatch.setattr(settings, "platform_dhan_from_accounts", True)
    monkeypatch.setattr(platform_dhan, "renew_if_due", lambda: {"renewed": True, "saved_back_to_settings": False})
    scheduler._renew_dhan_token()
    (run,) = store.of("dhan-token-renew")
    assert run["status"] != "failed" and "Settings copy is stale" in run["message"]


def test_a_clean_renewal_leaves_no_warning(store, monkeypatch):
    from app.config import settings
    from app.providers import platform_dhan

    monkeypatch.setattr(settings, "platform_dhan_from_accounts", True)
    monkeypatch.setattr(platform_dhan, "renew_if_due", lambda: {"renewed": True, "saved_back_to_settings": True})
    scheduler._renew_dhan_token()
    (run,) = store.of("dhan-token-renew")
    assert run["status"] == "succeeded" and not run.get("message")


def test_a_check_that_finds_nothing_due_leaves_no_row_in_the_job_log_but_a_deferral_is_logged(store, monkeypatch, caplog):
    import logging

    from app.providers import platform_dhan

    monkeypatch.setattr(platform_dhan, "renew_if_due", lambda: {"renewed": False, "reason": "the token is 3.0 hours old; it is renewed at 12"})
    scheduler._renew_dhan_token()
    assert store.of("dhan-token-renew") == []  # it runs every ten minutes: skipped runs are not kept
    monkeypatch.setattr(platform_dhan, "renew_if_due", lambda: {"renewed": False, "deferred": True, "reason": "a scan is running, so the renewal waits for it (9.0 hours left)"})
    with caplog.at_level(logging.INFO, logger="app.scheduler"):
        scheduler._renew_dhan_token()
    assert store.of("dhan-token-renew") == [] and "put off" in caplog.text and "a scan is running" in caplog.text


def test_the_instrument_sync_counts_each_provider(store, monkeypatch):
    class P:
        def __init__(self, name, ok):
            self.name, self.ok = name, ok

        def sync_instruments(self):
            if not self.ok:
                raise RuntimeError("down")

    monkeypatch.setattr(scheduler, "all_providers", lambda: [P("dhan-nse", True), P("dhan-mcx", False)])
    monkeypatch.setattr(scheduler.nse_indices, "sync_universes", lambda: None)
    scheduler._sync_all()
    (run,) = store.of("instrument-sync-daily")
    assert run["tally"] == {"ok": 2, "failed": 1} and run["total"] == 3 and run["status"] == "partial"


def test_the_catalog_lists_the_tracked_jobs_with_their_schedule():
    jobs = {j["job_id"]: j for j in scheduler.job_catalog()}
    assert {"oi-eod-snapshot-record", "equity-screener-snapshot-record", "instrument-sync-daily", "sentiment-history-record"} <= set(jobs)
    from app.config import settings

    assert jobs["oi-eod-snapshot-record"]["schedule"] == f"Weekdays {settings.oi_eod_snapshot_hour:02d}:{settings.oi_eod_snapshot_minute:02d}"
    assert "price-alert-check" not in jobs  # a run per few seconds would only bury the rest


# ---- the endpoint -----------------------------------------------------------------------------------------------------


def _row(job_id, status, started, finished=None, **kw):
    return SimpleNamespace(id=uuid.uuid4(), job_id=job_id, label=job_id, status=status, started_at=started, finished_at=finished, total=kw.get("total"), done=kw.get("done", 0), tally=kw.get("tally"), message=kw.get("message"))


class _Q:
    def __init__(self, rows):
        self.rows = rows
        self.job = None
        self.only_success = False
        self.n = None

    def filter(self, *clauses):
        for c in clauses:
            text = str(c)
            if "job_id" in text:
                self.job = c.right.value
            if "status" in text:
                self.only_success = True
        return self

    def order_by(self, *a):
        return self

    def limit(self, n):
        self.n = n
        return self

    def _rows(self):
        rows = sorted((r for r in self.rows if r.job_id == self.job), key=lambda r: r.started_at, reverse=True)
        return [r for r in rows if r.status == "succeeded"] if self.only_success else rows

    def all(self):
        return self._rows()[: self.n]

    def first(self):
        rows = self._rows()
        return rows[0] if rows else None


class _Session:
    def __init__(self, rows):
        self.rows = rows

    def query(self, *a):
        return _Q(self.rows)


def test_the_jobs_endpoint_separates_running_last_run_and_last_success():
    t0 = datetime(2026, 9, 25, 15, 0, tzinfo=timezone.utc)
    rows = [
        _row("oi-eod-snapshot-record", "succeeded", t0 - timedelta(days=2), t0 - timedelta(days=2) + timedelta(minutes=9), total=210, done=210, tally={"written": 210}),
        _row("oi-eod-snapshot-record", "failed", t0 - timedelta(days=1), t0 - timedelta(days=1) + timedelta(seconds=3), message="0 NSE F&O stocks listed"),
        _row("oi-eod-snapshot-record", "running", t0, None, total=210, done=60, tally={"written": 58, "failed": 2}),
    ]
    out = jobs_route.get_jobs(recent=8, db=_Session(rows), _admin=uuid.uuid4())
    oi = next(j for j in out.jobs if j.job_id == "oi-eod-snapshot-record")
    assert oi.running.status == "running" and oi.running.done == 60 and oi.running.total == 210 and oi.running.tally == {"written": 58, "failed": 2}
    assert oi.last_run.status == "failed" and oi.last_run.message == "0 NSE F&O stocks listed"  # the latest that has ENDED, not the open one
    assert oi.last_success.status == "succeeded" and oi.last_success.done == 210
    assert oi.last_success.duration_seconds == 9 * 60
    assert [r.status for r in oi.recent] == ["running", "failed", "succeeded"]
    # every catalogued job is present even with no runs yet
    other = next(j for j in out.jobs if j.job_id == "instrument-sync-daily")
    assert other.running is None and other.last_run is None and other.last_success is None and other.recent == []


def test_the_jobs_endpoint_is_admin_only():
    with pytest.raises(HTTPException) as e:
        require_admin(None)
    assert e.value.status_code == 401
    import jwt

    from app.config import settings

    token = jwt.encode({"sub": str(uuid.uuid4()), "is_admin": False}, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    with pytest.raises(HTTPException) as e:
        require_admin(SimpleNamespace(credentials=token))
    assert e.value.status_code == 403
    dependants = [d.call for d in jobs_route.router.routes[0].dependant.dependencies]
    assert require_admin in dependants


# ---- running a job by hand --------------------------------------------------------------------------------------------


def test_run_now_starts_a_listed_job_and_refuses_the_rest(store, monkeypatch):
    started = []
    monkeypatch.setattr(scheduler, "start_job_now", lambda job_id: started.append(job_id))
    assert jobs_route.run_job_now("oi-eod-snapshot-record", _admin=uuid.uuid4()) == {"started": "oi-eod-snapshot-record"}
    assert started == ["oi-eod-snapshot-record"]
    for job_id in ("session-summary-nse", "no-such-job"):  # jobs that message people are not offered
        with pytest.raises(HTTPException) as e:
            jobs_route.run_job_now(job_id, _admin=uuid.uuid4())
        assert e.value.status_code == 404
    assert started == ["oi-eod-snapshot-record"]


def test_run_now_refuses_a_job_already_running(store, monkeypatch):
    monkeypatch.setattr(scheduler, "start_job_now", lambda job_id: pytest.fail("must not start"))
    monkeypatch.setattr(job_tracker, "any_running", lambda ids: True)
    with pytest.raises(HTTPException) as e:
        jobs_route.run_job_now("zone-scan-record", _admin=uuid.uuid4())
    assert e.value.status_code == 409


def test_run_now_requires_an_admin():
    route = next(r for r in jobs_route.router.routes if getattr(r, "path", "") == "/jobs/{job_id}/run")
    assert require_admin in [d.call for d in route.dependant.dependencies]

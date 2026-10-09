"""The exit monitor is its own fast job (stop-loss/target checks every few seconds) and the P&L snapshots that used to ride on its tick are a
separate slower one, so recording them can never delay a stop firing."""

from types import SimpleNamespace

from app import scheduler
from app.config import settings


def test_the_stop_check_runs_every_few_seconds_and_snapshots_are_their_own_slower_job(monkeypatch):
    added = {}
    monkeypatch.setattr(scheduler._scheduler, "add_job", lambda fn, trigger, **kw: added.__setitem__(kw["id"], (fn, trigger, kw)))
    monkeypatch.setattr(scheduler._scheduler, "start", lambda: None)
    scheduler.start_scheduler()
    fn, trigger, kw = added["exit-monitor"]
    assert fn is scheduler.run_check_exits and trigger.interval.total_seconds() == settings.exit_monitor_poll_seconds <= 10
    assert kw["max_instances"] == 1 and kw["coalesce"] is True
    fn, trigger, _ = added["pnl-snapshots"]
    assert fn is scheduler.run_pnl_snapshots and trigger.interval.total_seconds() == settings.pnl_snapshot_poll_seconds
    assert settings.pnl_snapshot_poll_seconds > settings.exit_monitor_poll_seconds


def test_the_stop_check_does_no_snapshot_work_and_the_snapshot_job_does_nothing_else(monkeypatch):
    calls = []
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: SimpleNamespace(__enter__=lambda s: s, __exit__=lambda *a: None))

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(scheduler, "SessionLocal", Session)
    empty = {"closed_stop_loss": 0, "closed_target": 0, "closed_exit_condition": 0, "trailed": 0}
    monkeypatch.setattr(scheduler, "check_exits", lambda *a: (calls.append("exits"), empty)[1])
    monkeypatch.setattr(scheduler, "check_option_group_exits", lambda *a: (calls.append("option-exits"), empty)[1])
    monkeypatch.setattr(scheduler, "record_position_pnl_snapshots", lambda *a: calls.append("snap"))
    monkeypatch.setattr(scheduler, "record_option_group_pnl_snapshots", lambda *a: calls.append("option-snap"))
    scheduler.run_check_exits()
    assert calls == ["exits", "option-exits"]
    calls.clear()
    scheduler.run_pnl_snapshots()
    assert calls == ["snap", "option-snap"]

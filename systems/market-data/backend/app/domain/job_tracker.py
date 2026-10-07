"""A record of every background-job run, so "is it running, how far along, when did it last finish and how did it end" is
a read, not a hunt through `docker compose logs`.

A job opts in with `@tracked(job_id, label)`. The decorator opens a run when the job starts (status "running") and
closes it when the job returns or raises. Inside the job, `current()` is the live run: `set_total(n)` and `tick(done,
tally)` move the progress, `skip(reason)` / `fail(reason)` record a job that chose not to run or could not.

Recording is best effort and NEVER the job's problem: every store call is wrapped, so a database hiccup costs a missing
row, not a missed snapshot. Outside a tracked job `current()` is a no-op run, so the job functions still work when
called directly (tests, a manual re-run).

The store is pluggable: `DbStore` (market_data.job_runs) in the service, `MemoryStore` in tests.
"""

from __future__ import annotations

import contextvars
import functools
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol

logger = logging.getLogger(__name__)

# How often a long run's progress is written back (a 2,000-symbol job must not write 2,000 progress updates).
PROGRESS_FLUSH_SECONDS = 3.0
DEFAULT_KEEP_RUNS = 60

RUNNING, SUCCEEDED, PARTIAL, FAILED, SKIPPED, INTERRUPTED = "running", "succeeded", "partial", "failed", "skipped", "interrupted"


class JobStore(Protocol):
    def start(self, job_id: str, label: str) -> str: ...
    def progress(self, run_id: str, done: int, total: Optional[int], tally: dict[str, int]) -> None: ...
    def finish(self, run_id: str, status: str, message: Optional[str], done: int, total: Optional[int], tally: dict[str, int]) -> None: ...
    def discard(self, run_id: str) -> None: ...
    def interrupt_running(self) -> int: ...
    def prune(self, job_id: str, keep: int) -> None: ...
    def any_running(self, job_ids: list[str]) -> bool: ...


def derive_status(tally: dict[str, int], forced: Optional[str]) -> str:
    """How a run ended. A job that said so itself (skip/fail) wins; otherwise it is read off the tally: a
    batch that wrote nothing failed, one that wrote some but lost others is partial, anything else succeeded."""
    if forced:
        return forced
    if not tally:
        return SUCCEEDED
    good = tally.get("written", tally.get("ok", 0))
    bad = tally.get("failed", 0)
    if good == 0 and (bad > 0 or "written" in tally):
        return FAILED
    if bad > 0:
        return PARTIAL
    return SUCCEEDED


class NullRun:
    """What `current()` returns outside a tracked job: every call does nothing."""

    def set_total(self, total: int) -> None: ...
    def tick(self, done: int, tally: Optional[dict[str, int]] = None) -> None: ...
    def skip(self, reason: str) -> None: ...
    def fail(self, reason: str) -> None: ...
    def note(self, message: str) -> None: ...


@dataclass
class JobRun(NullRun):
    store: JobStore
    run_id: Optional[str]
    job_id: str
    keep_skips: bool = True
    total: Optional[int] = None
    done: int = 0
    tally: dict[str, int] = field(default_factory=dict)
    forced: Optional[str] = None
    message: Optional[str] = None
    _last_flush: float = field(default_factory=time.monotonic)

    def _safe(self, fn: Callable[[], Any]) -> None:
        if self.run_id is None:
            return
        try:
            fn()
        except Exception:
            logger.exception("job tracker: could not record progress for %s", self.job_id)

    def set_total(self, total: int) -> None:
        self.total = total
        self._flush(force=True)

    def tick(self, done: int, tally: Optional[dict[str, int]] = None) -> None:
        self.done = done
        if tally is not None:
            self.tally = dict(tally)
        self._flush(force=self.total is not None and done >= self.total)

    def skip(self, reason: str) -> None:
        self.forced, self.message = SKIPPED, reason

    def fail(self, reason: str) -> None:
        self.forced, self.message = FAILED, reason

    def note(self, message: str) -> None:
        self.message = message

    def _flush(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_flush < PROGRESS_FLUSH_SECONDS:
            return
        self._last_flush = now
        self._safe(lambda: self.store.progress(self.run_id, self.done, self.total, self.tally))  # type: ignore[arg-type]

    def close(self, error: Optional[BaseException] = None) -> None:
        if error is not None:
            status, message = FAILED, f"{type(error).__name__}: {error}"[:500]
        else:
            status, message = derive_status(self.tally, self.forced), self.message
            if status == FAILED and message is None and "written" in self.tally and self.tally["written"] == 0:
                message = "nothing was written"
        if status == SKIPPED and not self.keep_skips:
            self._safe(lambda: self.store.discard(self.run_id))  # type: ignore[arg-type]
            return
        self._safe(lambda: self.store.finish(self.run_id, status, message, self.done, self.total, self.tally))  # type: ignore[arg-type]


_store: Optional[JobStore] = None
_current: contextvars.ContextVar[Optional[JobRun]] = contextvars.ContextVar("job_run", default=None)
_NULL = NullRun()
_keep: dict[str, int] = {}
_lock = threading.Lock()


def configure(store: Optional[JobStore]) -> None:
    """Set where runs are recorded (None turns recording off). The service sets the DB store at startup; the test
    suite sets an in-memory one so nothing reaches a database."""
    global _store
    _store = store


def any_running(job_ids: list[str]) -> bool:
    """Is a run of any of these jobs in progress? False when nothing is recorded or it cannot be told (a caller that waits on this must never be
    stuck waiting on a broken log)."""
    if _store is None:
        return False
    try:
        return _store.any_running(job_ids)
    except Exception:
        logger.warning("could not tell whether %s are running", job_ids, exc_info=True)
        return False


def current() -> NullRun:
    return _current.get() or _NULL


def tracked(job_id: str, label: str, *, keep: int = DEFAULT_KEEP_RUNS, keep_skips: bool = True):
    """Record each call of the decorated job as a run. `keep` is how many runs of this job are kept; `keep_skips=False`
    drops a run the job itself skipped (the five-minute sentiment recorder skips every night, which would only be noise)."""

    def decorator(fn):
        _keep[job_id] = keep

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            store = _store
            run_id: Optional[str] = None
            if store is not None:
                try:
                    run_id = store.start(job_id, label)
                except Exception:
                    logger.exception("job tracker: could not open a run for %s", job_id)
            run = JobRun(store=store, run_id=run_id, job_id=job_id, keep_skips=keep_skips) if store is not None else None  # type: ignore[arg-type]
            token = _current.set(run)
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:
                if run is not None:
                    run.close(error=exc)
                raise
            else:
                if run is not None:
                    run.close()
                return result
            finally:
                _current.reset(token)
                if store is not None and run_id is not None:
                    try:
                        store.prune(job_id, keep)
                    except Exception:
                        logger.exception("job tracker: could not prune %s", job_id)

        return wrapper

    return decorator


def mark_interrupted_on_start() -> int:
    """Any run still 'running' when the service starts was cut off by the last stop; close those out so they do not
    look like jobs that are still going. Returns how many."""
    if _store is None:
        return 0
    try:
        return _store.interrupt_running()
    except Exception:
        logger.exception("job tracker: could not close out runs left running by the last stop")
        return 0


# ---- stores -----------------------------------------------------------------------------------------------------------


class MemoryStore:
    """In-memory, for tests."""

    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.order: list[str] = []

    def start(self, job_id: str, label: str) -> str:
        run_id = str(uuid.uuid4())
        self.runs[run_id] = {"id": run_id, "job_id": job_id, "label": label, "status": RUNNING, "started_at": datetime.now(timezone.utc), "finished_at": None, "total": None, "done": 0, "tally": {}, "message": None}
        self.order.append(run_id)
        return run_id

    def progress(self, run_id: str, done: int, total: Optional[int], tally: dict[str, int]) -> None:
        self.runs[run_id].update(done=done, total=total, tally=dict(tally))

    def finish(self, run_id: str, status: str, message: Optional[str], done: int, total: Optional[int], tally: dict[str, int]) -> None:
        self.runs[run_id].update(status=status, message=message, done=done, total=total, tally=dict(tally), finished_at=datetime.now(timezone.utc))

    def discard(self, run_id: str) -> None:
        self.runs.pop(run_id, None)
        self.order.remove(run_id)

    def any_running(self, job_ids: list[str]) -> bool:
        return any(r["status"] == RUNNING and r["job_id"] in job_ids for r in self.runs.values())

    def interrupt_running(self) -> int:
        n = 0
        for r in self.runs.values():
            if r["status"] == RUNNING:
                r.update(status=INTERRUPTED, message="the service restarted while this was running", finished_at=datetime.now(timezone.utc))
                n += 1
        return n

    def prune(self, job_id: str, keep: int) -> None:
        mine = [i for i in self.order if self.runs[i]["job_id"] == job_id]
        for i in mine[: max(0, len(mine) - keep)]:
            self.runs.pop(i, None)
            self.order.remove(i)

    def of(self, job_id: str) -> list[dict[str, Any]]:
        return [self.runs[i] for i in self.order if self.runs[i]["job_id"] == job_id]


class DbStore:
    """market_data.job_runs. Each call is its own short transaction on its own session, so a long job never holds one
    open and a failure here cannot disturb the job's own session."""

    def __init__(self, session_factory: Callable[[], Any]) -> None:
        self._session = session_factory

    def _run(self, sql: str, params: dict[str, Any]) -> Any:
        from sqlalchemy import text

        db = self._session()
        try:
            result = db.execute(text(sql), params)
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def start(self, job_id: str, label: str) -> str:
        run_id = str(uuid.uuid4())
        self._run(
            "INSERT INTO market_data.job_runs (id, job_id, label, status) VALUES (:id, :job_id, :label, 'running')",
            {"id": run_id, "job_id": job_id, "label": label},
        )
        return run_id

    def progress(self, run_id: str, done: int, total: Optional[int], tally: dict[str, int]) -> None:
        self._run(
            "UPDATE market_data.job_runs SET done = :done, total = :total, tally = CAST(:tally AS JSONB), updated_at = now() WHERE id = :id AND status = 'running'",
            {"id": run_id, "done": done, "total": total, "tally": json.dumps(tally)},
        )

    def finish(self, run_id: str, status: str, message: Optional[str], done: int, total: Optional[int], tally: dict[str, int]) -> None:
        self._run(
            "UPDATE market_data.job_runs SET status = :status, message = :message, done = :done, total = :total, tally = CAST(:tally AS JSONB), "
            "finished_at = now(), updated_at = now() WHERE id = :id",
            {"id": run_id, "status": status, "message": message, "done": done, "total": total, "tally": json.dumps(tally)},
        )

    def discard(self, run_id: str) -> None:
        self._run("DELETE FROM market_data.job_runs WHERE id = :id", {"id": run_id})

    def any_running(self, job_ids: list[str]) -> bool:
        rows = self._run("SELECT 1 FROM market_data.job_runs WHERE status = 'running' AND job_id = ANY(:ids) LIMIT 1", {"ids": list(job_ids)})
        return bool(rows.fetchall()) if hasattr(rows, "fetchall") else False

    def interrupt_running(self) -> int:
        result = self._run(
            "UPDATE market_data.job_runs SET status = 'interrupted', finished_at = now(), updated_at = now(), "
            "message = 'the service restarted while this was running' WHERE status = 'running'",
            {},
        )
        return result.rowcount or 0

    def prune(self, job_id: str, keep: int) -> None:
        self._run(
            "DELETE FROM market_data.job_runs WHERE job_id = :job_id AND id NOT IN "
            "(SELECT id FROM market_data.job_runs WHERE job_id = :job_id ORDER BY started_at DESC LIMIT :keep)",
            {"job_id": job_id, "keep": keep},
        )

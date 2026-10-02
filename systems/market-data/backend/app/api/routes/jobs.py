"""GET /jobs - what the background jobs are doing and when they last ran (the tracker is app/domain/job_tracker.py).

Admin only: it is the platform operator's view of the platform's own batch jobs, not part of the product, and a run's
message can carry a provider error. Reads only what the tracker already wrote; it never starts or stops a job."""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.adapters.db.models import JobRun
from app.adapters.db.session import get_db
from app.auth import require_admin
from app.domain.models import JobOut, JobRunOut, JobsOut
from app.scheduler import job_catalog

router = APIRouter()


def run_out(r: JobRun, now: Optional[datetime] = None) -> JobRunOut:
    now = now or datetime.now(timezone.utc)
    end = r.finished_at or now
    return JobRunOut(
        id=str(r.id),
        status=r.status,
        started_at=r.started_at,
        finished_at=r.finished_at,
        duration_seconds=max(0.0, (end - r.started_at).total_seconds()),
        total=r.total,
        done=r.done or 0,
        tally={k: int(v) for k, v in (r.tally or {}).items()},
        message=r.message,
    )


@router.get("/jobs", response_model=JobsOut)
def get_jobs(recent: int = Query(8, ge=1, le=50), db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    now = datetime.now(timezone.utc)
    jobs: list[JobOut] = []
    for entry in job_catalog():
        job_id = entry["job_id"]
        runs = db.query(JobRun).filter(JobRun.job_id == job_id).order_by(JobRun.started_at.desc()).limit(recent).all()
        running = next((r for r in runs if r.status == "running"), None)
        last_ended = next((r for r in runs if r.status != "running"), None)
        # the latest success may be older than the `recent` window (a job that keeps failing), so ask for it directly
        success = (
            db.query(JobRun).filter(JobRun.job_id == job_id, JobRun.status == "succeeded").order_by(JobRun.started_at.desc()).first()
        )
        jobs.append(
            JobOut(
                job_id=job_id,
                label=entry["label"],
                what=entry["what"],
                schedule=entry["schedule"],
                next_run_at=entry["next_run_at"],
                running=run_out(running, now) if running else None,
                last_run=run_out(last_ended, now) if last_ended else None,
                last_success=run_out(success, now) if success else None,
                recent=[run_out(r, now) for r in runs],
            )
        )
    return JobsOut(jobs=jobs)

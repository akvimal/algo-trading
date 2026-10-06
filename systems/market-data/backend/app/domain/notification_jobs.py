"""The triggers behind the notification categories (app/domain/notifications.py): what the scheduler calls when the pre-market report
is saved, when the end-of-day OI scan finishes, and on the operator-alerts and retry timers. Each opens its own session, never
raises into the job that called it (a notification problem must not fail a snapshot), and returns what it did."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db.models import JobRun, OiEodSnapshot
from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain import notifications as n

logger = logging.getLogger(__name__)

JOB_FAILURES_LOOKBACK = timedelta(hours=24)
JOB_FAILURES_PER_PASS = 5  # distinct jobs per pass (several runs of one job are one problem)
_RUNS_SCANNED = 100


def _tz() -> ZoneInfo:
    return ZoneInfo(settings.timezone)


def _safely(name: str, fn, *args) -> n.Tally:
    db = SessionLocal()
    try:
        return fn(db, *args)
    except Exception:
        logger.exception("notifications: %s failed", name)
        db.rollback()
        return n.Tally()
    finally:
        db.close()


# ---- pre-market -----------------------------------------------------------------------------------------------------------------


def premarket_to_subscribers(db: Session, report: dict, day: date) -> n.Tally:
    text = n.premarket_message(report, day)
    return n.broadcast(db, "premarket", f"premarket:{day.isoformat()}", lambda params: text)


def send_premarket(report: dict, day: Optional[date] = None) -> n.Tally:
    """Called once the morning report has been built and saved. Once per day per subscriber, whatever happens later."""
    return _safely("pre-market push", premarket_to_subscribers, report, day or datetime.now(_tz()).date())


# ---- strong OI buildup ----------------------------------------------------------------------------------------------------------


def latest_oi_rows(db: Session) -> tuple[list[dict], Optional[date]]:
    """Every F&O stock's most recent end-of-day snapshot, as plain dicts, with the date they are for."""
    latest = db.query(OiEodSnapshot.snapshot_date).order_by(OiEodSnapshot.snapshot_date.desc()).limit(1).scalar()
    if latest is None:
        return [], None
    rows = db.query(OiEodSnapshot).filter(OiEodSnapshot.snapshot_date == latest).all()
    return [
        {"symbol": r.symbol, "call_oi_change_pct": r.call_oi_change_pct, "put_oi_change_pct": r.put_oi_change_pct, "price_change_pct": r.price_change_pct, "call_buildup": r.call_buildup, "put_buildup": r.put_buildup}
        for r in rows
    ], latest


def oi_digest_to_subscribers(db: Session, today: Optional[date] = None) -> n.Tally:
    """Only a scan for TODAY is announced. The "latest snapshot" can be days old (a scan that wrote nothing new leaves yesterday's or last
    week's rows as the latest), and telling someone last week's OI buildup as if it were the day's news is worse than saying nothing."""
    rows, snapshot_date = latest_oi_rows(db)
    if snapshot_date is None or snapshot_date != (today or datetime.now(_tz()).date()):
        if snapshot_date is not None:
            logger.info("notifications: the latest OI snapshot is %s, not today - no digest sent", snapshot_date)
        return n.Tally()
    return n.broadcast(db, "oi_buildup", f"oi:{snapshot_date.isoformat()}", lambda params: n.oi_digest_message(rows, snapshot_date, params.get("top_n", 10)))


def send_oi_digest() -> n.Tally:
    """Called when the end-of-day OI scan has finished, so the digest reflects the whole day's data, not a half-written scan."""
    return _safely("OI digest", oi_digest_to_subscribers)


# ---- operator alerts ------------------------------------------------------------------------------------------------------------


def _latest_success_by_job(db: Session, job_ids: list[str]) -> dict[str, datetime]:
    """When each job last ran to a good end (succeeded, or partly done), so a failure it has since recovered from is not reported."""
    if not job_ids:
        return {}
    latest: dict[str, datetime] = {}
    for r in db.query(JobRun).filter(JobRun.job_id.in_(job_ids), JobRun.status.in_(("succeeded", "partial"))).order_by(JobRun.started_at.desc()).all():
        latest.setdefault(r.job_id, r.started_at)
    return latest


def ops_messages(db: Session, now: datetime, token_expires_at: Optional[datetime]) -> list[tuple[str, str]]:
    """(dedupe key, text) for each CURRENT operator problem: the Dhan token, and any job that failed recently and has not run to a good
    end since (a job that failed and then recovered is history, not a problem to raise or to list as one)."""
    out: list[tuple[str, str]] = []
    if token_expires_at is not None:
        t = n.token_message(token_expires_at, now, _tz())
        if t:
            out.append(t)
    runs = (
        db.query(JobRun)
        .filter(JobRun.status == "failed", JobRun.started_at >= now - JOB_FAILURES_LOOKBACK)
        .order_by(JobRun.started_at.desc())
        .limit(_RUNS_SCANNED)
        .all()
    )
    # A job that fails every few minutes (the Dhan token renewal does, once the token has expired) is ONE problem, told once a day:
    # group the failed runs by job and IST day, newest first, and send each group once with its count and latest reason.
    groups: dict[tuple[str, date], list[JobRun]] = {}
    for r in runs:
        groups.setdefault((r.job_id, r.started_at.astimezone(_tz()).date()), []).append(r)
    recovered = _latest_success_by_job(db, sorted({job_id for job_id, _ in groups}))
    today = now.astimezone(_tz()).date()
    still_failing = [(k, g) for k, g in groups.items() if not (k[0] in recovered and recovered[k[0]] > g[0].started_at)]
    for (job_id, day), group in still_failing[:JOB_FAILURES_PER_PASS]:
        latest = group[0]
        out.append((f"job-failed:{job_id}:{day.isoformat()}", n.job_failed_message(latest.label, latest.message, latest.started_at, _tz(), len(group), today)))
    return out


def ops_status_text(db: Session, now: datetime) -> str:
    """A one-off status line for "send me the latest now": the token's state and any job that is still failing, good or bad."""
    try:
        expiry = _token_expiry()
    except Exception:
        expiry = None
    problems = [text for _, text in ops_messages(db, now, expiry)]
    if problems:
        return "Operator check:\n" + "\n".join(problems)
    until = f" (valid until {expiry.astimezone(_tz()).strftime('%d %b %H:%M')} IST)" if expiry else ""
    return f"✅ Operator check: the Dhan token is fine{until} and no background job is currently failing."


def _token_expiry() -> Optional[datetime]:
    from app.providers.dhan import renew_token_status

    raw = renew_token_status().get("token_expires_at")
    if not raw:
        return None
    dt = datetime.fromisoformat(raw)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def ops_to_subscribers(db: Session, now: Optional[datetime] = None, token_expires_at: Optional[datetime] = None) -> n.Tally:
    now = now or datetime.now(timezone.utc)
    total = n.Tally()
    for key, text in ops_messages(db, now, token_expires_at):
        t = n.broadcast(db, "ops", key, lambda params, text=text: text, now)
        total.sent, total.failed, total.skipped = total.sent + t.sent, total.failed + t.failed, total.skipped + t.skipped
    return total


def check_ops() -> n.Tally:
    """Called every few minutes. A problem is sent once (its key is the token's expiry time, or the failed run's id)."""
    try:
        expiry = _token_expiry()
    except Exception:
        logger.warning("notifications: could not read the Dhan token expiry", exc_info=True)
        expiry = None
    return _safely("operator alerts", ops_to_subscribers, None, expiry)


# ---- retries --------------------------------------------------------------------------------------------------------------------


def retry_failed() -> n.Tally:
    return _safely("retry", n.retry_pending)

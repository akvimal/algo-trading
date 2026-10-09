import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/http";
import type { Job, JobRun, Jobs } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { useResource } from "../hooks/useResource";
import { STATUS_HELP, STATUS_LABEL, anyRunning, formatDuration, headline, needsAttention, progressPct, statusTone, tallyParts, whenLabel } from "./jobsModel";

/** A job in progress is polled every few seconds so its counter moves; a quiet page only needs a slow check. */
const POLL_BUSY_MS = 5000;
const POLL_IDLE_MS = 30000;

export function JobsPage() {
  const [busy, setBusy] = useState(false);
  const data = useResource(() => api<Jobs>("marketData", "/jobs?recent=8").then((r) => (setBusy(anyRunning(r.jobs)), r)), [], { pollMs: busy ? POLL_BUSY_MS : POLL_IDLE_MS });
  const jobs = data.data?.jobs ?? [];
  const attention = jobs.filter(needsAttention);

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <Link to="/more">← More</Link>
      </p>
      <h1>Background jobs</h1>
      <p className="dim" style={{ margin: 0 }}>
        The scheduled jobs that keep market data fresh: whether each is running, how far along, when it last ran and how it ended.
        {data.refreshing ? " Refreshing…" : ""}
      </p>
      {data.loading && <Skeleton lines={5} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {attention.length > 0 && (
        <div className="notice" role="status">
          {attention.length === 1 ? `${attention[0].label} needs a look: its last run ${attention[0].last_run?.status === "interrupted" ? "was cut off" : "failed"}.` : `${attention.length} jobs need a look: ${attention.map((j) => j.label).join(", ")}.`}
        </div>
      )}
      <div className="stack" data-testid="job-list">
        {jobs.map((job) => (
          <JobCard key={job.job_id} job={job} onStarted={data.reload} />
        ))}
      </div>
    </div>
  );
}

function StatusPill({ run }: { run: Pick<JobRun, "status"> }) {
  return (
    <span className={`pill ${statusTone(run.status)}`} title={STATUS_HELP[run.status]}>
      {STATUS_LABEL[run.status]}
    </span>
  );
}

function Counts({ run }: { run: JobRun }) {
  const parts = tallyParts(run.tally);
  return parts.length ? <span className="dim">{parts.join(" · ")}</span> : null;
}

function RunNow({ job, onStarted }: { job: Job; onStarted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setStarting(true);
    setError(null);
    try {
      await api("marketData", `/jobs/${job.job_id}/run`, { method: "POST" });
      setAsking(false);
      onStarted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start it. Try again.");
    } finally {
      setStarting(false);
    }
  }
  if (!asking) {
    return (
      <button className="link-btn" style={{ justifySelf: "start" }} onClick={() => setAsking(true)}>
        Run now
      </button>
    );
  }
  return (
    <div className="stack" role="group" aria-label={`Run ${job.label} now`} style={{ gap: 6 }}>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        Run {job.label} now? It uses today's data and updates today's rows in place, so running it again is safe. It can take several minutes.
      </p>
      <div className="row" style={{ justifyContent: "start", gap: 8 }}>
        <button className="btn" disabled={starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Yes, run it"}
        </button>
        <button className="link-btn" disabled={starting} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="job-message" role="alert">{error}</div>}
    </div>
  );
}

function JobCard({ job, onStarted }: { job: Job; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const top = headline(job);
  const running = job.running;
  const pct = running ? progressPct(running) : null;
  const last = job.last_run;
  return (
    <div className="card job-card" data-testid="job-card">
      <div className="row">
        <strong>{job.label}</strong>
        {top ? <StatusPill run={top} /> : <span className="pill">No runs yet</span>}
      </div>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        {job.what}
      </p>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        {job.schedule}
        {job.next_run_at ? ` · next ${whenLabel(job.next_run_at)}` : ""}
      </p>

      {running && (
        <div className="job-progress" data-testid="job-running">
          {pct != null ? <progress max={100} value={pct} aria-label={`${job.label} progress`} /> : <progress aria-label={`${job.label} progress`} />}
          <div className="row">
            <span className="num">
              {running.total ? `${running.done.toLocaleString("en-IN")} of ${running.total.toLocaleString("en-IN")}${pct != null ? ` (${pct}%)` : ""}` : "Starting…"}
            </span>
            <span className="dim">
              started {whenLabel(running.started_at)} · {formatDuration(running.duration_seconds)} so far
            </span>
          </div>
          <Counts run={running} />
        </div>
      )}

      {last && (
        <div className="job-last" data-testid="job-last">
          <div>
            <span className="dim">Last run </span>
            {whenLabel(last.started_at)}
            <span className="dim"> · took {formatDuration(last.duration_seconds)}</span>
            {running && <> </>}
            {running && <StatusPill run={last} />}
          </div>
          <Counts run={last} />
          {last.message && (last.status === "failed" || last.status === "skipped" || last.status === "interrupted") && <div className="job-message">{last.message}</div>}
        </div>
      )}
      {job.last_success && last && job.last_success.id !== last.id && (
        <div className="dim" style={{ fontSize: 13 }} data-testid="job-last-success">
          Last success {whenLabel(job.last_success.started_at)}
          {job.last_success.tally && tallyParts(job.last_success.tally).length ? ` · ${tallyParts(job.last_success.tally).join(" · ")}` : ""}
        </div>
      )}
      {job.can_run_now && !running && <RunNow job={job} onStarted={onStarted} />}
      {!top && <p className="dim" style={{ margin: 0, fontSize: 13 }}>It has not run since runs started being recorded.</p>}

      {job.recent.length > 0 && (
        <>
          <button className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ justifySelf: "start" }}>
            {open ? "Hide recent runs" : `Recent runs (${job.recent.length})`}
          </button>
          {open && (
            <ul className="job-runs" data-testid="job-runs">
              {job.recent.map((r) => (
                <li key={r.id}>
                  <span>{whenLabel(r.started_at)}</span>
                  <StatusPill run={r} />
                  <span className="dim">{r.status === "running" ? `${formatDuration(r.duration_seconds)} so far` : formatDuration(r.duration_seconds)}</span>
                  <Counts run={r} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

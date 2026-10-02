import type { Job, JobRun, JobStatus } from "../api/types";
import { formatDay, formatTime, istDayKey } from "../format";

export const STATUS_LABEL: Record<JobStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partly done",
  failed: "Failed",
  skipped: "Skipped",
  interrupted: "Interrupted",
};

/** What each ending means, as a tooltip: the badge alone is not enough to know what "partly done" is. */
export const STATUS_HELP: Record<JobStatus, string> = {
  running: "In progress now",
  succeeded: "Finished and wrote what it should",
  partial: "Finished, but some items failed",
  failed: "Did not finish its work: see the reason",
  skipped: "Chose not to run, for example on a weekend",
  interrupted: "Cut off when the service restarted before it finished",
};

/** The pill colour class: good news up, trouble dn, anything in between warn. Colour is never the only signal (the label says it too). */
export function statusTone(s: JobStatus): "up" | "dn" | "warn" | "" {
  if (s === "succeeded") return "up";
  if (s === "failed") return "dn";
  if (s === "partial" || s === "interrupted") return "warn";
  return "";
}

const TALLY_LABEL: Record<string, string> = {
  written: "written",
  ok: "done",
  failed: "failed",
  unresolved: "not in the instrument list",
  no_expiry: "no expiry",
  no_chain: "no option chain",
  too_little_history: "too little history",
};

/** A run's tally as short phrases, the headline count first and zero counts left out ("210 written", "3 failed"). */
export function tallyParts(tally: Record<string, number>): string[] {
  const order = ["written", "ok", "failed", "unresolved", "no_expiry", "no_chain", "too_little_history"];
  const keys = [...order.filter((k) => k in tally), ...Object.keys(tally).filter((k) => !order.includes(k))];
  return keys.filter((k) => tally[k] > 0).map((k) => `${tally[k].toLocaleString("en-IN")} ${TALLY_LABEL[k] ?? k.replace(/_/g, " ")}`);
}

/** 45 s / 9 min 12 s / 2 h 5 min: seconds are kept under an hour and dropped past it, where they are noise. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "Today 15:40", "Yesterday 15:40", "30 Sept 15:40" - on the IST calendar, like everything else in the app. */
export function whenLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "–";
  const day = istDayKey(iso);
  if (day === istDayKey(now)) return `Today ${formatTime(iso)}`;
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (day === istDayKey(yesterday)) return `Yesterday ${formatTime(iso)}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  if (day === istDayKey(tomorrow)) return `Tomorrow ${formatTime(iso)}`;
  return `${formatDay(iso)} ${formatTime(iso)}`;
}

/** How far through a running job is, 0-100, or null when it does not know its total yet. */
export function progressPct(run: Pick<JobRun, "done" | "total">): number | null {
  if (!run.total || run.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((run.done / run.total) * 100)));
}

/** The one run to headline a job's card with: the one in progress if there is one, else the latest that ended. */
export function headline(job: Job): JobRun | null {
  return job.running ?? job.last_run;
}

export const anyRunning = (jobs: Job[]): boolean => jobs.some((j) => j.running != null);

/** Whether a job needs attention: its latest run failed or was cut off, and a newer success has not replaced it. */
export function needsAttention(job: Job): boolean {
  const last = job.last_run;
  return last != null && (last.status === "failed" || last.status === "interrupted");
}

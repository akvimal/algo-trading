import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const run = (over: object = {}) => ({
  id: `r${Math.random()}`, status: "succeeded", started_at: "2026-09-25T10:10:00Z", finished_at: "2026-09-25T10:19:12Z", duration_seconds: 552,
  total: 210, done: 210, tally: { written: 210 }, message: null, ...over,
});
const job = (over: object = {}) => ({
  job_id: "oi-eod-snapshot-record", label: "OI buildup snapshot", what: "Stores each F&O stock's open interest for the day.", schedule: "Weekdays 15:40",
  next_run_at: "2026-09-26T10:10:00Z", running: null, last_run: null, last_success: null, recent: [], ...over,
});

let jobs: object[];
let jobsStatus = 200;
let jobCalls = 0;
let runCalls: string[] = [];

beforeEach(() => {
  jobsStatus = 200;
  jobCalls = 0;
  runCalls = [];
  jobs = [job()];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me")) return json({ id: "u1", email: "me@x.com", name: "Me", is_admin: true, experience: "pro", onboarded_at: "2026-09-01T00:00:00Z", markets: ["NSE"], default_instrument: "future", default_option_strategy: "naked" });
      if (url.includes("/jobs/") && url.endsWith("/run")) {
        runCalls.push(url);
        return json({ started: "oi-eod-snapshot-record" }, 202);
      }
      if (url.includes("/jobs")) {
        jobCalls++;
        return jobsStatus === 200 ? json({ jobs }) : json({ detail: "admin access required" }, jobsStatus);
      }
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  signIn(true);
});
afterEach(() => vi.unstubAllGlobals());

function signIn(admin: boolean) {
  setToken(jwt({ sub: "u1", email: "me@x.com", is_admin: admin, exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Background jobs page", () => {
  it("is reachable from More for an admin, and not offered to anyone else", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    await user.click(await screen.findByRole("link", { name: /Background jobs/ }));
    expect(await screen.findByRole("heading", { name: "Background jobs" })).toBeInTheDocument();
  });

  it("is not in More for a person who is not an admin, and its address sends them back", async () => {
    signIn(false);
    renderAt("/more/jobs");
    expect(await screen.findByRole("heading", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Background jobs/ })).not.toBeInTheDocument();
    expect(jobCalls).toBe(0); // never even asked
  });

  it("says what a job is, when it is due and when it is next", async () => {
    renderAt("/more/jobs");
    const card = within(await screen.findByTestId("job-card"));
    expect(card.getByText("OI buildup snapshot")).toBeInTheDocument();
    expect(card.getByText(/Stores each F&O stock/)).toBeInTheDocument();
    expect(card.getByText(/Weekdays 15:40 · next/)).toBeInTheDocument();
    expect(card.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows how far a running job is, with a progress bar and the counts so far", async () => {
    jobs = [job({ running: run({ status: "running", finished_at: null, duration_seconds: 125, total: 210, done: 63, tally: { written: 60, failed: 3 } }) })];
    renderAt("/more/jobs");
    const running = within(await screen.findByTestId("job-running"));
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(running.getByText("63 of 210 (30%)")).toBeInTheDocument();
    expect(running.getByText(/2 min 5 s so far/)).toBeInTheDocument();
    expect(running.getByText("60 written · 3 failed")).toBeInTheDocument();
    expect(running.getByRole("progressbar", { name: "OI buildup snapshot progress" })).toHaveAttribute("value", "30");
  });

  it("shows an indeterminate bar and Starting while a run does not know its total yet", async () => {
    jobs = [job({ running: run({ status: "running", finished_at: null, duration_seconds: 2, total: null, done: 0, tally: {} }) })];
    renderAt("/more/jobs");
    const running = within(await screen.findByTestId("job-running"));
    expect(running.getByText("Starting…")).toBeInTheDocument();
    expect(running.getByRole("progressbar")).not.toHaveAttribute("value");
  });

  it("shows the last run: when, how long, how it ended and the counts, and no separate last-success line when it succeeded", async () => {
    const ok = run({ id: "ok1" });
    jobs = [job({ last_run: ok, last_success: ok, recent: [ok] })];
    renderAt("/more/jobs");
    const last = within(await screen.findByTestId("job-last"));
    expect(last.getByText(/took 9 min 12 s/)).toBeInTheDocument();
    expect(last.getByText("210 written")).toBeInTheDocument();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.queryByTestId("job-last-success")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // nothing needs a look
  });

  it("flags a failed last run with its reason, the last success, and a needs-a-look notice", async () => {
    const bad = run({ id: "bad1", status: "failed", duration_seconds: 3, total: null, done: 0, tally: {}, message: "0 NSE F&O stocks listed (instrument master not loaded?)" });
    const good = run({ id: "good1", started_at: "2026-09-24T10:10:00Z" });
    jobs = [job({ last_run: bad, last_success: good, recent: [bad, good] })];
    renderAt("/more/jobs");
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/0 NSE F&O stocks listed/)).toBeInTheDocument();
    expect(screen.getByTestId("job-last-success")).toHaveTextContent(/Last success .*210 written/);
    expect(screen.getByRole("status")).toHaveTextContent("OI buildup snapshot needs a look: its last run failed.");
  });

  it("says a run that a restart cut off was cut off, and names every job needing a look", async () => {
    const cut = run({ status: "interrupted", message: "the service restarted while this was running", tally: { written: 40 } });
    const bad = run({ status: "failed", message: "boom", tally: {} });
    jobs = [
      job({ last_run: cut, recent: [cut] }),
      job({ job_id: "equity-screener-snapshot-record", label: "Equity screener snapshot", last_run: bad, recent: [bad] }),
    ];
    renderAt("/more/jobs");
    expect(await screen.findByText("Interrupted")).toBeInTheDocument();
    expect(screen.getByText(/the service restarted while this was running/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 jobs need a look: OI buildup snapshot, Equity screener snapshot.");
  });

  it("does not raise a notice for a skipped run (a weekend is normal), and shows why it was skipped", async () => {
    const skipped = run({ status: "skipped", message: "weekend", duration_seconds: 0, total: null, done: 0, tally: {} });
    jobs = [job({ last_run: skipped, recent: [skipped] })];
    renderAt("/more/jobs");
    expect(await screen.findByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("weekend")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists recent runs on request, newest first, each with its ending", async () => {
    const a = run({ id: "a", started_at: "2026-09-25T10:10:00Z" });
    const b = run({ id: "b", started_at: "2026-09-24T10:10:00Z", status: "partial", tally: { written: 200, failed: 10 } });
    jobs = [job({ last_run: a, last_success: a, recent: [a, b] })];
    const user = userEvent.setup();
    renderAt("/more/jobs");
    expect(screen.queryByTestId("job-runs")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Recent runs (2)" }));
    const items = within(screen.getByTestId("job-runs")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("Partly done");
    expect(items[1]).toHaveTextContent("200 written · 10 failed");
    await user.click(screen.getByRole("button", { name: "Hide recent runs" }));
    expect(screen.queryByTestId("job-runs")).not.toBeInTheDocument();
  });

  it("explains a refusal in plain words instead of an empty page", async () => {
    jobsStatus = 403;
    renderAt("/more/jobs");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByTestId("job-card")).not.toBeInTheDocument();
  });

  it("starts a job by hand only after a confirmation, and not at all if cancelled", async () => {
    jobs = [job({ can_run_now: true })];
    const user = userEvent.setup();
    renderAt("/more/jobs");
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(runCalls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(screen.getByText(/Run OI buildup snapshot now\?/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, run it" }));
    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]).toContain("/jobs/oi-eod-snapshot-record/run");
  });

  it("offers no Run now for a job that cannot be started by hand, or one already running", async () => {
    jobs = [job({ job_id: "a", label: "A" }), job({ job_id: "b", label: "B", can_run_now: true, running: run({ status: "running", finished_at: null }) })];
    renderAt("/more/jobs");
    await screen.findByText("A");
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });
});

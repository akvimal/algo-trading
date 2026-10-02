import { describe, expect, it } from "vitest";
import type { Job, JobRun } from "../api/types";
import { anyRunning, formatDuration, headline, needsAttention, progressPct, statusTone, tallyParts, whenLabel } from "./jobsModel";

const run = (over: Partial<JobRun> = {}): JobRun => ({
  id: "r", status: "succeeded", started_at: "2026-09-25T10:10:00Z", finished_at: null, duration_seconds: 10, total: null, done: 0, tally: {}, message: null, ...over,
});
const job = (over: Partial<Job> = {}): Job => ({
  job_id: "j", label: "J", what: "", schedule: "", next_run_at: null, running: null, last_run: null, last_success: null, recent: [], ...over,
});

describe("formatDuration", () => {
  it.each([
    [0, "0 s"], [45, "45 s"], [59.6, "1 min"], [60, "1 min"], [552, "9 min 12 s"], [3600, "1 h"], [7500, "2 h 5 min"],
  ])("%s seconds reads as %s", (s, text) => expect(formatDuration(s)).toBe(text));
  it("shows a dash for nothing, or nonsense", () => {
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(undefined)).toBe("–");
    expect(formatDuration(-3)).toBe("–");
    expect(formatDuration(NaN)).toBe("–");
  });
});

describe("whenLabel", () => {
  // 2026-09-25 12:00 IST
  const now = new Date("2026-09-25T06:30:00Z");
  it("says Today, Yesterday and Tomorrow on the IST calendar, and a date otherwise", () => {
    expect(whenLabel("2026-09-25T10:10:00Z", now)).toBe("Today 15:40");
    expect(whenLabel("2026-09-24T10:10:00Z", now)).toBe("Yesterday 15:40");
    expect(whenLabel("2026-09-26T10:10:00Z", now)).toBe("Tomorrow 15:40");
    expect(whenLabel("2026-09-20T10:10:00Z", now)).toBe("20 Sept 15:40");
    expect(whenLabel(null, now)).toBe("–");
  });
  it("uses the Indian calendar day, not the UTC one (23:00 UTC is already tomorrow in IST)", () => {
    expect(whenLabel("2026-09-25T20:00:00Z", now)).toBe("Tomorrow 01:30");
  });
});

describe("tallyParts", () => {
  it("puts the headline count first, leaves out zeros and names the skips in words", () => {
    expect(tallyParts({ failed: 3, written: 207, unresolved: 0, no_chain: 2 })).toEqual(["207 written", "3 failed", "2 no option chain"]);
    expect(tallyParts({ ok: 4, failed: 0 })).toEqual(["4 done"]);
    expect(tallyParts({})).toEqual([]);
  });
  it("groups thousands the Indian way, and still shows a count it has no wording for", () => {
    expect(tallyParts({ written: 1998, too_little_history: 12 })).toEqual(["1,998 written", "12 too little history"]);
    expect(tallyParts({ something_new: 5 })).toEqual(["5 something new"]);
  });
});

describe("progressPct", () => {
  it("is a whole percent, clamped, and unknown without a total", () => {
    expect(progressPct({ done: 63, total: 210 })).toBe(30);
    expect(progressPct({ done: 5, total: 3 })).toBe(100);
    expect(progressPct({ done: 0, total: 0 })).toBeNull();
    expect(progressPct({ done: 4, total: null })).toBeNull();
  });
});

describe("what a card leads with, and what needs attention", () => {
  it("headlines the running run if there is one, otherwise the last that ended", () => {
    const r = run({ status: "running" });
    const l = run({ status: "failed" });
    expect(headline(job({ running: r, last_run: l }))).toBe(r);
    expect(headline(job({ last_run: l }))).toBe(l);
    expect(headline(job())).toBeNull();
  });
  it("needs a look when the last run failed or was cut off, not when it was skipped or only partly done", () => {
    expect(needsAttention(job({ last_run: run({ status: "failed" }) }))).toBe(true);
    expect(needsAttention(job({ last_run: run({ status: "interrupted" }) }))).toBe(true);
    expect(needsAttention(job({ last_run: run({ status: "skipped" }) }))).toBe(false);
    expect(needsAttention(job({ last_run: run({ status: "partial" }) }))).toBe(false);
    expect(needsAttention(job({ last_run: run({ status: "succeeded" }) }))).toBe(false);
    expect(needsAttention(job())).toBe(false);
  });
  it("knows whether anything is running, to poll faster", () => {
    expect(anyRunning([job(), job({ running: run({ status: "running" }) })])).toBe(true);
    expect(anyRunning([job()])).toBe(false);
  });
  it("tones good news up, trouble dn, and the in-between warn", () => {
    expect(statusTone("succeeded")).toBe("up");
    expect(statusTone("failed")).toBe("dn");
    expect(statusTone("partial")).toBe("warn");
    expect(statusTone("interrupted")).toBe("warn");
    expect(statusTone("running")).toBe("");
    expect(statusTone("skipped")).toBe("");
  });
});

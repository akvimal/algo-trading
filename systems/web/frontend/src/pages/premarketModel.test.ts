import { describe, expect, it } from "vitest";
import type { PremarketInput, PremarketReport } from "../api/types";
import { formatMove, headline, moveTone, reportAge, sections } from "./premarketModel";

const inp = (over: Partial<PremarketInput>): PremarketInput => ({
  key: "sp500", label: "S&P 500", group: "us", ok: true, value: 1, change: 0.66, unit: "pct", source: "yahoo", error: null, ...over,
});

describe("formatMove", () => {
  it("signs percent moves with a real minus sign", () => {
    expect(formatMove(inp({ change: 0.663 }))).toBe("+0.66%");
    expect(formatMove(inp({ change: -2.536 }))).toBe("−2.54%");
    expect(formatMove(inp({ change: 0 }))).toBe("0.00%");
  });
  it("shows yields in basis points", () => {
    expect(formatMove(inp({ key: "us10y", unit: "bp", change: 3.4 }))).toBe("+3.4 bp");
  });
  it("shows a dash for a failed or missing input", () => {
    expect(formatMove(inp({ ok: false, change: null }))).toBe("–");
  });
});

describe("moveTone", () => {
  it("treats a rise in crude, USD/INR and yields as bad news", () => {
    expect(moveTone(inp({ key: "brent", change: 1 }))).toBe("dn");
    expect(moveTone(inp({ key: "usdinr", change: -0.2 }))).toBe("up");
    expect(moveTone(inp({ key: "in10y", change: 2 }))).toBe("dn");
  });
  it("treats a rise in equities as good news and a failed input as flat", () => {
    expect(moveTone(inp({ key: "sp500", change: 1 }))).toBe("up");
    expect(moveTone(inp({ ok: false }))).toBe("flat");
  });
});

describe("sections", () => {
  it("orders the gap first and drops sections with no inputs", () => {
    const out = sections([inp({ key: "adr_infy" }), inp({ key: "gift_nifty" }), inp({ key: "sp500" })]);
    expect(out.map((s) => s.title)).toEqual(["GIFT Nifty", "US close", "Indian ADRs"]);
  });
});

const report = (over: Partial<PremarketReport>): PremarketReport => ({
  day: "2026-10-06", generated_at: "2026-10-06T03:15:00Z", bias: "bullish", agree: null, model: null, ai_error: null, inputs: [],
  rules: { score: 0.3, bias: "bullish", coverage: 1, gift_gap_pct: 0.334, factors: [] }, ai: null, ...over,
});

describe("reportAge", () => {
  it("says Today for a same-day report and flags an older one as stale", () => {
    const now = new Date("2026-10-06T04:00:00Z");
    expect(reportAge(report({}), now)).toEqual({ stale: false, text: "Today 08:45" });
    const old = reportAge(report({ generated_at: "2026-10-02T03:15:00Z" }), now);
    expect(old.stale).toBe(true);
    expect(old.text).toContain("Fri");
  });
});

describe("headline", () => {
  it("uses the model's one-liner when it ran", () => {
    const ai = { bias: "bullish" as const, confidence: 70, one_liner: "Gap up on a firm US close.", reasons: [], risks: [], watch: "" };
    expect(headline(report({ ai }))).toBe("Gap up on a firm US close.");
  });
  it("falls back to a plain rule-based statement", () => {
    expect(headline(report({}))).toBe("Rule-based read: bullish. GIFT Nifty is up 0.33% on Nifty's last close.");
  });
});

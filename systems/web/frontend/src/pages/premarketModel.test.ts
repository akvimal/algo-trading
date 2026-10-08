import { describe, expect, it } from "vitest";
import type { PremarketIndicator, PremarketInput, PremarketMacro, PremarketReport } from "../api/types";
import { nseSessionStarted, derivedRows, formatIndicator, formatMove, formatPoints, hasMacro, headline, indicatorMove, moveTone, periodLabel, reportAge, sections, shortDate, STANCE_LABEL, stanceTone } from "./premarketModel";

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

const ind = (over: Partial<PremarketIndicator>): PremarketIndicator => ({
  key: "cpi", label: "Inflation (CPI, YoY)", unit: "pct", ok: true, value: 4.82, previous: 4.44, change: 0.38, period: "2026-08-31", error: null, ...over,
});

describe("domestic backdrop", () => {
  it("formats percent prints and reserves in billions", () => {
    expect(formatIndicator(ind({}))).toBe("4.82%");
    expect(formatIndicator(ind({ unit: "usd_bn", value: 747.56 }))).toBe("$747.6bn");
    expect(formatIndicator(ind({ ok: false, value: null }))).toBe("–");
  });
  it("names the month a print covers", () => {
    expect(periodLabel("2026-08-31")).toBe("Aug 2026");
    expect(periodLabel(null)).toBe("");
    expect(periodLabel("2026-09-30")).toBe("Sep 2026");
  });
  it("says how a print moved from the one before it", () => {
    expect(indicatorMove(ind({}))).toBe("up 0.38 from 4.44%");
    expect(indicatorMove(ind({ change: -0.5, previous: 5.32 }))).toBe("down 0.50 from 5.32%");
    expect(indicatorMove(ind({ key: "repo", change: 0, previous: 5.25, value: 5.25 }))).toBe("unchanged at 5.25%");
    expect(indicatorMove(ind({ unit: "usd_bn", value: 747.56, previous: 765.9, change: -18.34 }))).toBe("down $18.34bn from $765.9bn");
  });
  it("says nothing about movement when the feed gave no previous value", () => {
    expect(indicatorMove(ind({ change: null, previous: null }))).toBe("");
  });
  it("dates an RBI item on the IST calendar", () => {
    expect(shortDate("2026-10-03T05:30:00Z")).toBe("3 Oct");
    expect(shortDate("2026-09-30T20:00:00Z")).toBe("1 Oct"); // already October in India
    expect(shortDate(null)).toBe("");
  });
  it("only highlights a stance when the text itself gave a policy direction", () => {
    expect(stanceTone("hawkish")).toBe("warn");
    expect(stanceTone("dovish")).toBe("warn");
    expect(stanceTone("neutral")).toBe("");
    expect(stanceTone("not about policy")).toBe("");
    expect(STANCE_LABEL["not about policy"]).toBe("Not about rates policy");
  });
  it("signs percentage points", () => {
    expect(formatPoints(0.43)).toBe("+0.43 pts");
    expect(formatPoints(-0.12)).toBe("−0.12 pts");
    expect(formatPoints(null)).toBe("–");
  });
  it("shows the real rate and the 10Y spread only when they could be worked out", () => {
    expect(derivedRows({ derived: { real_rate: 0.43, spread_10y_repo: 1.97, india_10y: 7.2 } }).map((r) => [r.label, r.value])).toEqual([
      ["Real policy rate", "+0.43 pts"],
      ["10Y yield over repo", "+1.97 pts"],
    ]);
    expect(derivedRows({ derived: { real_rate: null, spread_10y_repo: 1.97, india_10y: 7.2 } })).toHaveLength(1);
    expect(derivedRows({ derived: { real_rate: null, spread_10y_repo: null, india_10y: null } })).toEqual([]);
  });
  it("has nothing to show when every feed was down and the model said nothing", () => {
    const empty: PremarketMacro = { indicators: [ind({ ok: false, value: null })], derived: { real_rate: null, spread_10y_repo: null, india_10y: null }, rbi: [] };
    expect(hasMacro(empty, null)).toBe(false);
    expect(hasMacro(null, null)).toBe(false);
    expect(hasMacro(undefined, null)).toBe(false);
    expect(hasMacro({ ...empty, indicators: [ind({})] }, null)).toBe(true);
    expect(hasMacro(null, { bias: "neutral", confidence: 1, one_liner: "", reasons: [], risks: [], watch: "", macro_context: "Real rate is positive." })).toBe(true);
  });
});

describe("MCX and crypto briefs", () => {
  it("formats the Fear & Greed index move in points", () => {
    expect(formatMove(inp({ key: "fear_greed", unit: "pt", change: 3 }))).toBe("+3.0 pts");
    expect(formatMove(inp({ key: "fear_greed", unit: "pt", change: -2.5 }))).toBe("−2.5 pts");
  });
  it("colours by what helps each market: crude rising is good for MCX but bad for Indian equities, VIX rising is bad for crypto", () => {
    expect(moveTone(inp({ key: "brent", change: 2 }))).toBe("dn");
    expect(moveTone(inp({ key: "brent", change: 2 }), "MCX")).toBe("up");
    expect(moveTone(inp({ key: "dxy", change: 0.4 }), "MCX")).toBe("dn");
    expect(moveTone(inp({ key: "vix", change: 6 }), "CRYPTO")).toBe("dn");
    expect(moveTone(inp({ key: "btc", change: 2 }), "CRYPTO")).toBe("up");
  });
  it("groups each segment's own inputs, dropping sections with nothing in them", () => {
    const rows = [inp({ key: "gold" }), inp({ key: "brent" }), inp({ key: "dxy" })];
    expect(sections(rows, "MCX").map((s) => s.title)).toEqual(["Metals", "Energy", "Dollar, rupee, yields"]);
    expect(sections([inp({ key: "btc" })], "CRYPTO").map((s) => s.title)).toEqual(["Coins"]);
  });
});

describe("NSE market pulse", () => {
  it("knows when the NSE session has started: weekdays from 09:15 IST", () => {
    expect(nseSessionStarted(new Date("2026-10-08T03:30:00Z"))).toBe(false); // Thu 09:00 IST
    expect(nseSessionStarted(new Date("2026-10-08T03:45:00Z"))).toBe(true); // 09:15
    expect(nseSessionStarted(new Date("2026-10-08T12:00:00Z"))).toBe(true); // after the close it still leads with the day's pulse
    expect(nseSessionStarted(new Date("2026-10-10T05:00:00Z"))).toBe(false); // Saturday
  });
  it("groups the pulse's own inputs and treats a rising India VIX as bad news", () => {
    expect(sections([inp({ key: "nifty" }), inp({ key: "indiavix" }), inp({ key: "sec_it" })], "NSE_PULSE").map((s) => s.title)).toEqual(["Indices", "Volatility", "Sectors"]);
    expect(moveTone(inp({ key: "indiavix", change: 5 }), "NSE_PULSE")).toBe("dn");
    expect(moveTone(inp({ key: "nifty", change: 0.5 }), "NSE_PULSE")).toBe("up");
  });
});

import { describe, expect, it } from "vitest";
import type { IdeaAnalysis } from "../api/ideas";
import { CARD_WIDTH, layoutCard, limitLines, toneColor, type Measure } from "./analysisCard";

// A character is half as wide as the font is tall: close enough to real text to check wrapping without a canvas.
const measure: Measure = (text, font) => text.length * (Number(/(\d+)px/.exec(font)?.[1] ?? 15) * 0.5);

const analysis = (over: Partial<IdeaAnalysis> = {}): IdeaAnalysis => ({
  verdict: "The trend and the business both point up", agreement: "aligned", overall: "bullish", overall_strength: "strong", chart_bias: "bullish",
  chart_points: ["Weekly: price is above its 50-week average", "Daily: price is above its 50-day average", "Trend strength is strong (ADX 45, falling)"],
  price: 2705.6, as_of: "2026-10-10", business_bias: "bullish", business_confidence: 0.7,
  business_summary: "RR Kabel Ltd shows strong historical profit growth and a consistent dividend payout, coupled with a growing distribution network.",
  pros: ["Company is expected to give good quarter", "Company has delivered good profit growth of 30.5% CAGR over last 5 years"],
  cons: ["Stock is trading at 11.9 times its book value"],
  support: { low: 2320, high: 2353.7, distance_pct: 13 }, resistance: { low: 2775, high: 2815, distance_pct: 2.6 },
  ...over,
});

describe("the verdict", () => {
  it("leads with the headline, whether the two sides agree, and the overall lean in words", () => {
    const l = layoutCard(analysis(), measure);
    expect(l.verdict.headline.join(" ")).toBe("The trend and the business both point up");
    expect(l.verdict.chips.map((c) => c.text)).toEqual(["Chart and business agree", "Overall ▲ Bullish · strong"]);
    expect(l.verdict.chips.map((c) => c.tone)).toEqual(["up", "up"]);
  });

  it("colours the edge by the overall lean, except that a disagreement is always a caution", () => {
    expect(layoutCard(analysis({ agreement: "conflicting", overall: "bullish" }), measure).verdict.accent).toBe(toneColor("warn"));
    expect(layoutCard(analysis({ overall: "bearish" }), measure).verdict.accent).toBe(toneColor("dn"));
    expect(layoutCard(analysis({ overall: "neutral", overall_strength: null }), measure).verdict.accent).toBe(toneColor("dim"));
    const conflict = layoutCard(analysis({ agreement: "conflicting", overall: "neutral", overall_strength: null }), measure).verdict.chips;
    expect(conflict.map((c) => c.text)).toEqual(["Chart and business disagree", "Overall ◆ Neutral"]);
    expect(conflict[0].tone).toBe("warn");
  });

  it("wraps a long headline instead of running off the card, and grows to fit it", () => {
    const short = layoutCard(analysis(), measure);
    const long = layoutCard(analysis({ verdict: "Price is rising, but the business case is weak and the chart is stretched far above its averages" }), measure);
    expect(long.verdict.headline.length).toBeGreaterThan(1);
    expect(long.verdict.height).toBeGreaterThan(short.verdict.height);
    expect(long.height).toBeGreaterThan(short.height);
  });
});

describe("the two reads", () => {
  it("puts the chart's reasons on one side and the business's summary, strengths and concerns on the other, each with its lean", () => {
    const { chart, business } = layoutCard(analysis(), measure).columns;
    expect(chart.chip?.text).toBe("▲ Bullish");
    expect(chart.items.map((i) => i.kind)).toEqual(["bullet", "bullet", "bullet"]);
    expect(business.chip?.text).toBe("▲ Bullish · 70% sure");
    expect(business.items.map((i) => i.kind)).toEqual(["text", "good", "good", "bad"]);
  });

  it("keeps the first four chart reasons and two strengths and two concerns, however many were sent", () => {
    const { chart, business } = layoutCard(analysis({ chart_points: ["a", "b", "c", "d", "e", "f"], pros: ["p1", "p2", "p3"], cons: ["c1", "c2", "c3"] }), measure).columns;
    expect(chart.items).toHaveLength(4);
    expect(business.items.filter((i) => i.kind === "good")).toHaveLength(2);
    expect(business.items.filter((i) => i.kind === "bad")).toHaveLength(2);
  });

  it("limits how long any one line of reasoning can run, ending it with an ellipsis", () => {
    const long = "very ".repeat(80);
    const { business } = layoutCard(analysis({ business_summary: long, pros: [long], cons: [long] }), measure).columns;
    const summary = business.items.find((i) => i.kind === "text")!;
    expect(summary.lines.length).toBeLessThanOrEqual(5);
    expect(summary.lines[summary.lines.length - 1].endsWith("…")).toBe(true);
    for (const kind of ["good", "bad"] as const) expect(business.items.find((i) => i.kind === kind)!.lines.length).toBeLessThanOrEqual(2);
  });

  it("makes both sides the same height, so the panels line up", () => {
    const l = layoutCard(analysis(), measure);
    expect(l.columns.height).toBeGreaterThanOrEqual(l.columns.chart.contentHeight);
    expect(l.columns.height).toBeGreaterThanOrEqual(l.columns.business.contentHeight);
    expect(l.columns.height).toBe(Math.max(l.columns.chart.contentHeight, l.columns.business.contentHeight) + 16);
  });

  it("says the business was not read when there is no business lean, instead of an empty panel", () => {
    const { business } = layoutCard(analysis({ agreement: "technical_only", business_bias: null, business_confidence: null, business_summary: null, pros: [], cons: [] }), measure).columns;
    expect(business.chip).toBeNull();
    expect(business.items).toHaveLength(1);
    expect(business.items[0]).toMatchObject({ kind: "note", lines: ["Not read for this stock yet."] });
  });

  it("fits every line inside its panel", () => {
    const l = layoutCard(analysis({ chart_points: ["x".repeat(200)], business_summary: "y".repeat(400) }), measure);
    const inner = l.columns.colWidth - 20;
    for (const col of [l.columns.chart, l.columns.business]) for (const it of col.items) for (const line of it.lines) expect(measure(line, "15px x")).toBeLessThanOrEqual(inner + 1);
  });
});

describe("where the price sits", () => {
  it("shows resistance on the left, the price in the middle, support on the right, with how far each is", () => {
    const l = layoutCard(analysis(), measure).levels!;
    expect(l.left).toBe("▲ Resistance 2,775.00 – 2,815.00  (+2.6%)");
    expect(l.centre).toBe("● 2,705.60");
    expect(l.right).toBe("▼ Support 2,320.00 – 2,353.70  (−13.0%)");
    expect(l.stacked).toBe(false);
  });

  it("shows only the levels there are, and none at all when there are none", () => {
    expect(layoutCard(analysis({ support: null }), measure).levels).toMatchObject({ right: null, left: "▲ Resistance 2,775.00 – 2,815.00  (+2.6%)" });
    expect(layoutCard(analysis({ support: null, resistance: null }), measure).levels).toBeNull();
  });

  it("stacks them one per line, in chart order, when they would not fit side by side", () => {
    const wide = (x: number) => ({ low: x * 1000, high: x * 1000 + 40, distance_pct: 12.3 });
    const widerFont: Measure = (t, f) => measure(t, f) * 1.6; // a wide typeface (or a long price) is what pushes them past the card's width
    const l = layoutCard(analysis({ price: 123456.78, resistance: wide(133), support: wide(110) }), widerFont).levels!;
    expect(l.stacked).toBe(true);
    expect(l.height).toBeGreaterThan(46);
  });
});

describe("the whole card", () => {
  it("is the width the chart pictures are, ends with the notice that it is machine-made, and grows with its content", () => {
    const l = layoutCard(analysis(), measure, 400);
    expect(l.width).toBe(CARD_WIDTH);
    expect(l.footer.lines.join(" ")).toMatch(/Generated by AI and simple rules.*Not advice/);
    expect(l.verdict.top).toBe(400); // below the chart
    expect(l.columns.top).toBeGreaterThan(l.verdict.top + l.verdict.height - 1);
    expect(l.levels!.top).toBeGreaterThan(l.columns.top + l.columns.height - 1);
    expect(l.footer.top).toBeGreaterThan(l.levels!.top + l.levels!.height - 1);
    expect(l.height).toBeGreaterThan(l.footer.top + l.footer.height - 400 - 1);
  });

  it("closes up without a levels strip", () => {
    const withLevels = layoutCard(analysis(), measure);
    const without = layoutCard(analysis({ support: null, resistance: null }), measure);
    expect(without.height).toBeLessThan(withLevels.height);
  });
});

describe("limitLines", () => {
  const m = (s: string) => s.length;
  it("leaves short text alone and cuts long text with an ellipsis that still fits", () => {
    expect(limitLines(["a", "b"], 3, 10, m)).toEqual(["a", "b"]);
    const cut = limitLines(["first line", "second line is long", "third"], 2, 12, m);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith("…")).toBe(true);
    expect(cut[1].length).toBeLessThanOrEqual(12);
  });
});

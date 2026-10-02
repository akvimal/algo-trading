import { describe, expect, it } from "vitest";
import type { AiRead, MarketRegime, OiSummary, StudyNote } from "../api/types";
import { buildNoteContext, contextChips, groupByDay } from "./notesModel";

const regime: MarketRegime = { regime: "ranging", adx: 14.2, atr_percentile: 40, trend: "range", advice: "chop" };
const oi = {
  underlying_symbol: "NIFTY", underlying_exchange: "NSE", expiry: "2026-10-06", underlying_last_price: 22550, total_call_oi: 100, total_put_oi: 70, pcr: 0.7,
  total_call_oi_change_5m: 10, total_put_oi_change_5m: 20, total_call_oi_change_15m: null, total_put_oi_change_15m: null,
  total_call_buildup: "short_buildup", total_put_buildup: "long_buildup", strikes: [
    { strike: 22500, call: { oi: 1, volume: 100 }, put: { oi: 1, volume: 150 } },
  ],
} as unknown as OiSummary;
const ai: AiRead = {
  underlying: "NIFTY", expiry: "2026-10-06", model: "m", generated_at: "2026-10-01T10:00:00+05:30", bias: "bearish", confidence: 72, one_liner: "Sell rallies.",
  reasoning: [], support: [], resistance: [], risks: [], wait_for: "", data_gaps: [],
};

describe("buildNoteContext", () => {
  it("keeps only what is available on screen", () => {
    expect(buildNoteContext({ price: 22550, interval: "5min", regime: null, structure: {}, oi: null, aiRead: null, holding: null })).toEqual({ price: 22550, interval: "5min" });
  });

  it("carries the regime, structure trend, option-chain read, the AI read's bias and what is held", () => {
    const ctx = buildNoteContext({ price: 22550.5, interval: "5min", regime, structure: { "15m": "down" }, oi, aiRead: ai, holding: "1 open NIFTY position" });
    expect(ctx.regime).toEqual({ regime: "ranging", adx: 14.2, atr_percentile: 40 });
    expect(ctx.structure_trend).toEqual({ "15m": "down" });
    expect(ctx.oi).toMatchObject({ expiry: "2026-10-06", pcr: 0.7, vol_pcr: 1.5, call_oi_change_5m: 10, put_buildup: "long_buildup" });
    expect(ctx.ai_read).toEqual({ bias: "bearish", confidence: 72, one_liner: "Sell rallies.", generated_at: "2026-10-01T10:00:00+05:30" });
    expect(ctx.holding).toBe("1 open NIFTY position");
  });
});

describe("contextChips", () => {
  it("summarises the market at the time in a few short chips", () => {
    const ctx = buildNoteContext({ price: 22550.5, interval: "5min", regime, structure: { "15m": "range" }, oi, aiRead: ai, holding: "1 open NIFTY position" });
    expect(contextChips(ctx)).toEqual(["22,550.5", "Ranging · ADX 14", "15m sideways", "PCR 0.70", "AI: bearish 72%", "holding 1 open NIFTY position"]);
  });

  it("is empty for a note with no context", () => {
    expect(contextChips(null)).toEqual([]);
  });
});

const note = (id: string, at: string): StudyNote => ({
  id, segment: "NSE", symbol: "NIFTY", interval: "5min", text: id, tag: null, context: null, position_id: null, option_group_id: null, has_snapshot: false, created_at: at,
});

describe("groupByDay", () => {
  const now = new Date(2026, 9, 1, 15, 0);

  it("headings are Today and Yesterday, then the date, oldest day first and notes in order within a day", () => {
    const groups = groupByDay(
      [note("a", new Date(2026, 8, 28, 10, 0).toISOString()), note("b", new Date(2026, 8, 30, 9, 0).toISOString()), note("c", new Date(2026, 9, 1, 9, 0).toISOString()), note("d", new Date(2026, 9, 1, 11, 0).toISOString())],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([new Date(2026, 8, 28).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), "Yesterday", "Today"]);
    expect(groups[2].notes.map((n) => n.id)).toEqual(["c", "d"]);
  });

  it("is empty with no notes", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { NoteContext, OptionGroup, Position, StudyNote } from "../api/types";
import { canPublish, closedTradesFor, deliveryNote, looksLikeDestination, onInstrument, publishableContext, publishedLabel, toIdeaRequest, usableStop } from "./ideasModel";

const note = (over: Partial<StudyNote> = {}): StudyNote => ({
  id: "n1", segment: "NSE", symbol: "NIFTY", interval: "15min", text: "Watching 23,100 for a retest.", tag: "plan", context: null, position_id: null,
  option_group_id: null, has_snapshot: false, created_at: "2026-10-06T05:00:00Z", ...over,
});

const FULL_CONTEXT: NoteContext = {
  price: 23140.5, interval: "15min", regime: { regime: "trending_up", adx: 31.2, atr_percentile: 70 }, structure_trend: { "15m": "up" },
  oi: { expiry: "2026-10-08", pcr: 0.84, vol_pcr: 0.9, call_oi_change_5m: 5, put_oi_change_5m: 3, call_buildup: "long_buildup", put_buildup: "short_buildup" },
  ai_read: { bias: "bullish", confidence: 80, one_liner: "SECRET", generated_at: "x" }, holding: "long 50 NIFTY @ 23,000",
};

describe("canPublish", () => {
  it("allows plan and observation notes only", () => {
    expect(canPublish({ tag: "plan" })).toBe(true);
    expect(canPublish({ tag: "observation" })).toBe(true);
    for (const t of ["mistake", "review", null] as const) expect(canPublish({ tag: t })).toBe(false);
  });
});

describe("publishableContext", () => {
  it("keeps price, regime, trend and PCR and drops the position, the AI read and the rest of the OI detail", () => {
    const ctx = publishableContext(FULL_CONTEXT)!;
    expect(ctx).toEqual({ price: 23140.5, interval: "15min", regime: { regime: "trending_up", adx: 31.2 }, structure_trend: { "15m": "up" }, oi: { pcr: 0.84 } });
    const wire = JSON.stringify(ctx);
    for (const private_ of ["holding", "long 50", "SECRET", "bullish", "long_buildup", "atr_percentile"]) expect(wire).not.toContain(private_);
  });
  it("is null with no context and omits parts that are missing", () => {
    expect(publishableContext(null)).toBeNull();
    expect(publishableContext({ price: null, interval: "5min" })).toEqual({ price: null, interval: "5min" });
  });
});

describe("toIdeaRequest", () => {
  it("builds the request from the note, never sending the position held", () => {
    const req = toIdeaRequest(note({ context: FULL_CONTEXT }), { includeContext: true });
    expect(req).toMatchObject({ note_id: "n1", segment: "NSE", symbol: "NIFTY", interval: "15min", tag: "plan", include_context: true });
    expect(req.snapshot_png_base64).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain("holding");
  });
  it("attaches a snapshot only when one is given", () => {
    expect(toIdeaRequest(note(), { includeContext: false, snapshot: "data:image/png;base64,AAAA" })).toMatchObject({ include_context: false, snapshot_png_base64: "data:image/png;base64,AAAA" });
    expect(toIdeaRequest(note(), { includeContext: true, snapshot: null }).snapshot_png_base64).toBeUndefined();
  });
});

describe("publishedLabel", () => {
  it("says when it went out, and nothing once it has been unpublished", () => {
    const p = { note_id: "n1", published: true, published_at: "2026-10-06T05:40:00Z", unpublished_at: null, destination_hint: "…7890", has_image: false };
    expect(publishedLabel(p)).toMatch(/^Published 6 Oct at /);
    expect(publishedLabel({ ...p, published: false, unpublished_at: "2026-10-06T06:00:00Z" })).toBeNull();
    expect(publishedLabel(undefined)).toBeNull();
  });
});

describe("deliveryNote and destinations", () => {
  it("explains how the post goes out", () => {
    expect(deliveryNote(1, false)).toBe("Sent as one message.");
    expect(deliveryNote(1, true)).toBe("Sent as one photo with this text as its caption.");
    expect(deliveryNote(2, true)).toBe("Sent as the chart image followed by this text.");
  });
  it("accepts a numeric id or a channel @name and nothing else", () => {
    for (const ok of ["-1001234567890", "123456789", "@my_ideas_channel", " @my_ideas_channel "]) expect(looksLikeDestination(ok)).toBe(true);
    for (const bad of ["", "hello", "12", "@ab", "https://t.me/x"]) expect(looksLikeDestination(bad)).toBe(false);
  });
});

// ---- attaching a closed trade ------------------------------------------------------------------------------------------------------

const pos = (over: Partial<Position> = {}): Position =>
  ({
    id: "p1", symbol: "NIFTY", exchange: "NSE", segment: "NSE", action: "BUY", horizon: null, instrument_type: "future", quantity: 75, entry_price: 23140.5, entry_time: "2026-10-05T04:00:00Z",
    exit_price: 23235, exit_time: "2026-10-05T09:30:00Z", pnl: 7087.5, status: "CLOSED", stop_loss_price: 23090, target_price: 23240, option_group_id: null, exit_reason: "target",
    trailing_stop_enabled: false, stop_loss_method: null, ...over,
  }) as Position;
const grp = (over: Partial<OptionGroup> = {}): OptionGroup =>
  ({
    id: "g1", underlying_symbol: "NIFTY", strategy_type: "bull_call_spread", action: "BUY", horizon: null, quantity: 75, net_debit: 100, combined_stop_loss_price: null, spot_stop_loss_price: 22950,
    spot_target_price: 23350, entry_spot_price: 23100, status: "CLOSED", pnl: 4650, entry_time: "2026-10-04T04:00:00Z", exit_time: "2026-10-04T09:00:00Z", segment: "NSE", exit_reason: "target", ...over,
  }) as OptionGroup;
const NIFTY = { segment: "NSE" as const, symbol: "NIFTY" };

describe("onInstrument", () => {
  it("matches the instrument and its contracts but not a different symbol that starts the same", () => {
    for (const ok of ["NIFTY", "nifty", "NIFTY-Oct2026-FUT", "NIFTY 23200 CE"]) expect(onInstrument(ok, "NIFTY")).toBe(true);
    for (const no of ["NIFTYBEES", "NIFTYIT", "BANKNIFTY", "NIFT"]) expect(onInstrument(no, "NIFTY")).toBe(false);
  });
});

describe("usableStop", () => {
  const base = { action: "BUY" as const, entry_price: 100, stop_loss_price: 95, trailing_stop_enabled: false, stop_loss_method: null };
  it("keeps a fixed stop on the losing side of the entry", () => {
    expect(usableStop(base)).toBe(95);
    expect(usableStop({ ...base, action: "SELL", stop_loss_price: 105 })).toBe(105);
  });
  it("drops a stop that was trailed, set by an indicator, missing, or has moved into profit", () => {
    expect(usableStop({ ...base, trailing_stop_enabled: true })).toBeNull();
    expect(usableStop({ ...base, stop_loss_method: "atr_trail" })).toBeNull();
    expect(usableStop({ ...base, stop_loss_price: null })).toBeNull();
    expect(usableStop({ ...base, stop_loss_price: 101 })).toBeNull(); // a BUY whose stop is above the entry has trailed into profit
    expect(usableStop({ ...base, action: "SELL", stop_loss_price: 99 })).toBeNull();
  });
});

describe("closedTradesFor", () => {
  it("offers only closed trades on the instrument, newest first, never an open one, a leg of a spread, or another symbol", () => {
    const trades = closedTradesFor(NIFTY, [pos(), pos({ id: "open", status: "OPEN", exit_price: null, exit_time: null }), pos({ id: "x", symbol: "NIFTYBEES" }), pos({ id: "leg", option_group_id: "g1" }), pos({ id: "mcx", segment: "MCX" })], [grp()]);
    expect(trades.map((t) => t.id)).toEqual(["p1", "g1"]); // the position closed on the 5th, the spread on the 4th
  });
  it("leaves out a position or spread with no way to say how it ended", () => {
    expect(closedTradesFor(NIFTY, [pos({ exit_price: null })], [grp({ pnl: null })])).toEqual([]);
    expect(closedTradesFor(NIFTY, [pos({ exit_time: null })], [grp({ exit_time: null })])).toEqual([]);
  });
  it("leaves out a spread bought for a credit, whose share of premium paid is undefined", () => {
    expect(closedTradesFor(NIFTY, [], [grp({ net_debit: -20 }), grp({ id: "zero", net_debit: 0 }), grp({ id: "none", net_debit: null })])).toEqual([]);
  });
  it("sends a position's levels and exit and nothing about its size or its rupee result", () => {
    const [t] = closedTradesFor(NIFTY, [pos()], []);
    expect(t.request).toEqual({ kind: "position", label: "NIFTY", side: "BUY", live: false, entry: 23140.5, stop: 23090, target: 23240, exit: 23235, exit_reason: "target", result_pct: null });
    expect(Object.keys(t.request).sort()).toEqual(["entry", "exit", "exit_reason", "kind", "label", "live", "result_pct", "side", "stop", "target"]);
    expect(t.summary).toBe("BUY NIFTY · closed 5 Oct · hit target · paper");
  });
  it("marks a live position live", () => {
    expect(closedTradesFor(NIFTY, [pos({ is_live_broker_order: true })], [])[0].request.live).toBe(true);
    expect(closedTradesFor(NIFTY, [pos({ is_live_broker_order: true })], [])[0].summary).toMatch(/· live$/);
  });
  it("works out a spread's result as a share of the premium paid, and never sends the quantity or the rupees", () => {
    const [t] = closedTradesFor(NIFTY, [], [grp()]);
    expect(t.request.result_pct).toBeCloseTo(62, 6); // 4650 / (100 x 75)
    expect(t.request).toMatchObject({ kind: "group", label: "NIFTY bull call spread", entry: 23100, stop: 22950, target: 23350, exit: null });
    expect(JSON.stringify(t.request)).not.toMatch(/4650|\b75\b/);
    expect(closedTradesFor(NIFTY, [], [grp({ pnl: -7500 })])[0].request.result_pct).toBeCloseTo(-100, 6);
  });
  it("calls a spread live when any of its legs was a real broker order", () => {
    const legs = [pos({ id: "l1", option_group_id: "g1", is_live_broker_order: false }), pos({ id: "l2", option_group_id: "g1", is_live_broker_order: true })];
    expect(closedTradesFor(NIFTY, legs, [grp()])[0].request.live).toBe(true);
    expect(closedTradesFor(NIFTY, [], [grp()])[0].request.live).toBe(false);
  });
  it("drops a spread's trailed stop", () => {
    expect(closedTradesFor(NIFTY, [], [grp({ spot_stop_loss_trailing_enabled: true })])[0].request.stop).toBeNull();
    expect(closedTradesFor(NIFTY, [], [grp({ spot_stop_loss_indicator_type: "supertrend" })])[0].request.stop).toBeNull();
  });
  it("shows only the latest fifteen", () => {
    const many = Array.from({ length: 20 }, (_, i) => pos({ id: `p${i}`, exit_time: `2026-09-${String(i + 1).padStart(2, "0")}T09:00:00Z` }));
    const out = closedTradesFor(NIFTY, many, []);
    expect(out).toHaveLength(15);
    expect(out[0].id).toBe("p19");
  });
});


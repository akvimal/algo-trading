import { describe, expect, it } from "vitest";
import type { NoteContext, StudyNote } from "../api/types";
import { canPublish, deliveryNote, looksLikeDestination, publishableContext, publishedLabel, toIdeaRequest } from "./ideasModel";

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

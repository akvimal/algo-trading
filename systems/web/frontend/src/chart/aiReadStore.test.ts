import { beforeEach, describe, expect, it } from "vitest";
import type { AiRead } from "../api/types";
import { AI_READ_MAX_AGE_MS, AI_READ_STALE_MS, isStaleRead, loadAiRead, saveAiRead } from "./aiReadStore";

const at = (iso: string): AiRead => ({
  underlying: "NIFTY", expiry: "2026-10-06", model: "m", generated_at: iso, bias: "neutral", confidence: 50, one_liner: "x",
  reasoning: [], support: [], resistance: [], risks: [], wait_for: "", data_gaps: [],
});
const T0 = Date.parse("2026-10-01T10:00:00+05:30");

beforeEach(() => localStorage.clear());

describe("aiReadStore", () => {
  it("round-trips a read", () => {
    saveAiRead("NSE:NIFTY:e", at("2026-10-01T10:00:00+05:30"));
    expect(loadAiRead("NSE:NIFTY:e", T0)?.one_liner).toBe("x");
    expect(loadAiRead("NSE:BANKNIFTY:e", T0)).toBeNull();
  });

  it("drops a read older than a day, and clears it", () => {
    saveAiRead("k", at("2026-10-01T10:00:00+05:30"));
    expect(loadAiRead("k", T0 + AI_READ_MAX_AGE_MS + 1)).toBeNull();
    expect(loadAiRead("k", T0)).toBeNull(); // it was removed, not just hidden
  });

  it("ignores corrupt storage instead of throwing", () => {
    localStorage.setItem("aiRead::k", "{not json");
    expect(loadAiRead("k", T0)).toBeNull();
    localStorage.setItem("aiRead::k", JSON.stringify({ hello: 1 }));
    expect(loadAiRead("k", T0)).toBeNull();
  });

  it("flags a read as stale after 30 minutes", () => {
    const read = at("2026-10-01T10:00:00+05:30");
    expect(isStaleRead(read, T0 + AI_READ_STALE_MS - 1)).toBe(false);
    expect(isStaleRead(read, T0 + AI_READ_STALE_MS + 1)).toBe(true);
  });
});

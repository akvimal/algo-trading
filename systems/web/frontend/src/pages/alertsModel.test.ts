import { describe, expect, it } from "vitest";
import type { PriceAlert } from "../api/priceAlerts";
import { alertStatus, describeAlert, looksLikeChatId, parsePrice, placementMessage, sortAlerts, toNewAlert, validateForm } from "./alertsModel";

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: "a1", exchange: "NSE", symbol: "NIFTY", target_price: 23100, direction: "above", note: null, repeat: false, active: true, last_side: "below",
  created_at: "2026-10-06T04:00:00Z", last_triggered_at: null, trigger_count: 0, delivery_failures: 0, last_error: null, ...over,
});

describe("describeAlert", () => {
  it("reads as a sentence for each direction", () => {
    expect(describeAlert(alert())).toBe("NIFTY goes above 23,100");
    expect(describeAlert(alert({ direction: "below", symbol: "GOLDM", target_price: 71000.5 }))).toBe("GOLDM goes below 71,000.5");
    expect(describeAlert(alert({ direction: "cross" }))).toBe("NIFTY crosses 23,100 either way");
  });
});

describe("alertStatus", () => {
  it("is watching while armed, and says how often a repeating one has fired", () => {
    expect(alertStatus(alert())).toEqual({ label: "Watching", tone: "", detail: null });
    expect(alertStatus(alert({ repeat: true, trigger_count: 1 }))).toEqual({ label: "Watching, repeats", tone: "", detail: "Has fired 1 time." });
    expect(alertStatus(alert({ repeat: true, trigger_count: 3 })).detail).toBe("Has fired 3 times.");
  });
  it("shows a crossing that could not be sent as a problem, not as fired, and says it will retry", () => {
    const s = alertStatus(alert({ delivery_failures: 2, last_error: "could not reach Telegram" }));
    expect(s.label).toBe("Could not send");
    expect(s.tone).toBe("dn");
    expect(s.detail).toBe("The price crossed, but the message failed 2 times: could not reach Telegram. It will try again.");
    expect(alertStatus(alert({ delivery_failures: 1, last_error: null })).detail).toBe("The price crossed, but the message failed once. It will try again.");
  });
  it("is fired once a one-shot alert has been delivered", () => {
    const s = alertStatus(alert({ active: false, trigger_count: 1, last_triggered_at: "2026-10-06T04:30:00Z" }));
    expect(s.label).toBe("Fired");
    expect(s.tone).toBe("up");
    expect(s.detail).toMatch(/^Sent 6 Oct at /);
  });
  it("is switched off, with the reason, after repeated failures", () => {
    const s = alertStatus(alert({ active: false, delivery_failures: 10, last_error: "switched off after 10 failed sends: the bot cannot message this chat" }));
    expect(s).toMatchObject({ label: "Switched off", tone: "dn" });
    expect(s.detail).toContain("the bot cannot message this chat");
  });
});

describe("the form", () => {
  it("parses a price with commas and rejects zero, negatives and words", () => {
    expect(parsePrice("23,100.50")).toBe(23100.5);
    expect(parsePrice(" 71000 ")).toBe(71000);
    for (const bad of ["", "0", "-5", "abc", "12abc"]) expect(parsePrice(bad)).toBeNaN();
  });
  it("asks for a symbol and a price", () => {
    expect(validateForm("", "")).toEqual({ symbol: "Enter the symbol, for example NIFTY.", price: "Enter a price above zero." });
    expect(validateForm("nifty", "23000")).toEqual({});
  });
  it("builds the request with an upper-case symbol and only a non-empty note", () => {
    const base = { exchange: "NSE", symbol: " nifty ", price: "23,100", direction: "cross" as const, note: "  ", repeat: true };
    expect(toNewAlert(base)).toEqual({ exchange: "NSE", symbol: "NIFTY", target_price: 23100, direction: "cross", repeat: true });
    expect(toNewAlert({ ...base, note: " range top " }).note).toBe("range top");
  });
  it("accepts a numeric Telegram chat id, including a group's negative one, and nothing else", () => {
    expect(looksLikeChatId("123456789")).toBe(true);
    expect(looksLikeChatId(" -1001234567890 ")).toBe(true);
    for (const bad of ["@somebody", "12", "abc123456", ""]) expect(looksLikeChatId(bad)).toBe(false);
  });
});

describe("sortAlerts", () => {
  it("puts armed alerts first, newest first within each group", () => {
    const sorted = sortAlerts([
      alert({ id: "old-done", active: false, created_at: "2026-10-01T00:00:00Z" }),
      alert({ id: "old-live", created_at: "2026-10-02T00:00:00Z" }),
      alert({ id: "new-done", active: false, created_at: "2026-10-05T00:00:00Z" }),
      alert({ id: "new-live", created_at: "2026-10-04T00:00:00Z" }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["new-live", "old-live", "new-done", "old-done"]);
  });
});

describe("placementMessage", () => {
  const a = (direction: PriceAlert["direction"], level = 85471) => ({ symbol: "BTCUSD", direction, target_price: level });

  it("says where the price is and how far the level is, for a crossing either way", () => {
    expect(placementMessage(a("cross"), 85478)).toBe("BTCUSD is 85,478 now. It fires when the price crosses 85,471 either way, 7 away (<0.01%).");
  });
  it("says when it will fire for a level the price has not reached yet", () => {
    expect(placementMessage(a("above"), 85400)).toBe("BTCUSD is 85,400 now. It fires when the price rises to 85,471, 71 away (0.08%).");
    expect(placementMessage(a("below"), 85500)).toBe("BTCUSD is 85,500 now. It fires when the price falls to 85,471, 29 away (0.03%).");
  });
  it("explains that a level the price is already past waits for it to cross back, which is what trips people up", () => {
    expect(placementMessage(a("above"), 85500)).toBe("BTCUSD is 85,500 now. It is already above 85,471, so this fires only after the price drops below it and then rises back through.");
    expect(placementMessage(a("below"), 85400)).toBe("BTCUSD is 85,400 now. It is already below 85,471, so this fires only after the price rises above it and then falls back through.");
  });
  it("shows a tiny distance as under 0.01% rather than 0.00%, and says so when the price is exactly on the level", () => {
    expect(placementMessage(a("cross", 1_000_000), 1_000_050)).toContain("50 away (<0.01%)");
    expect(placementMessage(a("cross"), 85471)).toContain("right at it");
  });
  it("still says something useful when the server gave no price", () => {
    expect(placementMessage(a("above"), null)).toBe("It will fire when the price crosses that level.");
    expect(placementMessage(a("above"), undefined)).toBe("It will fire when the price crosses that level.");
  });
});


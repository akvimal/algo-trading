import { describe, expect, it } from "vitest";
import { formatInr, formatInrCompact, formatPct, formatPnl, isToday, istDayKey, tone } from "./format";

describe("money formatting", () => {
  it("groups the Indian way", () => {
    expect(formatInr(1234567)).toBe("₹12,34,567");
    expect(formatInr(1000000, 2)).toBe("₹10,00,000.00");
  });

  it("uses a real minus sign for losses", () => {
    expect(formatInr(-1200)).toBe("−₹1,200");
  });

  it("always signs profit and loss, so colour never carries the meaning alone", () => {
    expect(formatPnl(1710)).toBe("+₹1,710");
    expect(formatPnl(-1200)).toBe("−₹1,200");
    expect(formatPnl(0)).toBe("₹0");
  });

  it("shows a dash for a missing number rather than 0 or NaN", () => {
    expect(formatPnl(null)).toBe("–");
    expect(formatInr(undefined)).toBe("–");
    expect(formatPnl(Number.NaN)).toBe("–");
  });

  it("compacts to lakh and crore", () => {
    expect(formatInrCompact(1042000)).toBe("₹10.42L");
    expect(formatInrCompact(12000000)).toBe("₹1.20Cr");
    expect(formatInrCompact(-250000)).toBe("−₹2.50L");
    expect(formatInrCompact(9500)).toBe("₹9,500");
  });

  it("formats percentages", () => {
    expect(formatPct(12.345, 1)).toBe("12.3%");
    expect(formatPct(2, 1, true)).toBe("+2.0%");
    expect(formatPct(-2, 1, true)).toBe("−2.0%");
  });

  it("classifies tone", () => {
    expect(tone(5)).toBe("up");
    expect(tone(-5)).toBe("dn");
    expect(tone(0)).toBe("flat");
    expect(tone(null)).toBe("flat");
  });
});

describe("IST trading day", () => {
  it("puts 20:00 UTC on the NEXT IST day", () => {
    // 2026-09-25 20:00 UTC = 2026-09-26 01:30 IST
    expect(istDayKey("2026-09-25T20:00:00Z")).toBe("2026-09-26");
  });

  it("decides today by IST, not UTC", () => {
    const now = new Date("2026-09-26T04:00:00Z"); // 09:30 IST on the 26th
    expect(isToday("2026-09-25T20:00:00Z", now)).toBe(true); // 01:30 IST on the 26th
    expect(isToday("2026-09-25T10:00:00Z", now)).toBe(false); // 15:30 IST on the 25th
    expect(isToday(null, now)).toBe(false);
  });
});

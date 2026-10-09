import { describe, expect, it } from "vitest";
import { expiryLook, refreshMessage } from "./platformTokenModel";

const NOW = Date.parse("2026-10-07T04:00:00Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

describe("expiryLook", () => {
  it("says there is no token when none is set", () => {
    expect(expiryLook(null, NOW)).toEqual({ text: "No token is set", tone: "dn" });
    expect(expiryLook(undefined, NOW).tone).toBe("dn");
  });

  it("is calm with plenty of time, and warns in the last three hours", () => {
    expect(expiryLook(at(20), NOW)).toMatchObject({ tone: "up", text: expect.stringContaining("Valid for 20h 00m") });
    expect(expiryLook(at(2.5), NOW)).toMatchObject({ tone: "warn", text: expect.stringContaining("Valid for 2h 30m") });
    expect(expiryLook(at(3), NOW).tone).toBe("up"); // exactly three hours is not yet a warning
    expect(expiryLook(at(0.75), NOW).text).toContain("Valid for 45m");
  });

  it("says how long ago it expired, in days when it is more than a day (the VPS case: five days)", () => {
    expect(expiryLook(at(-5 * 24 - 2), NOW)).toMatchObject({ tone: "dn", text: expect.stringContaining("Expired 5 days ago") });
    expect(expiryLook(at(-26), NOW).text).toContain("Expired 1 day ago");
    expect(expiryLook(at(-3), NOW).text).toMatch(/^Expired at /);
  });

  it("does not guess at an expiry it cannot read", () => {
    expect(expiryLook("not a date", NOW)).toEqual({ text: "Expiry unknown", tone: "warn" });
  });
});

describe("refreshMessage", () => {
  it("confirms an adoption", () => {
    expect(refreshMessage({ adopted: true })).toEqual({ text: "Now using the token saved above.", ok: true });
  });

  it("explains a refusal in the server's words, as a problem only when the person has something to fix", () => {
    expect(refreshMessage({ adopted: false, reason: "the token saved in Settings has already expired" })).toEqual({ text: "The token saved in Settings has already expired.", ok: false });
    expect(refreshMessage({ adopted: false, reason: "the platform owner has no Dhan token saved in Settings" }).ok).toBe(false);
    expect(refreshMessage({ adopted: false, reason: "the accounts service could not be reached" }).ok).toBe(false);
    expect(refreshMessage({ adopted: false, reason: "the token in use lasts as long or longer" }).ok).toBe(true); // nothing to fix: it is already fine
    expect(refreshMessage({ adopted: false }).text).toBe("Nothing changed.");
  });
});

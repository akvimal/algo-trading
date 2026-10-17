import { beforeEach, describe, expect, it } from "vitest";
import { TICKET_WIDTH, clampTicketWidth, loadTicketWidth, saveTicketWidth } from "./ticketWidth";

beforeEach(() => localStorage.clear());

describe("ticket panel width", () => {
  it("stays between the minimum and maximum, and within the room the page has", () => {
    expect(clampTicketWidth(100)).toBe(TICKET_WIDTH.min);
    expect(clampTicketWidth(5000)).toBe(TICKET_WIDTH.max);
    expect(clampTicketWidth(512.4)).toBe(512);
    expect(clampTicketWidth(700, 500)).toBe(500);
    expect(clampTicketWidth(700, 100)).toBe(TICKET_WIDTH.min); // a tiny page never squeezes it below usable
    expect(clampTicketWidth(Number.NaN)).toBe(TICKET_WIDTH.default);
  });

  it("is remembered between visits, and falls back to the default", () => {
    expect(loadTicketWidth()).toBe(TICKET_WIDTH.default);
    saveTicketWidth(560);
    expect(loadTicketWidth()).toBe(560);
    localStorage.setItem(TICKET_WIDTH.key, "99999");
    expect(loadTicketWidth()).toBe(TICKET_WIDTH.max);
    localStorage.setItem(TICKET_WIDTH.key, "junk");
    expect(loadTicketWidth()).toBe(TICKET_WIDTH.default);
  });
});

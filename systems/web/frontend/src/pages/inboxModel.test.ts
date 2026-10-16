import { describe, expect, it } from "vitest";
import type { InboxItem } from "../api/inbox";
import { arrange, badgeText, categoryLabel, safeLink } from "./inboxModel";

const item = (over: Partial<InboxItem>): InboxItem => ({ id: "1", kind: "event", category: "bot", severity: "info", title: "t", body: null, link: null, created_at: "2026-10-16T10:00:00Z", read: false, ...over });

describe("inboxModel", () => {
  it("shows the unread count on the bell up to 9, then 9+, and nothing at zero", () => {
    expect([0, 1, 9, 10, 40].map(badgeText)).toEqual(["", "1", "9", "9+", "9+"]);
  });

  it("names the known sources and falls back to a readable name for a new one", () => {
    expect(categoryLabel("oi_buildup")).toBe("OI alerts");
    expect(categoryLabel("some_new_thing")).toBe("some new thing");
  });

  it("only follows a path inside the app", () => {
    expect(safeLink("/portfolio?tab=review")).toBe("/portfolio?tab=review");
    expect(safeLink("https://evil.example")).toBeNull();
    expect(safeLink("//evil.example")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it("puts to-dos first and then the newest event", () => {
    const rows = arrange([item({ id: "old", created_at: "2026-10-15T10:00:00Z" }), item({ id: "new" }), item({ id: "todo", kind: "todo", created_at: "2026-10-01T10:00:00Z" })]);
    expect(rows.map((r) => r.id)).toEqual(["todo", "new", "old"]);
  });
});

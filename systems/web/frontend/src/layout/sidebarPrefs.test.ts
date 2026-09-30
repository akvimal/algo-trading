import { beforeEach, describe, expect, it } from "vitest";
import { loadSidebarChoice, saveSidebarChoice } from "./sidebarPrefs";

describe("loadSidebarChoice and saveSidebarChoice", () => {
  beforeEach(() => localStorage.clear());

  it("is null until the person has explicitly chosen", () => {
    expect(loadSidebarChoice()).toBeNull();
  });
  it("remembers an explicit choice, either way", () => {
    saveSidebarChoice(true);
    expect(loadSidebarChoice()).toBe(true);
    saveSidebarChoice(false);
    expect(loadSidebarChoice()).toBe(false);
  });
  it("treats anything but the exact saved value as unset", () => {
    localStorage.setItem("web.nav.collapsed", "yes");
    expect(loadSidebarChoice()).toBeNull();
  });
});

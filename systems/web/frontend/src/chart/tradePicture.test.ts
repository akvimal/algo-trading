import { describe, expect, it } from "vitest";
import { levelsLine, pictureSubtitle } from "./tradePicture";

describe("the levels a trade picture is labelled with", () => {
  it("lists entry, stop and target in that order, in rupee grouping", () => {
    expect(levelsLine({ entry: 1000, stop: 950, target: 1100 })).toBe("Entry 1,000 · Stop 950 · Target 1,100");
    expect(levelsLine({ entry: 123456.5, stop: 120000, target: 130000.25 })).toBe("Entry 1,23,456.5 · Stop 1,20,000 · Target 1,30,000.25");
  });

  it("leaves out whatever is not set", () => {
    expect(levelsLine({ entry: 1000, stop: null, target: undefined })).toBe("Entry 1,000");
    expect(levelsLine({ stop: 950, target: 1100 })).toBe("Stop 950 · Target 1,100");
    expect(levelsLine({})).toBe("");
  });

  it("keeps a level of zero (it is a price, not 'nothing')", () => {
    expect(levelsLine({ entry: 0 })).toBe("Entry 0");
  });
});

describe("the line under the picture's title", () => {
  const when = new Date(2026, 9, 12, 10, 30);
  it("says what the picture is, the levels in force, and when", () => {
    const line = pictureSubtitle("Plan at entry", { entry: 1000, stop: 950, target: 1100 }, when);
    expect(line.startsWith("Plan at entry · Entry 1,000 · Stop 950 · Target 1,100 · ")).toBe(true);
    expect(line).toMatch(/2026/);
  });

  it("has no empty gaps when there are no levels", () => {
    const line = pictureSubtitle("Update", {}, when);
    expect(line.startsWith("Update · ")).toBe(true);
    expect(line).not.toMatch(/·\s*·/);
  });
});

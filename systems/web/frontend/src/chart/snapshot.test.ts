import { describe, expect, it } from "vitest";
import { copyDataUrl, snapshotFileName, withDevicePixelRatio, wrapText } from "./snapshot";

// one pixel per character keeps the arithmetic obvious
const px = (s: string) => s.length;

describe("wrapText", () => {
  it("breaks at word boundaries within the width", () => {
    expect(wrapText("waiting for a retest of 22500", 12, px)).toEqual(["waiting for", "a retest of", "22500"]);
  });

  it("keeps the person's own line breaks and blank lines", () => {
    expect(wrapText("plan:\n\nbuy the dip", 40, px)).toEqual(["plan:", "", "buy the dip"]);
  });

  it("splits a word wider than the line instead of overflowing it", () => {
    const lines = wrapText("supercalifragilistic", 8, px);
    expect(lines.every((l) => l.length <= 8)).toBe(true);
    expect(lines.join("")).toBe("supercalifragilistic");
  });

  it("returns one empty line for empty text and does not loop on odd input", () => {
    expect(wrapText("", 10, px)).toEqual([""]);
    expect(wrapText("a", 0, px).join("")).toBe("a");
  });
});

describe("snapshotFileName", () => {
  it("says what it is and sorts by time", () => {
    expect(snapshotFileName("NIFTY", "5min", new Date(2026, 9, 1, 12, 10))).toBe("NIFTY-5min-2026-10-01-1210.png");
  });

  it("makes anything unsafe in a name harmless", () => {
    expect(snapshotFileName("GOLDM-05Oct2026-FUT", "15 min/x", new Date(2026, 0, 2, 3, 4))).toBe("GOLDM-05Oct2026-FUT-15_min_x-2026-01-02-0304.png");
    expect(snapshotFileName("///", "", new Date(2026, 0, 2, 3, 4))).toBe("chart-chart-2026-01-02-0304.png");
  });
});

describe("copyDataUrl", () => {
  it("says so when the browser cannot put an image on the clipboard", async () => {
    // jsdom has no ClipboardItem
    expect(await copyDataUrl("data:image/png;base64,AAAA")).toBe("unsupported");
  });
});

describe("withDevicePixelRatio", () => {
  it("reports the asked-for ratio inside, and the real one again after", () => {
    const real = window.devicePixelRatio;
    expect(withDevicePixelRatio(1, () => window.devicePixelRatio)).toBe(1);
    expect(withDevicePixelRatio(0.5, () => window.devicePixelRatio)).toBe(0.5);
    expect(window.devicePixelRatio).toBe(real);
  });

  it("puts the real ratio back even when the work throws", () => {
    const real = window.devicePixelRatio;
    expect(() =>
      withDevicePixelRatio(1, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(window.devicePixelRatio).toBe(real);
  });

  it("returns what the work returns", () => {
    expect(withDevicePixelRatio(1, () => "done")).toBe("done");
  });
});

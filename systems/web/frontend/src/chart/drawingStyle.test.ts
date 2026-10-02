import { describe, expect, it } from "vitest";
import { contrastInk, hexToRgba, mergeStyle, sanitizeStyle, styleKindOf, textLook, toOverlayStyles } from "./drawingStyle";

describe("styleKindOf", () => {
  it("separates zones and text from every kind of line", () => {
    expect(styleKindOf("rect")).toBe("zone");
    expect(styleKindOf("textNote")).toBe("text");
    for (const n of ["segment", "rayLine", "horizontalStraightLine", "priceLine", "parallelStraightLine", "fibonacciLine"]) expect(styleKindOf(n)).toBe("line");
  });
});

describe("sanitizeStyle", () => {
  it("keeps good values (a colour is lower-cased)", () => {
    expect(sanitizeStyle({ color: "#FFC83D", width: 3, dash: "dotted", fill: 0.3, textSize: 16, bold: false })).toEqual({ color: "#ffc83d", width: 3, dash: "dotted", fill: 0.3, textSize: 16, bold: false });
  });

  it("drops anything unknown or out of range instead of trusting it", () => {
    expect(sanitizeStyle({ color: "red", width: 9, dash: "wavy", fill: 0.99, textSize: 40, bold: "yes", extra: 1 })).toBeUndefined();
    expect(sanitizeStyle({ color: "#12345", width: 2 })).toEqual({ width: 2 });
  });

  it("gives nothing for what is not an object", () => {
    for (const v of [null, undefined, 5, "x", [1]]) expect(sanitizeStyle(v)).toBeUndefined();
  });
});

describe("mergeStyle", () => {
  it("puts the change on top of what was there", () => {
    expect(mergeStyle({ color: "#ffffff", width: 2 }, { color: "#e8586a" })).toEqual({ color: "#e8586a", width: 2 });
  });

  it("removes a field set to undefined, and is undefined once nothing is left", () => {
    expect(mergeStyle({ color: "#ffffff", width: 2 }, { width: undefined })).toEqual({ color: "#ffffff" });
    expect(mergeStyle({ width: 2 }, { width: undefined })).toBeUndefined();
  });

  it("starts from nothing", () => {
    expect(mergeStyle(undefined, { dash: "dashed" })).toEqual({ dash: "dashed" });
  });
});

describe("colour helpers", () => {
  it("turns a hex colour into rgba", () => {
    expect(hexToRgba("#ff9f43", 0.3)).toBe("rgba(255, 159, 67, 0.3)");
  });

  it("picks dark ink on a light colour and white on a dark one", () => {
    expect(contrastInk("#ffffff")).toBe("#0f1216");
    expect(contrastInk("#ffc83d")).toBe("#0f1216");
    expect(contrastInk("#000000")).toBe("#ffffff");
    expect(contrastInk("#4b2e83")).toBe("#ffffff");
  });
});

describe("toOverlayStyles", () => {
  it("is nothing for a drawing nobody restyled, so it keeps the chart's own look", () => {
    expect(toOverlayStyles("segment", undefined)).toBeUndefined();
  });

  it("maps a line's colour, thickness and dash - and colours the labels a line carries", () => {
    expect(toOverlayStyles("segment", { color: "#e8586a", width: 3, dash: "dashed" })).toEqual({
      line: { color: "#e8586a", size: 3, style: "dashed", dashedValue: [6, 4] },
      text: { color: "#e8586a" },
    });
    expect(toOverlayStyles("fibonacciLine", { dash: "dotted" })).toEqual({ line: { style: "dashed", dashedValue: [2, 3] } });
    expect(toOverlayStyles("priceLine", { dash: "solid", width: 1 })).toEqual({ line: { size: 1, style: "solid", dashedValue: [] } });
  });

  it("maps a zone to a translucent fill with a border", () => {
    expect(toOverlayStyles("rect", { color: "#3ecf8e", fill: 0.5, width: 2, dash: "dashed" })).toEqual({
      polygon: { style: "stroke_fill", color: "rgba(62, 207, 142, 0.5)", borderColor: "#3ecf8e", borderSize: 2, borderStyle: "dashed", borderDashedValue: [6, 4] },
    });
    expect(toOverlayStyles("rect", { width: 3 })).toMatchObject({ polygon: { color: "rgba(76, 194, 255, 0.15)", borderSize: 3 } }); // no colour chosen: the zone blue, light fill
  });

  it("is nothing for text, which is drawn by our own code", () => {
    expect(toOverlayStyles("textNote", { color: "#ffc83d" })).toBeUndefined();
  });
});

describe("textLook", () => {
  it("is the light label by default", () => {
    expect(textLook(undefined)).toEqual({ background: "#f4f6f8", ink: "#0f1216", size: 12, weight: "bold" });
  });

  it("follows the colour, with readable ink, the size and the weight", () => {
    expect(textLook({ color: "#4b2e83", textSize: 20, bold: false })).toEqual({ background: "#4b2e83", ink: "#ffffff", size: 20, weight: "normal" });
  });
});

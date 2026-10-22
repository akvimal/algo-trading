import { describe, expect, it } from "vitest";
import { addSymbol, hasSymbol, removeSymbol, symbolsOf } from "./watchlistModel";

describe("watchlist symbols", () => {
  it("reads a comma-separated list, trimmed and upper-cased", () => {
    expect(symbolsOf(" tcs, INFY ,,")).toEqual(["TCS", "INFY"]);
  });
  it("adds a symbol once", () => {
    expect(addSymbol("TCS", "infy")).toBe("TCS,INFY");
    expect(addSymbol("TCS,INFY", "tcs")).toBe("TCS,INFY");
  });
  it("removes a symbol, and says whether one is in", () => {
    expect(removeSymbol("TCS,INFY", "tcs")).toBe("INFY");
    expect(hasSymbol("TCS,INFY", "infy")).toBe(true);
    expect(hasSymbol("TCS", "infy")).toBe(false);
  });
});

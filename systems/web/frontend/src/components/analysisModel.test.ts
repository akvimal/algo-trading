
describe("isStockSymbol", () => {
  it("is true for a listed NSE stock and false for an index or another market", async () => {
    const { isStockSymbol } = await import("./analysisModel");
    expect(isStockSymbol("RELIANCE", "NSE")).toBe(true);
    expect(isStockSymbol("banknifty", "NSE")).toBe(false);
    expect(isStockSymbol("GOLDM", "MCX")).toBe(false);
  });
});

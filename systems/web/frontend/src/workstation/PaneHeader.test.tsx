import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneHeader } from "./PaneHeader";
import { INTERVALS, TRADE_INTERVALS } from "../chart/config";

// The price's own text changes on every tick (more digits, a comma appearing/disappearing, ...) -
// it has to sit where its own reflow cannot push anything else sideways, i.e. last in the row, with
// nothing after it. See base.css's .pane-price (margin-left: auto).

function header(price: number | null = 1000, priceShown = true) {
  return (
    <PaneHeader index={0} symbol="RELIANCE" interval="15min" onInterval={() => {}} price={price} priceShown={priceShown} live={false} regime={null} active showActive={false} />
  );
}

describe("PaneHeader", () => {
  it("puts the price last in the header row, after the candle-size buttons", () => {
    render(header());
    const panel = screen.getByTestId("price-0").closest(".pane-header")!;
    const children = [...panel.children];
    const priceIndex = children.findIndex((c) => c.contains(screen.getByTestId("price-0")));
    const chipsIndex = children.findIndex((c) => c.getAttribute("role") === "group");
    expect(priceIndex).toBeGreaterThan(chipsIndex);
    expect(priceIndex).toBe(children.length - 1); // nothing sits after it either
  });

  it("still shows the symbol, the price and the live dot", () => {
    render(header(1234.5));
    expect(screen.getByText("RELIANCE")).toBeInTheDocument();
    expect(screen.getByTestId("price-0")).toHaveTextContent("1,234.5");
    expect(screen.getByTestId("feed-0")).toBeInTheDocument();
  });

  it("hides the price (and its live dot) when priceShown is off, keeping the rest of the header", () => {
    render(header(1234.5, false));
    expect(screen.getByText("RELIANCE")).toBeInTheDocument();
    expect(screen.queryByTestId("price-0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feed-0")).not.toBeInTheDocument();
  });

  it("offers the trade view's candle sizes by default - without 30m, 1d or 1w", () => {
    render(header());
    for (const i of TRADE_INTERVALS) expect(screen.getByRole("button", { name: i.label })).toBeInTheDocument();
    expect(TRADE_INTERVALS.map((i) => i.label)).toEqual(["1m", "3m", "5m", "15m", "1h"]);
    for (const hidden of ["30m", "1d", "1w"]) expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
  });

  it("offers only a caller-given shorter list when one is passed (the Scan page's inline chart)", () => {
    render(<PaneHeader index={0} symbol="RELIANCE" interval="daily" onInterval={() => {}} price={1000} priceShown live={false} regime={null} active showActive={false} intervals={INTERVALS.filter((i) => ["15min", "daily", "weekly"].includes(i.value))} />);
    expect(screen.getByRole("button", { name: "1d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1w" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1m" })).not.toBeInTheDocument();
  });
});

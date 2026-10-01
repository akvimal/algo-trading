import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { PaneHeader } from "./PaneHeader";
import { DEFAULT_FAVORITE_INTERVALS, INTERVALS, favoriteIntervals } from "../chart/config";

// The price's own text changes on every tick (more digits, a comma appearing/disappearing, ...) -
// it has to sit where its own reflow cannot push anything else sideways, i.e. last in the row, with
// nothing after it. See base.css's .pane-price (margin-left: auto).

function header(price: number | null = 1000, priceShown = true) {
  return (
    <PaneHeader index={0} symbol="RELIANCE" interval="15min" onInterval={() => {}} price={price} priceShown={priceShown} live={false} regime={null} active showActive={false} />
  );
}

beforeEach(() => localStorage.clear());

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

  // only the quick buttons themselves: the Sizes menu, once open, holds every size inside the same group
  const quick = () => [...screen.getByRole("group", { name: /Candle size/ }).children].filter((c) => c.tagName === "BUTTON").map((b) => b.textContent);

  it("shows only the favourite candle sizes as buttons by default - not 30m, 1d or 1w", () => {
    render(header());
    expect(quick()).toEqual(["1m", "3m", "5m", "15m", "1h"]);
    expect(DEFAULT_FAVORITE_INTERVALS).toEqual(["1min", "3min", "5min", "15min", "60min"]);
  });

  it("lists every size in the Sizes menu, with a star on the favourites", async () => {
    render(header());
    await userEvent.setup().click(screen.getByRole("button", { name: /Sizes/ }));
    const menu = within(screen.getByRole("group", { name: "Sizes" }));
    for (const i of INTERVALS) expect(menu.getByRole("button", { name: i.label })).toBeInTheDocument();
    expect(menu.getByRole("button", { name: "Remove 5m from favourites" })).toHaveAttribute("aria-pressed", "true");
    expect(menu.getByRole("button", { name: "Add 30m to favourites" })).toHaveAttribute("aria-pressed", "false");
  });

  it("starring a size adds its button, keeps size order, and remembers it", async () => {
    const user = userEvent.setup();
    render(header());
    await user.click(screen.getByRole("button", { name: /Sizes/ }));
    await user.click(screen.getByRole("button", { name: "Add 30m to favourites" }));
    await user.click(screen.getByRole("button", { name: "Add 1d to favourites" }));
    expect(quick()).toEqual(["1m", "3m", "5m", "15m", "30m", "1h", "1d"]);
    expect(favoriteIntervals()).toEqual(["1min", "3min", "5min", "15min", "30min", "60min", "daily"]);
  });

  it("un-starring removes the button, but the last favourite can never be removed", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.favoriteIntervals", JSON.stringify(["5min", "15min"]));
    render(header());
    await user.click(screen.getByRole("button", { name: /Sizes/ }));
    await user.click(screen.getByRole("button", { name: "Remove 5m from favourites" }));
    expect(quick()).toEqual(["15m"]);
    expect(screen.getByRole("button", { name: "Remove 15m from favourites" })).toBeDisabled();
  });

  it("picking a size from the menu switches to it, and a size that is not a favourite is still shown while it is on screen", async () => {
    const picked: string[] = [];
    const user = userEvent.setup();
    const { rerender } = render(<PaneHeader index={0} symbol="X" interval="15min" onInterval={(v) => picked.push(v)} price={1} priceShown live={false} regime={null} active showActive={false} />);
    await user.click(screen.getByRole("button", { name: /Sizes/ }));
    await user.click(within(screen.getByRole("group", { name: "Sizes" })).getByRole("button", { name: "1w" }));
    expect(picked).toEqual(["weekly"]);
    rerender(<PaneHeader index={0} symbol="X" interval="weekly" onInterval={() => {}} price={1} priceShown live={false} regime={null} active showActive={false} />);
    expect(quick()).toEqual(["1m", "3m", "5m", "15m", "1h", "1w"]);
    const weekly = [...screen.getByRole("group", { name: /Candle size/ }).children].find((c) => c.tagName === "BUTTON" && c.textContent === "1w");
    expect(weekly).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to the defaults for an unreadable or empty saved list", () => {
    localStorage.setItem("web.chart.favoriteIntervals", "{broken");
    expect(favoriteIntervals()).toEqual(DEFAULT_FAVORITE_INTERVALS);
    localStorage.setItem("web.chart.favoriteIntervals", JSON.stringify(["bogus"]));
    expect(favoriteIntervals()).toEqual(DEFAULT_FAVORITE_INTERVALS);
  });

  it("offers only a caller-given shorter list when one is passed (the Scan page's inline chart), with no Sizes menu", () => {
    render(<PaneHeader index={0} symbol="RELIANCE" interval="daily" onInterval={() => {}} price={1000} priceShown live={false} regime={null} active showActive={false} intervals={INTERVALS.filter((i) => ["15min", "daily", "weekly"].includes(i.value))} />);
    expect(screen.getByRole("button", { name: "1d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1w" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1m" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sizes/ })).not.toBeInTheDocument();
  });
});

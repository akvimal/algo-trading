import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionCard } from "./PositionCard";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const position = () =>
  ({
    id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "positional", instrument_type: "spot", quantity: 10,
    entry_price: 1000, entry_time: "2026-10-12T04:00:00Z", exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 50,
    status: "OPEN", stop_loss_price: 950, target_price: 1100, option_group_id: null, trailing_stop_enabled: false,
  }) as never;

const group = () =>
  ({
    id: "g1", underlying_symbol: "NIFTY", segment: "NSE", action: "BUY", strategy_type: "naked_call", quantity: 2, unrealized_pnl: 120, status: "OPEN",
    spot_stop_loss_price: 22900, spot_target_price: 23200, entry_spot_price: 23000, entry_time: "2026-10-12T04:00:00Z", spot_stop_loss_trailing_enabled: false,
  }) as never;

let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/images")) return json([]);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const view = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("a trade's snapshots on its card", () => {
  it("are one tap away on a spot or future trade, and nothing is fetched until they are opened", async () => {
    const user = userEvent.setup();
    view(<PositionCard kind="position" item={position()} onChanged={() => undefined} />);
    expect(urls.some((u) => u.endsWith("/images"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Snapshots" }));
    expect(await screen.findByTestId("trade-snapshots")).toBeInTheDocument();
    expect(urls.some((u) => u.endsWith("/positions/p1/images"))).toBe(true);
    expect(screen.getByRole("button", { name: "Hide snapshots" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide snapshots" }));
    expect(screen.queryByTestId("trade-snapshots")).not.toBeInTheDocument();
  });

  it("are there on an option spread too, read from the spread's own route", async () => {
    const user = userEvent.setup();
    view(<PositionCard kind="group" item={group()} onChanged={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Snapshots" }));
    await screen.findByTestId("trade-snapshots");
    expect(urls.some((u) => u.endsWith("/option-groups/g1/images"))).toBe(true);
  });

  it("offer a new snapshot only where a chart is open for the instrument, taken with the levels the trade has now", async () => {
    const capture = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    view(<PositionCard kind="position" item={position()} onChanged={() => undefined} snapshotCapture={capture} />);
    await user.click(screen.getByRole("button", { name: "Snapshots" }));
    await user.click(await screen.findByRole("button", { name: "Save a snapshot of the chart now" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith("Update", { entry: 1000, stop: 950, target: 1100 }, ""));
  });

  it("use the underlying's levels for a spread", async () => {
    const capture = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    view(<PositionCard kind="group" item={group()} onChanged={() => undefined} snapshotCapture={capture} />);
    await user.click(screen.getByRole("button", { name: "Snapshots" }));
    await user.click(await screen.findByRole("button", { name: "Save a snapshot of the chart now" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith("Update", { entry: 23000, stop: 22900, target: 23200 }, ""));
  });

  it("without a chart (the Portfolio) point to the Trade page instead", async () => {
    const user = userEvent.setup();
    view(<PositionCard kind="position" item={position()} onChanged={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Snapshots" }));
    expect(await screen.findByRole("link", { name: "Trade page" })).toHaveAttribute("href", "/trade?symbol=RELIANCE&segment=NSE");
    expect(screen.queryByRole("button", { name: "Save a snapshot of the chart now" })).not.toBeInTheDocument();
  });
});

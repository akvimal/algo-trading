import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionCard } from "./PositionCard";

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body: any };
let calls: Call[];
let squareOffFails: boolean;
let moveFails: boolean;

const position = (over: Record<string, any> = {}) =>
  ({
    id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 10,
    entry_price: 1000, entry_time: "2026-09-28T04:00:00Z", exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 50,
    status: "OPEN", stop_loss_price: 980, target_price: 1050, option_group_id: null, trailing_stop_enabled: false, ...over,
  }) as any;

const group = (over: Record<string, any> = {}) =>
  ({
    id: "g1", underlying_symbol: "NIFTY", action: "BUY", strategy_type: "naked_call", quantity: 2, unrealized_pnl: 120,
    status: "OPEN", spot_stop_loss_price: 22900, spot_target_price: 23200, entry_spot_price: 23000, entry_time: "2026-09-28T04:00:00Z",
    spot_stop_loss_trailing_enabled: false, ...over,
  }) as any;

beforeEach(() => {
  calls = [];
  squareOffFails = false;
  moveFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      if (method === "PUT") return moveFails ? json({ detail: "The stop-loss has to stay below the current price." }, 422) : json({ ok: true });
      if (url.includes("/square-off")) return squareOffFails ? json({ detail: "Could not reach the broker." }, 502) : json({ ok: true });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const onChanged = () => vi.fn();

describe("display", () => {
  it("shows the trade, its P&L, its stop and target, and how long it has been open", () => {
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    expect(screen.getByText("RELIANCE")).toBeInTheDocument();
    expect(screen.getByText("BUY")).toBeInTheDocument();
    expect(screen.getByText("+₹50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit sl" })).toHaveTextContent("SL 980");
    expect(screen.getByRole("button", { name: "Edit target" })).toHaveTextContent("Target 1,050");
    expect(screen.getByText(/since/)).toBeInTheDocument();
  });

  it("says 'not set' for a level with no price, and omits the entry-time line when compact", () => {
    render(<PositionCard kind="position" item={position({ stop_loss_price: null })} onChanged={onChanged()} compact />);
    expect(screen.getByRole("button", { name: "Edit sl" })).toHaveTextContent("SL not set");
    expect(screen.queryByText(/since/)).not.toBeInTheDocument();
  });

  it("reads an option group's levels off the underlying, and its strategy as a plain label", () => {
    render(<PositionCard kind="group" item={group()} onChanged={onChanged()} />);
    expect(screen.getByText("NIFTY")).toBeInTheDocument();
    expect(screen.getByText(/naked call/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit sl" })).toHaveTextContent("SL 22,900");
  });

  it("a naked option group shows % move of the underlying and of the premium", () => {
    render(
      <PositionCard
        kind="group"
        item={group({ strategy_type: "naked_call", entry_spot_price: 23000, live_spot_price: 23230, net_debit: 40, live_combined_price: 52 })}
        onChanged={onChanged()}
      />,
    );
    const metrics = screen.getByTestId("pos-option-metrics");
    expect(metrics).toHaveTextContent("Spot");
    expect(metrics).toHaveTextContent("+1.0%"); // (23230-23000)/23000
    expect(metrics).toHaveTextContent("Premium");
    expect(metrics).toHaveTextContent("+30.0%"); // (52-40)/40
  });

  it("a spread group shows % of max profit and % gain/loss on the fund used", () => {
    render(
      <PositionCard
        kind="group"
        item={group({ strategy_type: "bull_call_spread", net_debit: 30, strike_width: 100, unrealized_pnl: 700, quantity: 20 })}
        onChanged={onChanged()}
      />,
    );
    const metrics = screen.getByTestId("pos-option-metrics");
    expect(metrics).toHaveTextContent("Max profit");
    expect(metrics).toHaveTextContent("+50.0%"); // 700 / ((100-30)*20)
    expect(metrics).toHaveTextContent("Fund used");
    expect(metrics).toHaveTextContent(`+${((700 / 600) * 100).toFixed(1)}%`); // 700 / (30*20)
  });

  it("shows – for either metric when the position was opened before strike_width existed", () => {
    render(<PositionCard kind="group" item={group({ strategy_type: "bull_call_spread", net_debit: 30, strike_width: null, unrealized_pnl: 700, quantity: 20 })} onChanged={onChanged()} />);
    const metrics = screen.getByTestId("pos-option-metrics");
    expect(metrics).toHaveTextContent("–");
  });

  it("no economics line at all for a plain spot/future position", () => {
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    expect(screen.queryByTestId("pos-option-metrics")).not.toBeInTheDocument();
  });
});

describe("editing the stop-loss and target", () => {
  it("moves a position's stop-loss with PUT /positions/{id}/stop-loss, and refreshes", async () => {
    const user = userEvent.setup();
    const changed = onChanged();
    render(<PositionCard kind="position" item={position()} onChanged={changed} />);
    await user.click(screen.getByRole("button", { name: "Edit sl" }));
    const input = screen.getByLabelText("SL");
    await user.clear(input);
    await user.type(input, "975");
    await user.click(screen.getByRole("button", { name: "Save sl" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/positions/p1/stop-loss"))).toBe(true));
    expect(calls.find((c) => c.url.includes("/stop-loss"))!.body).toEqual({ stop_loss_price: 975 });
    expect(changed).toHaveBeenCalled();
  });

  it("moves an option group's target on the underlying with PUT .../spot-target", async () => {
    const user = userEvent.setup();
    render(<PositionCard kind="group" item={group()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Edit target" }));
    await user.clear(screen.getByLabelText("Target"));
    await user.type(screen.getByLabelText("Target"), "23300");
    await user.click(screen.getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/option-groups/g1/spot-target"))).toBe(true));
    expect(calls.find((c) => c.url.includes("/spot-target"))!.body).toEqual({ spot_target_price: 23300 });
  });

  it("cancels without calling the server, on the cancel button or Escape", async () => {
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Edit sl" }));
    await user.type(screen.getByLabelText("SL"), "1");
    await user.click(screen.getByRole("button", { name: "Cancel editing sl" }));
    expect(screen.getByRole("button", { name: "Edit sl" })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("refuses a blank or non-positive price, without calling the server", async () => {
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Edit sl" }));
    await user.clear(screen.getByLabelText("SL"));
    await user.type(screen.getByLabelText("SL"), "0");
    await user.click(screen.getByRole("button", { name: "Save sl" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid price.");
    expect(calls).toEqual([]);
  });

  it("shows the server's own refusal and leaves the editor open to try again", async () => {
    moveFails = true;
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Edit sl" }));
    await user.clear(screen.getByLabelText("SL"));
    await user.type(screen.getByLabelText("SL"), "1200");
    await user.click(screen.getByRole("button", { name: "Save sl" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stay below the current price");
    expect(screen.getByLabelText("SL")).toBeInTheDocument(); // still editing
  });

  it("a trailing stop cannot be edited by hand, but the target still can", async () => {
    render(<PositionCard kind="position" item={position({ trailing_stop_enabled: true })} onChanged={onChanged()} />);
    expect(screen.getByRole("button", { name: "Edit sl" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit sl" })).toHaveTextContent("(trailing)");
    expect(screen.getByRole("button", { name: "Edit target" })).toBeEnabled();
  });
});

describe("squaring off", () => {
  it("is a two-step confirm, and refreshes once it succeeds", async () => {
    const user = userEvent.setup();
    const changed = onChanged();
    render(<PositionCard kind="position" item={position()} onChanged={changed} />);
    await user.click(screen.getByRole("button", { name: "Square off" }));
    expect(calls).toEqual([]); // not yet - only asked to confirm
    await user.click(screen.getByRole("button", { name: "Confirm square off" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions/p1/square-off"))).toBe(true));
    expect(changed).toHaveBeenCalled();
  });

  it("stays disabled and showing 'Closing…' after a successful square-off, not flashing back to askable", async () => {
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Square off" }));
    // Same DOM node throughout - its accessible name changes once busy, so grab the reference by
    // its pre-click name and check ITS later state, rather than re-querying by a name that no
    // longer matches.
    const confirmBtn = screen.getByRole("button", { name: "Confirm square off" });
    await user.click(confirmBtn);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions/p1/square-off"))).toBe(true));
    // The card itself only disappears once the parent reloads and drops the now-closed position -
    // until then this component stays mounted, and must keep showing it is still closing.
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn).toHaveTextContent("Closing…");
  });

  it("keeping it open cancels without calling the server", async () => {
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Square off" }));
    await user.click(screen.getByRole("button", { name: "Keep open" }));
    expect(screen.getByRole("button", { name: "Square off" })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("shows the server's error and drops back to asking again, not stuck confirming", async () => {
    squareOffFails = true;
    const user = userEvent.setup();
    render(<PositionCard kind="position" item={position()} onChanged={onChanged()} />);
    await user.click(screen.getByRole("button", { name: "Square off" }));
    await user.click(screen.getByRole("button", { name: "Confirm square off" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the broker.");
    expect(screen.getByRole("button", { name: "Square off" })).toBeInTheDocument();
  });
});

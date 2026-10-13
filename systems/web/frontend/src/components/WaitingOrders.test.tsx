import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WaitingOrders } from "./WaitingOrders";

const cancel = vi.fn();
let failWith: string | null = null; // a plain rejection: a rejecting vi.fn is reported by vitest as an unhandled error
vi.mock("../api/trade", () => ({
  cancelWaitingOrder: (id: string) => {
    cancel(id);
    return failWith ? Promise.reject(new Error(failWith)) : Promise.resolve({});
  },
}));

const order = { id: "w1", segment: "NSE", symbol: "ADANIGREEN", action: "SELL", strategy: "credit_spread", trigger_price: 1020.5, stop_loss_price: 1050, target_price: null, status: "pending", status_reason: null, expires_at: "", last_price: 1011, allow_stacking: false, quantity: 600, horizon: "positional" } as any;

describe("WaitingOrders", () => {
  beforeEach(() => {
    cancel.mockReset();
    failWith = null;
  });

  it("shows nothing when no order is waiting", () => {
    const { container } = render(<WaitingOrders orders={[]} onChanged={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a waiting order with its levels and cancels it, not squares it off", async () => {
    const onChanged = vi.fn();
    render(<WaitingOrders orders={[order]} onChanged={onChanged} />);
    const row = screen.getByTestId("waiting-order");
    expect(row).toHaveTextContent("ADANIGREEN");
    expect(row).toHaveTextContent("Credit spread");
    expect(row).toHaveTextContent("positional");
    expect(row).toHaveTextContent("qty 600");
    expect(screen.queryByRole("button", { name: /square off/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith("w1");
    expect(onChanged).toHaveBeenCalled();
  });

  it("says so when a cancel fails", async () => {
    failWith = "Already triggered";
    render(<WaitingOrders orders={[order]} onChanged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already triggered");
  });
});

describe("WaitingOrders legs", () => {
  it("lists the strikes and expiry a spread was armed with, or says they are chosen at the open", () => {
    const { rerender } = render(<WaitingOrders orders={[{ ...order, primary_strike: 1280, second_strike: 1320, expiry: "2026-10-27" }]} onChanged={() => {}} />);
    expect(screen.getByTestId("waiting-legs")).toHaveTextContent("strikes 1280 / 1320 · expiry 2026-10-27");
    rerender(<WaitingOrders orders={[{ ...order, moneyness: "OTM1" }]} onChanged={() => {}} />);
    expect(screen.getByTestId("waiting-legs")).toHaveTextContent("OTM1 strike chosen at the open · nearest expiry");
  });
});

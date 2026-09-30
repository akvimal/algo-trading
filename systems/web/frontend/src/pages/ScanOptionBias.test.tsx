import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScanOptionBias } from "./ScanOptionBias";
import { EMPTY_TICKET, type Ticket } from "./tradeModel";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const leg = (id: string, price: number, moneyness: "ITM" | "ATM" | "OTM") => ({ security_id: id, last_price: price, oi: 1000, moneyness });
// Deliberately ASYMMETRIC premiums (unlike ScanPage.test.tsx's own shared chainStrikes fixture,
// where ce-2400/pe-2600 and ce-2600/pe-2400 happen to carry the identical premium, which masked
// this exact bug there - see the regression test below for why that symmetry matters).
const strikes = [
  { strike: 400, ce: leg("c400", 32, "ITM"), pe: leg("p400", 1.5, "OTM") },
  { strike: 405, ce: leg("c405", 24, "ITM"), pe: leg("p405", 4, "OTM") },
  { strike: 410, ce: leg("c410", 17, "ITM"), pe: leg("p410", 6.2, "OTM") },
  { strike: 415, ce: leg("c415", 10, "ATM"), pe: leg("p415", 9.3, "ATM") },
  { strike: 420, ce: leg("c420", 8, "OTM"), pe: leg("p420", 12.4, "ITM") },
  { strike: 425, ce: leg("c425", 5.65, "OTM"), pe: leg("p425", 15.3, "ITM") },
  { strike: 430, ce: leg("c430", 3.2, "OTM"), pe: leg("p430", 18.6, "ITM") },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/options/expiries")) return json({ expiries: ["2026-10-27"] });
      if (url.includes("/options/chain")) return json({ underlying_symbol: "X", underlying_exchange: "NSE", expiry: "2026-10-27", underlying_last_price: 417, strikes });
      if (url.includes("/dhan/lot-size")) return json({ lot_size: 1 });
      return json({});
    }),
  );
});

function Harness({ initial }: { initial: Partial<Ticket> }) {
  const [t, setT] = useState<Ticket>({ ...EMPTY_TICKET, lots: "1", ...initial });
  return <ScanOptionBias exchange="NSE" symbol="X" ticket={t} onChange={setT} />;
}

describe("switching Debit <-> Credit re-derives BOTH strikes for the new side, and it sticks", () => {
  it("Bullish: debit (Buy 415 CE / Sell 425 CE) -> credit lands on Sell 415 PE / Buy 405 PE, not the old debit numbers relabelled", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ strategy: "naked", action: "BUY" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "Add a second leg to cap the risk" }));
    await waitFor(() => expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Bull Call Spread"));

    let table = within(screen.getByTestId("option-leg-table"));
    expect(table.getByRole("combobox", { name: "Primary leg strike" })).toHaveValue("415");
    expect(table.getByRole("combobox", { name: "Second leg strike" })).toHaveValue("425");

    await user.click(screen.getByRole("button", { name: "Receive premium (credit)" }));
    await waitFor(() => expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Bull Put Spread"));

    // Regression: a race between this reset and the combined stop-loss/target-% effect (both fire
    // in the same commit, both onChange({...t, ...}) off the same stale `t`) used to let the
    // stop/target effect's call win, silently reverting the strikes back to 415/425 - just
    // relabelled PE - with "Net debit" instead of "Net credit". Protected turnaround: the buy
    // (protective) leg must land BELOW the sell leg for a PE-based credit spread.
    await waitFor(() => {
      table = within(screen.getByTestId("option-leg-table"));
      expect(table.getByRole("combobox", { name: "Second leg strike" })).toHaveValue("405");
    });
    expect(table.getByRole("combobox", { name: "Primary leg strike" })).toHaveValue("415");
    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Sell")).toBeInTheDocument();
    expect(within(rows[0]).getByText("PE")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Buy")).toBeInTheDocument();
    expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Net credit");
    expect(screen.getByTestId("option-strategy-summary")).not.toHaveTextContent("Net debit");

    // The combined stop-loss/target-% pair (which raced with the reset) must itself settle
    // correctly too, not just the strikes - it depends on the SAME (now-correct) economics.
    expect(screen.getByLabelText("Stop-loss (% of max loss)")).toHaveValue(50);
    expect(screen.getByLabelText("Target (% of max profit)")).toHaveValue(70);
  });

  it("Bearish: credit (Sell 415 CE / Buy 425 CE, bear call) -> debit lands on Buy 415 PE / Sell 405 PE", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ strategy: "naked", action: "SELL" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "Add a second leg to cap the risk" }));
    await user.click(screen.getByRole("button", { name: "Receive premium (credit)" }));
    await waitFor(() => expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Bear Call Spread"));
    let table = within(screen.getByTestId("option-leg-table"));
    expect(table.getByRole("combobox", { name: "Primary leg strike" })).toHaveValue("415"); // Sell
    expect(table.getByRole("combobox", { name: "Second leg strike" })).toHaveValue("425"); // Buy, above - see item 5's own bug report

    await user.click(screen.getByRole("button", { name: "Pay premium (debit)" }));
    await waitFor(() => expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Bear Put Spread"));
    await waitFor(() => {
      table = within(screen.getByTestId("option-leg-table"));
      expect(table.getByRole("combobox", { name: "Second leg strike" })).toHaveValue("405");
    });
    expect(table.getByRole("combobox", { name: "Primary leg strike" })).toHaveValue("415");
    expect(screen.getByTestId("option-strategy-summary")).toHaveTextContent("Net debit");
  });
});

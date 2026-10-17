import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { OptionGroup, Position } from "../api/types";
import { TradeStages, plannedRR, readLine } from "./TradeStages";

const pos = (over: Partial<Position> = {}): Position => ({
  id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 10, entry_price: 1000,
  entry_time: "2026-10-17T04:00:00Z", exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 250, status: "OPEN", stop_loss_price: 990, target_price: 1030,
  option_group_id: null, setup_tag: "Pullback", confidence: 4, notes: "Retested the order block.",
  entry_context: { regime: "trending_up", trend: "up", adx: 31, person_read: "ranging", overridden: true }, ...over,
});

describe("what was recorded at entry", () => {
  it("says whether the system's read was followed or overridden", () => {
    expect(readLine({ regime: "trending_up", adx: 30.4 })).toBe("System read: Trending up (ADX 30). You followed it.");
    expect(readLine({ regime: "trending_up", person_read: "ranging", overridden: true })).toBe("System read: Trending up. You overrode it: Ranging.");
    expect(readLine({ person_read: "ranging" })).toBe("Your read: Ranging.");
    expect(readLine(null)).toMatch(/not recorded/);
  });

  it("works out the planned reward-to-risk from the levels", () => {
    expect(plannedRR({ entry_price: 1000, stop_loss_price: 990, target_price: 1030 })).toBe(3);
    expect(plannedRR({ entry_price: 1000, stop_loss_price: null, target_price: 1030 })).toBeNull();
    expect(plannedRR({ entry_price: 1000, stop_loss_price: 1000, target_price: 1030 })).toBeNull();
  });
});

describe("the open trade keeps its Study, Plan and Trade", () => {
  it("shows the recorded study and plan, and the open positions inside Trade", async () => {
    render(<TradeStages positions={[pos()]} groups={[]}><div data-testid="ticket-positions">the position card</div></TradeStages>);
    const study = within(screen.getByTestId("step-study"));
    expect(study.getByTestId("study-recorded")).toHaveTextContent("You overrode it: Ranging.");
    expect(study.getByTestId("study-recorded")).toHaveTextContent("Setup: Pullback · confidence 4 of 5");
    expect(study.getByTestId("study-recorded")).toHaveTextContent("Retested the order block.");
    const plan = within(screen.getByTestId("step-plan"));
    expect(plan.getByTestId("plan-recorded")).toHaveTextContent("Bought 10 RELIANCE at 1,000 · stop 990 · target 1,030 · 3.0 : 1");
    const trade = within(screen.getByTestId("step-trade"));
    expect(trade.getByTestId("ticket-positions")).toBeInTheDocument(); // the position lives inside Trade
    expect(trade.getByTestId("no-second-order")).toHaveTextContent("close it first");
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument(); // not the order form
  });

  it("summarises each step in its header, and folds Study and Plan one at a time", async () => {
    const user = userEvent.setup();
    render(<TradeStages positions={[pos({ stop_loss_price: null })]} groups={[]}><span /></TradeStages>);
    expect(screen.getByRole("button", { name: /Study/ })).toHaveTextContent("Pullback · 4/5");
    expect(screen.getByRole("button", { name: /Plan/ })).toHaveTextContent("stop missing");
    expect(screen.getByRole("button", { name: /Trade/ })).toHaveTextContent("1 open");
    expect(screen.getByRole("button", { name: /Study/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: /Study/ }));
    expect(screen.getByRole("button", { name: /Study/ })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: /Plan/ }));
    expect(screen.getByRole("button", { name: /Study/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Trade/ })).toHaveAttribute("aria-expanded", "true"); // Trade is always open
  });

  it("describes an option spread's plan, and notes when more than one trade is open", () => {
    const group = { id: "g1", underlying_symbol: "NIFTY", strategy_type: "bull_call_spread", action: "BUY", horizon: "intraday", quantity: 2, net_debit: 100, combined_stop_loss_price: null, spot_stop_loss_price: 23000, spot_target_price: 23400, status: "OPEN", pnl: null, entry_time: "2026-10-17T05:00:00Z", exit_time: null, unrealized_pnl: 10, setup_tag: "Breakout" } as OptionGroup;
    render(<TradeStages positions={[pos()]} groups={[group]}><span /></TradeStages>);
    expect(screen.getByTestId("plan-recorded")).toHaveTextContent("bull call spread on NIFTY, 2 lots · stop 23,000 · target 23,400");
    expect(screen.getByTestId("study-recorded")).toHaveTextContent("Setup: Breakout"); // the latest trade's setup
    expect(screen.getByTestId("study-recorded")).toHaveTextContent("Showing the latest of 2 open trades.");
  });
});

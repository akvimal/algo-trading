import { describe, expect, it } from "vitest";
import type { Account, OptionGroup, Position } from "../api/types";
import { dayPnl, inMode, lossBudget, openGroups, openPositions, paperBalance } from "./todayModel";

const NOW = new Date("2026-09-26T06:00:00Z"); // 11:30 IST, 26 Sep
const TODAY = "2026-09-26T05:00:00Z";
const YESTERDAY = "2026-09-25T05:00:00Z";

function pos(over: Partial<Position> = {}): Position {
  return {
    id: "p", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday",
    instrument_type: "spot", quantity: 10, entry_price: 100, entry_time: TODAY, exit_price: null, exit_time: null,
    pnl: null, status: "OPEN", stop_loss_price: null, target_price: null, option_group_id: null, ...over,
  };
}
function grp(over: Partial<OptionGroup> = {}): OptionGroup {
  return {
    id: "g", underlying_symbol: "NIFTY", strategy_type: "long_call", action: "BUY", horizon: "intraday", quantity: 1,
    net_debit: 100, combined_stop_loss_price: null, spot_stop_loss_price: null, spot_target_price: null,
    status: "OPEN", pnl: null, entry_time: TODAY, exit_time: null, ...over,
  };
}
function acct(over: Partial<Account> = {}): Account {
  return {
    segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0,
    capital_per_trade: 10000, max_daily_loss: null, live_trading_enabled: false, apply_charges: false,
    require_stop_loss: false, square_off_time: null, ...over,
  };
}

describe("dayPnl", () => {
  it("adds what closed today to what is open now", () => {
    const positions = [
      pos({ id: "a", status: "CLOSED", pnl: 500, exit_time: TODAY }),
      pos({ id: "b", status: "CLOSED", pnl: -200, exit_time: TODAY }),
      pos({ id: "c", status: "OPEN", unrealized_pnl: 150 }),
    ];
    const groups = [grp({ id: "g1", status: "CLOSED", pnl: 1000, exit_time: TODAY }), grp({ id: "g2", unrealized_pnl: -50 })];
    const r = dayPnl(positions, groups, NOW);
    expect(r.realized).toBe(1300);
    expect(r.unrealized).toBe(100);
    expect(r.total).toBe(1400);
    expect(r.closedToday).toBe(3);
  });

  it("ignores trades that closed on an earlier day", () => {
    const r = dayPnl([pos({ status: "CLOSED", pnl: 9999, exit_time: YESTERDAY })], [], NOW);
    expect(r.total).toBe(0);
    expect(r.closedToday).toBe(0);
  });

  it("never counts an option group's legs on top of the group itself", () => {
    const leg = pos({ id: "leg", option_group_id: "g1", status: "CLOSED", pnl: 700, exit_time: TODAY });
    const r = dayPnl([leg], [grp({ id: "g1", status: "CLOSED", pnl: 700, exit_time: TODAY })], NOW);
    expect(r.realized).toBe(700); // not 1400
  });

  it("treats a missing live P&L as zero, not NaN", () => {
    const r = dayPnl([pos({ unrealized_pnl: undefined })], [], NOW);
    expect(r.unrealized).toBe(0);
  });
});

describe("lossBudget", () => {
  it("is null when the person has set no daily loss limit", () => {
    expect(lossBudget([acct()], -500)).toBeNull();
  });

  it("sums the limits across segments and measures only losses", () => {
    const accounts = [acct({ max_daily_loss: 3000 }), acct({ segment: "MCX", max_daily_loss: 1000 })];
    expect(lossBudget(accounts, -1000)).toEqual({ limit: 4000, used: 1000, fraction: 0.25 });
    expect(lossBudget(accounts, 500)?.used).toBe(0); // a profitable day uses no budget
  });

  it("caps the bar at full", () => {
    expect(lossBudget([acct({ max_daily_loss: 1000 })], -5000)?.fraction).toBe(1);
  });
});

describe("filters", () => {
  it("open lists exclude closed trades and option legs", () => {
    const list = [pos({ id: "a" }), pos({ id: "b", status: "CLOSED" }), pos({ id: "c", option_group_id: "g" })];
    expect(openPositions(list).map((p) => p.id)).toEqual(["a"]);
    expect(openGroups([grp({ id: "x" }), grp({ id: "y", status: "CLOSED" })]).map((g) => g.id)).toEqual(["x"]);
  });

  it("splits intraday from positional and keeps options out of both", () => {
    expect(inMode(pos({ horizon: "intraday" }), "intraday")).toBe(true);
    expect(inMode(pos({ horizon: "intraday" }), "positional")).toBe(false);
    expect(inMode(pos({ horizon: "swing" }), "positional")).toBe(true);
    expect(inMode(pos({ instrument_type: "option" }), "intraday")).toBe(false);
  });
});

describe("paperBalance", () => {
  it("is cash plus open profit across segments", () => {
    expect(paperBalance([acct({ current_balance: 100, unrealized_pnl: 10 }), acct({ current_balance: 200, unrealized_pnl: -5 })])).toBe(305);
  });
});

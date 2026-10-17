import { describe, expect, it } from "vitest";
import type { Account, OptionGroup, Position } from "../api/types";
import { bookPnl, dayPnl, inBook, liveDeltaFor, lossBudget, openGroups, openPositions, openSummary, paperBalance, recentTrend, tapeStats, tradeTape } from "./todayModel";

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
    require_stop_loss: false, square_off_time: null, risk_per_trade_pct: 1, min_reward_risk_ratio: 2,
    enforce_risk_based_lots: false, slippage_bps: 0, max_order_value: null, live_trading_consent_at: null, ...over,
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

  it("splits the everyday book from the positional one by horizon, every instrument together", () => {
    expect(inBook("intraday", "intraday")).toBe(true);
    expect(inBook(null, "intraday")).toBe(true);
    expect(inBook("intraday", "positional")).toBe(false);
    expect(inBook("positional", "positional")).toBe(true);
    expect(inBook("positional", "intraday")).toBe(false);
  });
});

describe("paperBalance", () => {
  it("is cash plus open profit across segments", () => {
    expect(paperBalance([acct({ current_balance: 100, unrealized_pnl: 10 }), acct({ current_balance: 200, unrealized_pnl: -5 })])).toBe(305);
  });
});

describe("account cards", () => {
  const closedToday = (over: Partial<Position>) => pos({ status: "CLOSED", exit_time: TODAY, ...over });

  it("an account's whole day is what its loss limit is measured against", () => {
    const positions = [closedToday({ id: "i", pnl: -300 }), closedToday({ id: "h", pnl: -40, horizon: "positional" })];
    const groups = [grp({ id: "g", status: "CLOSED", pnl: -100, exit_time: TODAY, segment: "NSE" })];
    expect(bookPnl(positions, groups, "NSE", "intraday", NOW).total).toBe(-400);
    expect(bookPnl(positions, groups, "NSE", "positional", NOW).total).toBe(-40);
  });

  it("live movement is counted per account and book", () => {
    const before = [pos({ id: "a", unrealized_pnl: 50 }), pos({ id: "b", unrealized_pnl: 10, horizon: "positional" })];
    const live = [pos({ id: "a", unrealized_pnl: 300 }), pos({ id: "b", unrealized_pnl: 25, horizon: "positional" })];
    expect(liveDeltaFor(before, live, "NSE", "intraday")).toBe(250);
    expect(liveDeltaFor(before, live, "NSE", "positional")).toBe(15);
    expect(liveDeltaFor(before, live, "MCX", "intraday")).toBe(0);
  });

  it("the trend is the last nine day-ends plus the balance now, and today's stored point gives way to the live one", () => {
    const point = (d: string, equity: number) => ({ snapshot_date: d, balance: equity, unrealized_pnl: 0, equity, is_reset_point: false });
    const days = Array.from({ length: 12 }, (_, i) => point(`2026-09-${String(10 + i).padStart(2, "0")}`, 100 + i));
    expect(recentTrend(days.slice(0, 11), 999, 10, NOW)).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 999]);
    const withToday = recentTrend([...days, point("2026-09-26", 555)], 999, 10, NOW);
    expect(withToday).not.toContain(555); // 26 Sep is today: the live balance stands in for it
    expect(withToday[withToday.length - 2]).toBe(111);
    expect(recentTrend([], 500, 10, NOW)).toEqual([500]);
  });
});

describe("the day's tape", () => {
  const closedAt = (id: string, pnl: number, hour: number, over: Partial<Position> = {}) => pos({ id, status: "CLOSED", pnl, exit_time: `2026-09-26T0${hour}:00:00Z`, ...over });
  const NSE = ["NSE"] as const;

  it("lists what closed today by exit time, then what is open now, with an option group once", () => {
    const positions = [
      closedAt("late", -40, 5), closedAt("early", 100, 3), closedAt("old", 9, 3, { exit_time: YESTERDAY }),
      pos({ id: "open", unrealized_pnl: 25 }), pos({ id: "leg", option_group_id: "g1", status: "CLOSED", pnl: 1, exit_time: TODAY }),
    ];
    const groups = [grp({ id: "g1", status: "CLOSED", pnl: 60, exit_time: "2026-09-26T04:00:00Z", segment: "NSE" })];
    expect(tradeTape(positions, groups, "intraday", [...NSE], NOW).map((t) => t.id)).toEqual(["early", "g1", "late", "open"]);
  });

  it("keeps to the book and the markets chosen", () => {
    const positions = [closedAt("a", 10, 3), closedAt("h", 20, 3, { horizon: "positional" }), closedAt("m", 30, 3, { segment: "MCX" })];
    expect(tradeTape(positions, [], "intraday", ["NSE"], NOW).map((t) => t.id)).toEqual(["a"]);
    expect(tradeTape(positions, [], "positional", ["NSE"], NOW).map((t) => t.id)).toEqual(["h"]);
    expect(tradeTape(positions, [], "intraday", ["NSE", "MCX"], NOW).map((t) => t.id).sort()).toEqual(["a", "m"]);
  });

  it("works out win rate, best, worst, the current run and the open result", () => {
    const tape = tradeTape([closedAt("1", -50, 1), closedAt("2", 200, 2), closedAt("3", 80, 3), closedAt("4", 0, 4), pos({ id: "o", unrealized_pnl: 15 })], [], "intraday", ["NSE"], NOW);
    const s = tapeStats(tape);
    expect(s).toMatchObject({ closed: 4, open: 1, wins: 2, losses: 1, best: 200, worst: -50, openPnl: 15 });
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.streak).toBeNull(); // the latest closed trade was flat
    expect(tapeStats(tradeTape([closedAt("a", -5, 1), closedAt("b", 10, 2), closedAt("c", 20, 3)], [], "intraday", ["NSE"], NOW)).streak).toEqual({ kind: "win", n: 2 });
    expect(tapeStats([]).winRate).toBeNull();
  });

  it("summarises what is open: how many, the live result, and how many have no stop", () => {
    const positions = [pos({ id: "a", unrealized_pnl: 30, stop_loss_price: 95 }), pos({ id: "b", unrealized_pnl: -10 }), pos({ id: "c", segment: "MCX", unrealized_pnl: 999 })];
    const groups = [grp({ id: "g", unrealized_pnl: 5, spot_stop_loss_price: 100 }), grp({ id: "h", unrealized_pnl: 5 })];
    expect(openSummary(positions, groups, "intraday", ["NSE"])).toEqual({ count: 4, pnl: 30, noStop: 2 });
    expect(openSummary(positions, groups, "positional", ["NSE"])).toEqual({ count: 0, pnl: 0, noStop: 0 });
  });
});

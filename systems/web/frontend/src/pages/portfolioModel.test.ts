import { describe, expect, it } from "vitest";
import type { EquityPoint, LiveEligibility, OptionGroup, Position } from "../api/types";
import { bySetup, closedTrades, curveChange, disciplineBand, fillEquityCurve, graduation, unreviewed } from "./portfolioModel";

function pt(date: string, equity: number, reset = false): EquityPoint {
  return { snapshot_date: date, balance: equity, unrealized_pnl: 0, equity, is_reset_point: reset };
}

describe("fillEquityCurve", () => {
  it("carries the last value across days with no snapshot", () => {
    const curve = fillEquityCurve([pt("2026-09-01", 100), pt("2026-09-04", 110)]);
    expect(curve.map((c) => c.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(curve.map((c) => c.equity)).toEqual([100, 100, 100, 110]);
  });

  it("drops anything before the latest reset: it belongs to an earlier account life", () => {
    const curve = fillEquityCurve([pt("2026-08-20", 500), pt("2026-09-02", 200, true), pt("2026-09-03", 210)], "2026-09-02");
    expect(curve[0]).toEqual({ date: "2026-09-02", equity: 200 });
    expect(curve.some((c) => c.equity === 500)).toBe(false);
  });

  it("can extend the last value through today", () => {
    const curve = fillEquityCurve([pt("2026-09-01", 100)], null, "2026-09-03");
    expect(curve).toHaveLength(3);
    expect(curve[2].equity).toBe(100);
  });

  it("handles month ends and an unsorted input", () => {
    const curve = fillEquityCurve([pt("2026-10-01", 3), pt("2026-09-29", 1)]);
    expect(curve.map((c) => c.date)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("is empty for no data", () => {
    expect(fillEquityCurve([])).toEqual([]);
  });
});

describe("curveChange", () => {
  it("is latest against baseline, and null without stats", () => {
    const stats = { since: "2026-09-01", baseline: 200000, latest_equity: 205000, return_pct: 2.5, peak_equity: 206000, max_drawdown_pct: 1, days_tracked: 5, points: 5 };
    expect(curveChange(stats)).toEqual({ amount: 5000, pct: 2.5 });
    expect(curveChange(null)).toBeNull();
  });
});

function pos(over: Partial<Position> = {}): Position {
  return {
    id: "p", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 1,
    entry_price: 100, entry_time: "2026-09-26T04:00:00Z", exit_price: 110, exit_time: "2026-09-26T05:00:00Z", pnl: 10, status: "CLOSED",
    stop_loss_price: null, target_price: null, option_group_id: null, ...over,
  };
}
function grp(over: Partial<OptionGroup> = {}): OptionGroup {
  return {
    id: "g", underlying_symbol: "NIFTY", strategy_type: "long_call", action: "BUY", horizon: "intraday", quantity: 1, net_debit: 1,
    combined_stop_loss_price: null, spot_stop_loss_price: null, spot_target_price: null, status: "CLOSED", pnl: 100,
    entry_time: "2026-09-26T04:00:00Z", exit_time: "2026-09-26T06:00:00Z", ...over,
  };
}

describe("closedTrades", () => {
  it("counts an option group once and never lists its legs", () => {
    const leg = pos({ id: "leg", option_group_id: "g", pnl: 100 });
    const trades = closedTrades([leg, pos({ id: "a" })], [grp()]);
    expect(trades.map((t) => t.id).sort()).toEqual(["a", "g"]);
  });

  it("excludes open and rejected rows, newest first", () => {
    const trades = closedTrades(
      [pos({ id: "old", exit_time: "2026-09-25T05:00:00Z" }), pos({ id: "open", status: "OPEN", exit_time: null }), pos({ id: "rej", status: "REJECTED", exit_time: null }), pos({ id: "new", exit_time: "2026-09-26T09:00:00Z" })],
      [],
    );
    expect(trades.map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("treats a missing pnl as zero, not NaN", () => {
    expect(closedTrades([pos({ pnl: null })], [])[0].pnl).toBe(0);
  });
});

describe("bySetup", () => {
  it("groups by tag, most traded first, untagged kept honest", () => {
    const trades = closedTrades(
      [
        pos({ id: "1", setup_tag: "Breakout", pnl: 100 }),
        pos({ id: "2", setup_tag: "Breakout", pnl: -50 }),
        pos({ id: "3", setup_tag: "Breakout", pnl: 30 }),
        pos({ id: "4", setup_tag: null, pnl: -20 }),
        pos({ id: "5", setup_tag: "  ", pnl: -40 }),
      ],
      [],
    );
    const rows = bySetup(trades);
    expect(rows.map((r) => r.tag)).toEqual(["Breakout", "Untagged"]);
    expect(rows[0]).toMatchObject({ trades: 3, totalPnl: 80 });
    expect(rows[0].winRatePct).toBeCloseTo(66.67, 1);
    expect(rows[1]).toMatchObject({ trades: 2, avgPnl: -30, winRatePct: 0 });
  });
});

describe("unreviewed", () => {
  it("does not blame the person for automated fills, or for reviews already done", () => {
    const trades = closedTrades(
      [pos({ id: "a", reviewed_at: null }), pos({ id: "b", reviewed_at: "2026-09-26T07:00:00Z" }), pos({ id: "c", reviewed_at: null, auto_traded: true })],
      [],
    );
    expect(unreviewed(trades).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("graduation and discipline band", () => {
  const elig: LiveEligibility = {
    segment: "NSE", enforced: false, eligible: false,
    requirements: [
      { key: "trades", label: "Costed trades", required: "30", actual: "22", met: false },
      { key: "days", label: "Days", required: "14", actual: "20", met: true },
    ],
  };

  it("counts met requirements and lists what is missing", () => {
    const g = graduation(elig);
    expect(g).toMatchObject({ met: 1, total: 2, enforced: false });
    expect(g.unmet.map((r) => r.key)).toEqual(["trades"]);
  });

  it("bands the score, and null is not low", () => {
    expect(disciplineBand(null)).toBe("none");
    expect(disciplineBand(80)).toBe("good");
    expect(disciplineBand(60)).toBe("fair");
    expect(disciplineBand(10)).toBe("low");
  });
});

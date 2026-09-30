import { describe, expect, it } from "vitest";
import type { OptionGroup, Position } from "../api/types";
import { accountPatch, deriveRules, firstWeek, firstWeekDone, parseCapital, suggestExperience } from "./onboardingModel";

describe("suggestExperience", () => {
  it("suggests Guided to beginners and Pro only to people who already trade regularly", () => {
    expect(suggestExperience("new")).toBe("guided");
    expect(suggestExperience("some")).toBe("guided");
    expect(suggestExperience("regular")).toBe("pro");
  });
});

describe("parseCapital", () => {
  it("reads whole rupees, with commas, spaces and a rupee sign", () => {
    expect(parseCapital("500000")).toBe(500000);
    expect(parseCapital("₹5,00,000")).toBe(500000);
    expect(parseCapital(" 1 000 000 ")).toBe(1000000);
  });

  it("rejects anything unusable, including too little or too much", () => {
    for (const bad of ["", "abc", "10.5", "-5000", "9999", "100000001", "5e5"]) expect(parseCapital(bad)).toBeNull();
    expect(parseCapital("10000")).toBe(10000);
    expect(parseCapital("100000000")).toBe(100000000);
  });
});

describe("deriveRules", () => {
  it("works the rules out from the capital", () => {
    expect(deriveRules(500_000)).toEqual({ capitalPerTrade: 50_000, riskPct: 1, minRewardRisk: 2, dailyLossLimit: 10_000, slippageBps: 5 });
    expect(deriveRules(1_000_000).capitalPerTrade).toBe(100_000);
  });

  it("rounds to tidy amounts and never returns zero for a small account", () => {
    const r = deriveRules(12_345);
    expect(r.capitalPerTrade).toBe(1000);
    expect(r.dailyLossLimit).toBe(500);
  });

  it("keeps a bad day survivable: the daily limit is a small share of the account", () => {
    const r = deriveRules(750_000);
    expect(r.dailyLossLimit / 750_000).toBeLessThanOrEqual(0.03);
    expect(r.capitalPerTrade / 750_000).toBeLessThanOrEqual(0.11);
  });
});

describe("accountPatch", () => {
  const rules = deriveRules(500_000);

  it("sets the balance, the rules, a required stop-loss, and costs on", () => {
    expect(accountPatch("NSE", 500_000, rules)).toEqual({
      starting_balance: 500_000, capital_per_trade: 50_000, risk_per_trade_pct: 1, min_reward_risk_ratio: 2, max_daily_loss: 10_000,
      require_stop_loss: true, slippage_bps: 5, apply_charges: true,
    });
  });

  it("does not send the Indian-charges switch for crypto, which has none", () => {
    expect("apply_charges" in accountPatch("CRYPTO", 500_000, rules)).toBe(false);
    expect("apply_charges" in accountPatch("MCX", 500_000, rules)).toBe(true);
  });
});

describe("firstWeek", () => {
  const pos = (over: Partial<Position> = {}): Position => ({
    id: "p", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 1,
    entry_price: 1, entry_time: "2026-09-26T03:00:00Z", exit_price: null, exit_time: null, pnl: null, status: "OPEN",
    stop_loss_price: null, target_price: null, option_group_id: null, ...over,
  });
  const grp = (over: Partial<OptionGroup> = {}): OptionGroup => ({
    id: "g", underlying_symbol: "NIFTY", strategy_type: "naked_call", action: "BUY", horizon: "intraday", quantity: 1, net_debit: 1,
    combined_stop_loss_price: null, spot_stop_loss_price: null, spot_target_price: null, status: "OPEN", pnl: null,
    entry_time: "2026-09-26T03:00:00Z", exit_time: null, ...over,
  });
  const done = (steps: ReturnType<typeof firstWeek>) => Object.fromEntries(steps.map((s) => [s.id, s.done]));

  it("starts with nothing done for someone who has not traded", () => {
    expect(done(firstWeek([], []))).toEqual({ planned: false, why: false, review: false });
  });

  it("notices a trade placed with a stop-loss, but not one without", () => {
    expect(done(firstWeek([pos()], [])).planned).toBe(false);
    expect(done(firstWeek([pos({ stop_loss_price: 990 })], [])).planned).toBe(true);
    expect(done(firstWeek([], [grp({ spot_stop_loss_price: 22900 })])).planned).toBe(true);
  });

  it("notices a reason written down (a tag or a note) and a review done", () => {
    expect(done(firstWeek([pos({ setup_tag: "Breakout" })], [])).why).toBe(true);
    expect(done(firstWeek([pos({ notes: "chased it" })], [])).why).toBe(true);
    expect(done(firstWeek([pos({ setup_tag: "  ", notes: "" })], [])).why).toBe(false);
    expect(done(firstWeek([pos({ status: "CLOSED", reviewed_at: "2026-09-26T07:00:00Z" })], [])).review).toBe(true);
  });

  it("never counts an option leg or a rejected order as the person's own trade", () => {
    const leg = pos({ option_group_id: "g", stop_loss_price: 1, setup_tag: "Breakout" });
    const rejected = pos({ status: "REJECTED", stop_loss_price: 1 });
    expect(done(firstWeek([leg, rejected], []))).toEqual({ planned: false, why: false, review: false });
  });

  it("counts what is done", () => {
    expect(firstWeekDone(firstWeek([pos({ stop_loss_price: 1, setup_tag: "News" })], []))).toBe(2);
  });
});

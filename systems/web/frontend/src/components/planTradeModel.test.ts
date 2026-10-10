import { describe, expect, it } from "vitest";
import { EMPTY_PLAN, buildPlanOrder, canTradePlan, planProblem, planRewardRisk, tradeStatusText, type PlanForm } from "./planTradeModel";
import type { NoteTrade } from "../api/planTrade";

const note = { id: "n1", segment: "NSE" as const, symbol: "RELIANCE", text: "Pullback to the 50 DMA, buy the bounce", interval: "daily" };
const plan = (over: Partial<PlanForm> = {}): PlanForm => ({ ...EMPTY_PLAN, stop: "95", target: "120", ...over });

describe("which notes can be traded", () => {
  it("only plan notes, and not on MCX (no spot there)", () => {
    expect(canTradePlan({ tag: "plan", segment: "NSE" })).toBe(true);
    expect(canTradePlan({ tag: "plan", segment: "CRYPTO" })).toBe(true);
    expect(canTradePlan({ tag: "plan", segment: "MCX" })).toBe(false);
    expect(canTradePlan({ tag: "observation", segment: "NSE" })).toBe(false);
    expect(canTradePlan({ tag: null, segment: "NSE" })).toBe(false);
  });
});

describe("checking the plan", () => {
  it("a market plan needs a live price, a stop below it, and a target above it", () => {
    expect(planProblem(plan(), 100)).toBeNull();
    expect(planProblem(plan(), null)).toMatch(/no live price/i);
    expect(planProblem(plan({ stop: "" }), 100)).toMatch(/stop-loss/i);
    expect(planProblem(plan({ stop: "101" }), 100)).toMatch(/below the entry/i);
    expect(planProblem(plan({ target: "99" }), 100)).toMatch(/above the entry/i);
    expect(planProblem(plan({ target: "" }), 100)).toBeNull(); // a target is optional
  });

  it("a limit plan is judged against its own price, not the live one", () => {
    expect(planProblem(plan({ entryType: "limit", limitPrice: "" }), 100)).toMatch(/price you want/i);
    expect(planProblem(plan({ entryType: "limit", limitPrice: "90", stop: "85", target: "110" }), 100)).toBeNull();
    expect(planProblem(plan({ entryType: "limit", limitPrice: "90", stop: "92" }), 100)).toMatch(/below the entry/i);
    expect(planProblem(plan({ entryType: "limit", limitPrice: "100" }), 100)).toMatch(/market entry/i);
  });

  it("rejects numbers that are not numbers", () => {
    expect(planProblem(plan({ stop: "abc" }), 100)).toMatch(/valid stop-loss/i);
    expect(planProblem(plan({ quantity: "-5" }), 100)).toMatch(/valid quantity/i);
  });

  it("reward over risk", () => {
    expect(planRewardRisk(plan({ entryType: "limit", limitPrice: "100", stop: "95", target: "115" }), null)).toBe(3);
    expect(planRewardRisk(plan({ target: "" }), 100)).toBeNull();
    expect(planRewardRisk(plan({ stop: "101" }), 100)).toBeNull();
  });
});

describe("the order a plan places", () => {
  it("a market entry opens a positional spot position at the live price, linked to the note, with the note's words as its journal", () => {
    const o = buildPlanOrder(note, plan(), 100);
    expect(o.kind).toBe("market");
    expect(o.body).toMatchObject({
      segment: "NSE", symbol: "RELIANCE", action: "BUY", instrument_type: "spot", horizon: "positional", price: 100, order_type: "market",
      stop_loss_price: 95, target_price: 120, source_note_id: "n1", risk_managed: true, entry_interval: "daily", notes: note.text,
    });
    expect(o.body).not.toHaveProperty("quantity"); // sized by risk on the server
  });

  it("a limit entry arms a waiting positional spot order for the chosen number of days", () => {
    const o = buildPlanOrder(note, plan({ entryType: "limit", limitPrice: "90", stop: "85", days: 3 }), 100);
    expect(o.kind).toBe("limit");
    expect(o.body).toMatchObject({ strategy: "spot", horizon: "positional", trigger_price: 90, stop_loss_price: 85, source_note_id: "n1", expires_in_minutes: 4320 });
  });

  it("an explicit quantity is sent and the order is not marked risk-managed", () => {
    const o = buildPlanOrder(note, plan({ quantity: "7" }), 100);
    expect(o.body).toMatchObject({ quantity: 7, risk_managed: false });
  });

  it("leaves out a target that was not given", () => {
    expect(buildPlanOrder(note, plan({ target: "" }), 100).body).not.toHaveProperty("target_price");
  });
});

describe("the status line", () => {
  const fmt = (n: number) => String(n);
  const trade = (over: Partial<NoteTrade>): NoteTrade => ({ note_id: "n1", state: "open", order: null, position: null, r_multiple: null, ...over });
  const pos = { id: "p", status: "OPEN", action: "BUY" as const, horizon: "positional", quantity: 10, entry_price: 100, exit_price: null, pnl: null, exit_reason: null, stop_loss_price: 95, initial_stop_loss_price: 95, target_price: 120, segment: "NSE" };
  const order = { id: "o", status: "pending", status_reason: null, trigger_price: 90, stop_loss_price: 85, target_price: 110, expires_at: "", last_price: 100 };

  it("says where each state stands", () => {
    expect(tradeStatusText(trade({ state: "waiting", order }), fmt)).toBe("Waiting to buy at 90");
    expect(tradeStatusText(trade({ state: "open", position: pos }), fmt)).toBe("Open from 100");
    expect(tradeStatusText(trade({ state: "closed", position: { ...pos, status: "CLOSED", exit_price: 110 }, r_multiple: 2 }), fmt)).toBe("Closed at 110 · +2R");
    expect(tradeStatusText(trade({ state: "closed", position: { ...pos, status: "CLOSED", exit_price: 92 }, r_multiple: -1.6 }), fmt)).toBe("Closed at 92 · -1.6R");
    expect(tradeStatusText(trade({ state: "ended", order: { ...order, status: "expired", status_reason: "expired before the price reached the trigger" } }), fmt)).toBe(
      "Order expired: expired before the price reached the trigger",
    );
  });
});

import type { NoteTrade, PlanOrder } from "../api/planTrade";
import type { StudyNote } from "../api/types";

/** A positional (multi-day) trade is a spot hold, so it can be planned on NSE and crypto but not MCX, which has futures only.
 * It is paper only, and long only: nobody holds a short in the cash market for days. */
export const canTradePlan = (note: Pick<StudyNote, "tag" | "segment">): boolean => note.tag === "plan" && note.segment !== "MCX";

export type PlanForm = {
  entryType: "market" | "limit";
  /** The Limit price; ignored for a Market entry, which uses the live price. */
  limitPrice: string;
  stop: string;
  target: string;
  /** Blank = size by risk on the positional account. */
  quantity: string;
  /** How long a Limit entry stays armed, in days. */
  days: 1 | 3 | 7;
};

export const EMPTY_PLAN: PlanForm = { entryType: "market", limitPrice: "", stop: "", target: "", quantity: "", days: 7 };

const num = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export type ParsedPlan = { entry: number | null; stop: number | null; target: number | null; quantity: number | null };

export function parsePlan(f: PlanForm, ltp: number | null): ParsedPlan {
  return {
    entry: f.entryType === "market" ? ltp : num(f.limitPrice),
    stop: num(f.stop),
    target: num(f.target),
    quantity: num(f.quantity),
  };
}

/** What is wrong with this plan, in plain words, or null when it can be placed. Long only. */
export function planProblem(f: PlanForm, ltp: number | null): string | null {
  const p = parsePlan(f, ltp);
  for (const [label, v] of [["entry", p.entry], ["stop-loss", p.stop], ["target", p.target], ["quantity", p.quantity]] as const) {
    if (v !== null && (Number.isNaN(v) || v <= 0)) return `Enter a valid ${label}.`;
  }
  if (p.entry === null) return f.entryType === "limit" ? "Enter the price you want to buy at." : "There is no live price to buy at right now.";
  if (p.stop === null) return "Set a stop-loss: a swing trade needs to know where it is wrong.";
  if (p.stop >= p.entry) return "The stop-loss has to be below the entry.";
  if (p.target !== null && p.target <= p.entry) return "The target has to be above the entry.";
  if (f.entryType === "limit" && ltp !== null && p.entry === ltp) return "The price is already there: use a Market entry instead.";
  return null;
}

/** Reward over risk, when there is a target: the same ratio the ticket shows. */
export function planRewardRisk(f: PlanForm, ltp: number | null): number | null {
  const p = parsePlan(f, ltp);
  if (p.entry === null || p.stop === null || p.target === null || p.stop >= p.entry || p.target <= p.entry) return null;
  return (p.target - p.entry) / (p.entry - p.stop);
}

/** The request that places this plan: a Market entry opens a positional spot position at the live price, a Limit entry arms a waiting order. */
export function buildPlanOrder(note: Pick<StudyNote, "id" | "segment" | "symbol" | "text" | "interval">, f: PlanForm, ltp: number | null): PlanOrder {
  const p = parsePlan(f, ltp);
  const common = {
    segment: note.segment,
    symbol: note.symbol,
    action: "BUY",
    horizon: "positional",
    source_note_id: note.id,
    ...(p.stop !== null ? { stop_loss_price: p.stop } : {}),
    ...(p.target !== null ? { target_price: p.target } : {}),
    ...(p.quantity !== null ? { quantity: p.quantity } : {}),
    risk_managed: p.quantity === null,
    ...(note.interval ? { entry_interval: note.interval } : {}),
  };
  if (f.entryType === "limit") {
    return { kind: "limit", body: { ...common, strategy: "spot", trigger_price: p.entry, expires_in_minutes: f.days * 1440 } };
  }
  return {
    kind: "market",
    body: { ...common, instrument_type: "spot", price: p.entry, order_type: "market", plan_checklist: [], notes: note.text.slice(0, 2000) },
  };
}

/** One line for the note: where its trade stands. */
export function tradeStatusText(t: NoteTrade, fmt: (n: number) => string): string {
  const pos = t.position;
  if (t.state === "waiting" && t.order) return `Waiting to buy at ${fmt(t.order.trigger_price)}`;
  if (t.state === "ended" && t.order) return `Order ${t.order.status}${t.order.status_reason ? `: ${t.order.status_reason}` : ""}`;
  if (t.state === "open" && pos) return `Open from ${pos.entry_price != null ? fmt(pos.entry_price) : "?"}`;
  if (t.state === "closed" && pos) {
    const r = t.r_multiple;
    return `Closed ${pos.exit_price != null ? `at ${fmt(pos.exit_price)}` : ""}${r != null ? ` · ${r > 0 ? "+" : ""}${r}R` : ""}`.trim();
  }
  return "";
}

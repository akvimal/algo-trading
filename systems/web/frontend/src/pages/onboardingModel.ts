import type { OptionGroup, Position, Segment } from "../api/types";

export type Experience = "guided" | "pro";

export type Background = "new" | "some" | "regular";

export const BACKGROUNDS: { id: Background; title: string; body: string }[] = [
  { id: "new", title: "I am new to trading", body: "I have not placed many trades, or none." },
  { id: "some", title: "I have traded a little", body: "I know the basics but I am still learning." },
  { id: "regular", title: "I trade regularly", body: "I use stop-losses, size positions and read charts." },
];

/** The starting view we suggest. It is only a suggestion: the person picks, and can change it any time. */
export const suggestExperience = (b: Background): Experience => (b === "regular" ? "pro" : "guided");

export const CAPITAL_PRESETS = [100_000, 500_000, 1_000_000] as const;
export const MIN_CAPITAL = 10_000;
export const MAX_CAPITAL = 100_000_000;

/** Reads a typed capital: whole rupees, commas and a leading rupee sign allowed. Null if unusable. */
export function parseCapital(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n >= MIN_CAPITAL && n <= MAX_CAPITAL ? n : null;
}

const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

export type StartingRules = {
  capitalPerTrade: number;
  riskPct: number;
  minRewardRisk: number;
  dailyLossLimit: number;
  slippageBps: number;
};

/** Sensible starting rules from the capital, all editable later in Settings. A tenth of the account
 * in one trade, one percent of it at risk on any trade, and a daily stop at two percent: small enough
 * that a bad day is survivable, which is the point of practising first. */
export function deriveRules(capital: number): StartingRules {
  return {
    capitalPerTrade: roundTo(capital * 0.1, 1000),
    riskPct: 1,
    minRewardRisk: 2,
    dailyLossLimit: roundTo(capital * 0.02, 500),
    slippageBps: 5,
  };
}

export const SEGMENT_CHOICES: { id: Segment; title: string; note: string }[] = [
  { id: "NSE", title: "Stocks and index options", note: "NSE: shares, Nifty, Bank Nifty" },
  { id: "MCX", title: "Commodities", note: "MCX: gold, crude oil" },
  { id: "CRYPTO", title: "Crypto", note: "Bitcoin and Ether, trading all day" },
];

/** The settings to write to one segment's paper account. Costs are always on so results are honest;
 * the charges switch only exists for Indian markets, so it is not sent for crypto. */
export function accountPatch(segment: Segment, capital: number, rules: StartingRules): Record<string, unknown> {
  return {
    starting_balance: capital,
    capital_per_trade: rules.capitalPerTrade,
    risk_per_trade_pct: rules.riskPct,
    min_reward_risk_ratio: rules.minRewardRisk,
    max_daily_loss: rules.dailyLossLimit,
    require_stop_loss: true,
    slippage_bps: rules.slippageBps,
    ...(segment === "CRYPTO" ? {} : { apply_charges: true }),
  };
}

export type FirstWeekStep = { id: "planned" | "why" | "review"; title: string; hint: string; done: boolean; to: string };

const hasWhy = (t: { setup_tag?: string | null; notes?: string | null }) => Boolean(t.setup_tag?.trim() || t.notes?.trim());

/** The habits worth building in the first week, worked out from what the person has actually done:
 * a trade with its stop-loss set, a reason written down for a trade, a trade reviewed. Nothing here
 * is asked of the person twice: it just notices. */
export function firstWeek(positions: Position[], groups: OptionGroup[]): FirstWeekStep[] {
  const standalone = positions.filter((p) => p.option_group_id == null && p.status !== "REJECTED");
  const planned =
    standalone.some((p) => p.stop_loss_price != null) || groups.some((g) => g.status !== "REJECTED" && (g.spot_stop_loss_price != null || g.combined_stop_loss_price != null));
  const why = standalone.some(hasWhy) || groups.some(hasWhy);
  const review = standalone.some((p) => p.reviewed_at != null) || groups.some((g) => g.reviewed_at != null);
  return [
    { id: "planned", title: "Place a planned trade", hint: "Entry, stop-loss and target first.", done: planned, to: "/trade" },
    { id: "why", title: "Write down why", hint: "Tag the setup or add a note on a trade.", done: why, to: "/portfolio?tab=history" },
    { id: "review", title: "Review a closed trade", hint: "Say whether you followed your plan.", done: review, to: "/portfolio?tab=review" },
  ];
}

export const firstWeekDone = (steps: FirstWeekStep[]) => steps.filter((s) => s.done).length;

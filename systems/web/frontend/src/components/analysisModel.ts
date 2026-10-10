import type { Agreement, Bias, StockAnalysis } from "../api/analysis";

export const BIAS_WORD: Record<Bias, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };
/** The arrow beside a lean: up, down, or level. */
export const BIAS_ARROW: Record<Bias, string> = { bullish: "▲", bearish: "▼", neutral: "◆" };
export const biasTone = (b: Bias | null): "up" | "dn" | "" => (b === "bullish" ? "up" : b === "bearish" ? "dn" : "");

export const AGREEMENT_LABEL: Record<Agreement, string> = {
  aligned: "Chart and business agree",
  conflicting: "Chart and business disagree",
  mixed: "Only one side leans",
  technical_only: "Chart only",
};
/** How much weight to put behind the picture: agreement is firmer, disagreement is a caution, the rest is in between. */
export const AGREEMENT_TONE: Record<Agreement, "up" | "dn" | "warn" | ""> = { aligned: "up", conflicting: "warn", mixed: "", technical_only: "" };

/** How firmly the votes lean one way, in words. The number behind it is the share of the weighted votes pointing that way: it says how much of the
 * evidence agrees, not how likely the move is, so it is not shown as a percentage next to a lean. */
export function leanStrength(confidence: number): "strong" | "moderate" | "slight" {
  return confidence >= 0.75 ? "strong" : confidence >= 0.4 ? "moderate" : "slight";
}

export const percent = (v: number | null | undefined): string => (v == null ? "" : `${Math.round(v * 100)}%`);

/** How old a read is, in a few words. */
export function readAge(fetchedAt: string | null, now: Date = new Date()): string {
  if (!fetchedAt) return "";
  const days = Math.floor((now.getTime() - new Date(fetchedAt).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The price ladder: resistance above (furthest first), the price, support below (nearest first), so it reads top to bottom like the chart. */
export type LadderRow = { kind: "resistance" | "price" | "support"; low: number; high: number; label: string; distancePct: number | null };

export function ladder(a: Pick<StockAnalysis, "price" | "technical">): LadderRow[] {
  const above = [...a.technical.resistance].sort((x, y) => y.low - x.low).map<LadderRow>((l) => ({ kind: "resistance", low: l.low, high: l.high, label: `${l.timeframe} resistance`, distancePct: l.distance_pct }));
  const below = [...a.technical.support].sort((x, y) => y.high - x.high).map<LadderRow>((l) => ({ kind: "support", low: l.low, high: l.high, label: `${l.timeframe} support`, distancePct: -l.distance_pct }));
  return [...above, { kind: "price", low: a.price, high: a.price, label: "Price now", distancePct: null }, ...below];
}

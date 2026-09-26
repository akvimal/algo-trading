import type { MarketRegime } from "../api/types";

// Two charts watched together are only worth having if the person can see, at a glance, whether they
// agree. This reduces each chart's regime read to a direction and compares them.

export type Direction = "up" | "down" | "neutral";

/** One chart's direction: a trend regime is decisive; otherwise the structure trend, when it has one;
 * otherwise no direction at all (a ranging market points nowhere). */
export function directionOf(r: Pick<MarketRegime, "regime" | "trend"> | null): Direction | null {
  if (!r) return null;
  if (r.regime === "trending_up") return "up";
  if (r.regime === "trending_down") return "down";
  if (r.trend === "up") return "up";
  if (r.trend === "down") return "down";
  return "neutral";
}

export type Agreement = { verdict: "aligned-up" | "aligned-down" | "mixed" | "unclear"; text: string };

const label = (d: Direction) => (d === "up" ? "up" : d === "down" ? "down" : "sideways");

/** Whether two charts agree. `unclear` when either has no read yet, or both point nowhere. */
export function agreement(a: { symbol: string; regime: MarketRegime | null }, b: { symbol: string; regime: MarketRegime | null }): Agreement {
  const da = directionOf(a.regime);
  const db = directionOf(b.regime);
  if (da === null || db === null) return { verdict: "unclear", text: "Waiting for both charts to load." };
  if (da === "neutral" && db === "neutral") return { verdict: "unclear", text: `${a.symbol} and ${b.symbol} are both going sideways: no direction to confirm.` };
  if (da === db) return { verdict: da === "up" ? "aligned-up" : "aligned-down", text: `Aligned: ${a.symbol} and ${b.symbol} are both moving ${label(da)}.` };
  return { verdict: "mixed", text: `Mixed: ${a.symbol} is ${label(da)}, ${b.symbol} is ${label(db)}. The two do not confirm each other.` };
}

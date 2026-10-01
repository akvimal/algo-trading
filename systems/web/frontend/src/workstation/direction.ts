import type { MarketRegime } from "../api/types";

export type Direction = "up" | "down" | "neutral";

/** One chart's direction, for the colour of its regime pill: a trend regime is decisive; otherwise the structure trend,
 * when it has one; otherwise no direction at all (a ranging market points nowhere). */
export function directionOf(r: Pick<MarketRegime, "regime" | "trend"> | null): Direction | null {
  if (!r) return null;
  if (r.regime === "trending_up") return "up";
  if (r.regime === "trending_down") return "down";
  if (r.trend === "up") return "up";
  if (r.trend === "down") return "down";
  return "neutral";
}

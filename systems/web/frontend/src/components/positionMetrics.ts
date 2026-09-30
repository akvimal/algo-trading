import type { OptionGroup } from "../api/types";

export const isNakedOption = (strategyType: string): boolean => strategyType.startsWith("naked_");
export const isSpreadOption = (strategyType: string): boolean => strategyType.endsWith("_spread");

export type NakedMetrics = { spotPct: number | null; premiumPct: number | null };

/** A naked (single-leg) option position: how far the underlying has moved since entry, and how
 * far the option's own premium has moved since entry. Both come straight off the group - no legs
 * fetch needed: for a naked position, the combined premium IS the single leg's own price (see
 * option_position_manager's module docstring), so net_debit/live_combined_price already are the
 * entry/live premium. */
export function nakedMetrics(g: Pick<OptionGroup, "entry_spot_price" | "live_spot_price" | "net_debit" | "live_combined_price">): NakedMetrics {
  const spotPct =
    g.entry_spot_price != null && g.entry_spot_price !== 0 && g.live_spot_price != null
      ? ((g.live_spot_price - g.entry_spot_price) / g.entry_spot_price) * 100
      : null;
  const premiumPct =
    g.net_debit != null && g.net_debit !== 0 && g.live_combined_price != null ? ((g.live_combined_price - g.net_debit) / g.net_debit) * 100 : null;
  return { spotPct, premiumPct };
}

export type SpreadMetrics = { maxProfitPct: number | null; fundUsedPct: number | null };

/** A spread (2-leg) position: how far its live P&L is toward the position's own defined max
 * profit, and against the capital actually committed to it - net_debit for a debit spread (the
 * premium paid IS the capital at risk) or the defined max loss for a credit spread (see
 * execution's _spread_sizing_basis, the identical debit/credit split this mirrors). Needs
 * strike_width - null (not computable) for a group opened before that field existed. */
export function spreadMetrics(g: Pick<OptionGroup, "net_debit" | "strike_width" | "unrealized_pnl" | "quantity">): SpreadMetrics {
  const { net_debit, quantity, unrealized_pnl } = g;
  const strikeWidth = g.strike_width;
  if (net_debit == null || strikeWidth == null || unrealized_pnl == null || !quantity) return { maxProfitPct: null, fundUsedPct: null };
  const maxProfitPerUnit = net_debit >= 0 ? strikeWidth - net_debit : Math.abs(net_debit);
  const fundUsedPerUnit = net_debit >= 0 ? net_debit : strikeWidth - Math.abs(net_debit);
  const maxProfitTotal = maxProfitPerUnit * quantity;
  const fundUsedTotal = fundUsedPerUnit * quantity;
  return {
    maxProfitPct: maxProfitTotal > 0 ? (unrealized_pnl / maxProfitTotal) * 100 : null,
    fundUsedPct: fundUsedTotal > 0 ? (unrealized_pnl / fundUsedTotal) * 100 : null,
  };
}

import type { OptionGroup, OptionLeg } from "../api/types";

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

/** What one leg has made so far: the API's own figure when it came with live prices, else worked out from entry and live price. */
export function legPnl(leg: Pick<OptionLeg, "action" | "quantity" | "entry_price" | "live_price" | "unrealized_pnl">): number | null {
  if (leg.unrealized_pnl != null) return leg.unrealized_pnl;
  if (leg.live_price == null || leg.quantity == null) return null;
  return (leg.live_price - leg.entry_price) * leg.quantity * (leg.action === "BUY" ? 1 : -1);
}

export type SpreadDetail = {
  maxProfit: number;
  maxLoss: number;
  /** Money still to make before max profit / still to lose before max loss. Every % is of the capital committed (the max loss, which is the debit paid or the credit spread's margin). */
  profitLeft: number | null;
  lossLeft: number | null;
  maxProfitPct: number;
  maxLossPct: number;
  profitLeftPct: number | null;
  lossLeftPct: number | null;
  breakeven: number | null;
  breakevenFromSpotPct: number | null;
};

const STRIKE_RE = /-(\d+(?:\.\d+)?)-(CE|PE)$/;

/** The fuller spread read (what Sensibull's position card shows): max profit and loss, how much of each is left, and where expiry breaks even.
 * The breakeven is the strike of the leg that carries the premium (the sold leg for a credit spread, the bought one for a debit spread) moved by
 * the premium; null when the strikes cannot be read off the leg symbols. */
export function spreadDetail(g: Pick<OptionGroup, "net_debit" | "strike_width" | "unrealized_pnl" | "quantity" | "legs" | "live_spot_price">): SpreadDetail | null {
  const { net_debit, quantity, unrealized_pnl } = g;
  const w = g.strike_width;
  if (net_debit == null || w == null || !quantity) return null;
  const credit = net_debit < 0;
  const maxProfit = (credit ? Math.abs(net_debit) : w - net_debit) * quantity;
  const maxLoss = (credit ? w - Math.abs(net_debit) : net_debit) * quantity;
  if (!(maxProfit > 0) || !(maxLoss > 0)) return null;
  const pnl = unrealized_pnl ?? null;
  let breakeven: number | null = null;
  const carrier = (g.legs ?? []).find((l) => l.action === (credit ? "SELL" : "BUY"));
  const m = carrier ? STRIKE_RE.exec(carrier.symbol) : null;
  if (m) {
    const strike = Number(m[1]);
    const premium = Math.abs(net_debit);
    // Puts break even below the carrying strike, calls above it, credit or debit alike.
    breakeven = m[2] === "CE" ? strike + premium : strike - premium;
  }
  const spot = g.live_spot_price ?? null;
  return {
    maxProfit,
    maxLoss,
    profitLeft: pnl == null ? null : maxProfit - pnl,
    lossLeft: pnl == null ? null : maxLoss + pnl,
    maxProfitPct: (maxProfit / maxLoss) * 100,
    maxLossPct: 100,
    profitLeftPct: pnl == null ? null : ((maxProfit - pnl) / maxLoss) * 100,
    lossLeftPct: pnl == null ? null : ((maxLoss + pnl) / maxLoss) * 100,
    breakeven,
    breakevenFromSpotPct: breakeven != null && spot ? ((breakeven - spot) / spot) * 100 : null,
  };
}

export type SpreadMetrics = { maxProfitPct: number | null; fundUsedPct: number | null; fundUsed: number | null };

/** A spread (2-leg) position: how far its live P&L is toward the position's own defined max
 * profit, and against the capital actually committed to it - net_debit for a debit spread (the
 * premium paid IS the capital at risk) or the defined max loss for a credit spread (see
 * execution's _spread_sizing_basis, the identical debit/credit split this mirrors). Needs
 * strike_width - null (not computable) for a group opened before that field existed. */
export function spreadMetrics(g: Pick<OptionGroup, "net_debit" | "strike_width" | "unrealized_pnl" | "quantity">): SpreadMetrics {
  const { net_debit, quantity, unrealized_pnl } = g;
  const strikeWidth = g.strike_width;
  if (net_debit == null || strikeWidth == null || unrealized_pnl == null || !quantity) return { maxProfitPct: null, fundUsedPct: null, fundUsed: null };
  const maxProfitPerUnit = net_debit >= 0 ? strikeWidth - net_debit : Math.abs(net_debit);
  const fundUsedPerUnit = net_debit >= 0 ? net_debit : strikeWidth - Math.abs(net_debit);
  const maxProfitTotal = maxProfitPerUnit * quantity;
  const fundUsedTotal = fundUsedPerUnit * quantity;
  return {
    maxProfitPct: maxProfitTotal > 0 ? (unrealized_pnl / maxProfitTotal) * 100 : null,
    fundUsed: fundUsedTotal > 0 ? fundUsedTotal : null,
    fundUsedPct: fundUsedTotal > 0 ? (unrealized_pnl / fundUsedTotal) * 100 : null,
  };
}

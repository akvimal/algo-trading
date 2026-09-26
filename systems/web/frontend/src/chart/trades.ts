import type { OptionGroup, Position } from "../api/types";

// The person's own trades, shaped for the chart. Plain data and no chart library, so it can be tested
// without a screen and used by the page without pulling the library into its bundle.

export type ChartTrade = {
  id: string;
  kind: "future" | "option";
  side: "long" | "short";
  state: "open" | "closed";
  entryTs: number;
  entryPrice: number;
  exitTs: number | null;
  exitPrice: number | null;
  /** Unrealized while open, realized once closed. */
  pnl: number | null;
  /** Short name for the marker, e.g. "Long 37" or "Naked Call". */
  label: string;
  /** Why it closed (stop-loss, target, square-off, counter-signal...), when it has. */
  reason: string | null;
};

export type TradeMarkerExtend = Omit<ChartTrade, "id" | "entryTs" | "exitTs">;

const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

/** A short, plain name for an option group's kind of trade. */
export function optionLabel(g: Pick<OptionGroup, "strategy_type" | "action">): string {
  const t = g.strategy_type.toLowerCase();
  const buy = g.action === "BUY";
  if (t.startsWith("naked")) return buy ? "Naked Call" : "Naked Put";
  if (t.includes("straddle")) return "Straddle";
  if (t.includes("strangle")) return "Strangle";
  return buy ? "Bull Call" : "Bear Put";
}

/** The instrument itself, or one of its contracts (NIFTY-Sep2026-FUT), but not another instrument that
 * merely starts the same way (NIFTYBEES, TCSX). */
export const isContractOf = (symbol: string, base: string) => {
  const s = symbol.toUpperCase();
  return s === base || s.startsWith(`${base}-`);
};

/** The trades that belong on the chart of `base` (the bare instrument, e.g. NIFTY), from the person's
 * positions and option groups. Trades that began before the first candle on the chart are left out:
 * there is nowhere to draw them.
 *
 * A future is stored under its resolved contract (NIFTY-Sep2026-FUT), an option group under the bare
 * underlying, so positions match by contract name, and option legs (which carry an `option_group_id`) are left
 * to their group's row. An option group has no exit price on the underlying, so it is drawn at the
 * underlying's price when it opened, as a diamond with its result beside it, not as an in-and-out line. */
export function toChartTrades(base: string, positions: Position[], groups: OptionGroup[], firstBarTs: number): ChartTrade[] {
  const want = base.trim().toUpperCase();
  const out: ChartTrade[] = [];
  for (const p of positions) {
    if (p.option_group_id != null || !isContractOf(p.symbol, want)) continue;
    if (p.status !== "OPEN" && p.status !== "CLOSED") continue;
    const entryTs = Date.parse(p.entry_time);
    if (!Number.isFinite(entryTs) || entryTs < firstBarTs || p.entry_price == null) continue;
    const open = p.status === "OPEN";
    const exitTs = p.exit_time ? Date.parse(p.exit_time) : NaN;
    out.push({
      id: p.id,
      kind: "future",
      side: p.action === "BUY" ? "long" : "short",
      state: open ? "open" : "closed",
      entryTs,
      entryPrice: p.entry_price,
      exitTs: Number.isFinite(exitTs) ? exitTs : null,
      exitPrice: p.exit_price,
      pnl: open ? (p.unrealized_pnl ?? null) : p.pnl,
      label: `${p.action === "BUY" ? "Long" : "Short"} ${p.quantity != null ? qty(p.quantity) : ""}`.trim(),
      reason: p.exit_reason ?? null,
    });
  }
  for (const g of groups) {
    if (g.underlying_symbol.toUpperCase() !== want) continue;
    if (g.status !== "OPEN" && g.status !== "CLOSED") continue;
    const spot = g.entry_spot_price;
    if (g.entry_time == null || spot == null) continue;
    const entryTs = Date.parse(g.entry_time);
    if (!Number.isFinite(entryTs) || entryTs < firstBarTs) continue;
    const open = g.status === "OPEN";
    const exitTs = g.exit_time ? Date.parse(g.exit_time) : NaN;
    out.push({
      id: g.id,
      kind: "option",
      side: g.action === "BUY" ? "long" : "short",
      state: open ? "open" : "closed",
      entryTs,
      entryPrice: spot,
      exitTs: Number.isFinite(exitTs) ? exitTs : null,
      exitPrice: null,
      pnl: open ? (g.unrealized_pnl ?? null) : g.pnl,
      label: optionLabel(g),
      reason: g.exit_reason ?? null,
    });
  }
  return out;
}

/** "+1.2k", "−450": a signed, compact result for a small label. */
export function compactPnl(n: number | null): string {
  if (n == null) return "–";
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(Math.round(abs));
  return `${n < 0 ? "−" : "+"}${body}`;
}

/** The outline a trade is drawn with: how it is doing, not which way it points, on the result label. */
export function pnlTone(pnl: number | null): "up" | "dn" | "flat" {
  if (pnl == null || pnl === 0) return "flat";
  return pnl > 0 ? "up" : "dn";
}

import type { OptionGroup, Position } from "../api/types";
import { optionLabel } from "../chart/trades";

export type AutoTradeRow = {
  id: string;
  label: string;
  side: "BUY" | "SELL";
  state: "open" | "closed";
  /** Unrealized while open, booked once closed. */
  pnl: number | null;
  when: string;
  reason: string | null;
};

/** The auto-trader's trades as plain rows, newest first. An option leg is not a row of its own (it
 * belongs to its group), and anything that was rejected never traded. */
export function tradeRows(positions: Position[], groups: OptionGroup[], limit = 8): AutoTradeRow[] {
  const rows: AutoTradeRow[] = [];
  for (const p of positions) {
    if (p.option_group_id != null || (p.status !== "OPEN" && p.status !== "CLOSED")) continue;
    const open = p.status === "OPEN";
    rows.push({ id: p.id, label: p.symbol, side: p.action, state: open ? "open" : "closed", pnl: open ? (p.unrealized_pnl ?? null) : p.pnl, when: open ? p.entry_time : (p.exit_time ?? p.entry_time), reason: p.exit_reason ?? null });
  }
  for (const g of groups) {
    if (g.status !== "OPEN" && g.status !== "CLOSED") continue;
    const open = g.status === "OPEN";
    rows.push({ id: g.id, label: `${g.underlying_symbol} ${optionLabel(g).toLowerCase()}`, side: g.action, state: open ? "open" : "closed", pnl: open ? (g.unrealized_pnl ?? null) : g.pnl, when: open ? g.entry_time : (g.exit_time ?? g.entry_time), reason: g.exit_reason ?? null });
  }
  return rows.sort((a, b) => Date.parse(b.when) - Date.parse(a.when)).slice(0, limit);
}

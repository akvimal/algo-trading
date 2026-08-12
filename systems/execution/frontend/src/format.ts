import type { Account } from "./api";

export const SEGMENTS: Account["segment"][] = ["NSE", "MCX", "CRYPTO"];

// Time only ("18:04") - PositionsPage's date filter narrows the grids to
// one day at a time, so the date itself doesn't need repeating per row.
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Local (not UTC) YYYY-MM-DD, so the date filter/input line up with the
// user's own calendar day rather than shifting at UTC midnight.
export function localDateStr(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayLocalDate(): string {
  return localDateStr(new Date().toISOString());
}

// % return on cost basis (entry_price * quantity) - same formula for
// BUY and SELL, since it's read as "return relative to risk basis" either way.
export function pnlPercent(pnl: number | null, entryPrice: number, quantity: number | null): number | null {
  if (pnl == null || quantity == null || quantity === 0) return null;
  return (pnl / (entryPrice * quantity)) * 100;
}

export function formatPct(pct: number | null): string {
  if (pct == null) return "";
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
}

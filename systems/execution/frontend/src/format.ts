import type { Account } from "./api";

export const SEGMENTS: Account["segment"][] = ["NSE", "MCX", "CRYPTO"];

// Time only ("18:04") - PositionsPage's date filter narrows the grids to
// one day at a time, so the date itself doesn't need repeating per row.
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Full local date+time ("30 Aug 2026, 6:42 pm") - unlike formatTime above
// (time-only, for a grid already narrowed to one day), this is for a
// value that can be arbitrarily old (e.g. an account's own updated_at),
// where the date matters as much as the time.
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
// BUY and SELL, since it's read as "return relative to risk basis" either
// way. entryPrice accepts null too - option groups pass net_debit, which
// is null for a REJECTED group that never got a live quote.
export function pnlPercent(pnl: number | null, entryPrice: number | null, quantity: number | null): number | null {
  if (pnl == null || entryPrice == null || quantity == null || quantity === 0) return null;
  return (pnl / (entryPrice * quantity)) * 100;
}

export function formatPct(pct: number | null): string {
  if (pct == null) return "";
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
}

// CRYPTO prices/pnl/fees are raw USD - Delta Exchange's own native
// pricing, never converted to INR (see docs/architecture.md's USDINR
// section: only the CAPITAL figure gets converted, at sizing time, never
// entry_price/exit_price/pnl/fees themselves). Every other segment is
// already implicitly INR throughout this app (no prefix at all) - this
// only disambiguates CRYPTO rows so their numbers can't be mistaken for
// the same currency as an NSE/MCX row sitting right next to them.
export function money(value: number, segment: string): string {
  return `${segment === "CRYPTO" ? "$" : ""}${value.toFixed(2)}`;
}

export function moneySigned(value: number, segment: string): string {
  return `${value >= 0 ? "+" : ""}${money(value, segment)}`;
}

// Shared manual-order primitives - pure helpers + small constants used by
// both WorkspacePage.tsx (the full multi-instrument Workspace) and
// ChartTradePanel.tsx (the compact single-instrument panel beside the
// Live Chart). Deliberately just the stateless pieces: the stateful order
// engine (placeOrder/executeOrder, pending watches, risk sizing) still
// lives in WorkspacePage - see docs/architecture.md § "Live chart -
// inline trade panel + shared order engine" for the phased extraction
// plan. This module is Phase A's low-risk slice: no React, no state.

import { type ChecklistItem, type Segment, fetchLtp, resolveUnderlying } from "./api";

export type InstrumentType = "spot" | "future" | "option";
export type ExitReason = "manual" | "target" | "stop_loss";

// Suggestions / closed lists for the handful of index/commodity/crypto
// symbols the desk actually trades - same "hardcode the small stable set"
// reasoning across the app (OiSummaryPage PRESETS, LiveChartPage's own
// 7-symbol tab bar).
export const NSE_INDEX_SYMBOLS = ["NIFTY", "BANKNIFTY"];
export const MCX_COMMODITY_SYMBOLS = ["GOLDM", "CRUDEOILM"];
// Delta Exchange India only lists live options for these two perpetuals
// (see WorkspacePage's own longer note) - every other CRYPTO symbol 422s
// if picked for an option order.
export const CRYPTO_OPTION_SYMBOLS = ["BTCUSD", "ETHUSD"];

// Empty `segments` means every segment - shared by checklist filtering
// across both surfaces.
export function appliesToSegment(item: ChecklistItem, segment: Segment): boolean {
  return item.segments.length === 0 || item.segments.includes(segment);
}

// Local calendar date "YYYY-MM-DD" (same shape GET /options/expiries
// returns) - a browser-local view of "which day", not the server's
// timezone-aware "today".
export function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Local-date grouping key (en-CA gives YYYY-MM-DD ordering directly).
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

export function todayKey(): string {
  return dayKey(new Date().toISOString());
}

// crypto.randomUUID() only exists in a secure context - throws otherwise
// (reproduced live on the VPS deploy, which has no TLS yet). These IDs are
// client-side-only identity, never sent to a backend, so a
// non-cryptographic fallback is fine.
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function fmt(n: number | null | undefined, digits = 2): string {
  return n == null ? "-" : n.toFixed(digits);
}

// Quantity display - up to 4dp (fractional CRYPTO lots, e.g. BTCUSD=0.001)
// but trailing zeros trimmed so a whole number reads "10", not "10.0000".
export function fmtQty(n: number | null | undefined): string {
  return n == null ? "-" : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function pnlClass(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 0 ? "pnl-positive" : "pnl-negative";
}

// "Aug-15  12:24 PM" - compact one-line-per-trade timestamp.
export function formatCompact(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate().toString().padStart(2, "0");
  const time = d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${month}-${day}  ${time}`;
}

// A bare underlying (e.g. "GOLDM") isn't always a directly-quotable
// Dhan/Delta symbol - resolve to its chart_symbol/chart_exchange first.
// resolve_underlying is a local instrument-master lookup on market-data
// (no broker API call), so pairing it with every LTP fetch is free
// against Dhan's rate limit.
export async function fetchUnderlyingLtp(segment: Segment, symbol: string): Promise<number> {
  const resolved = await resolveUnderlying(segment, symbol);
  return fetchLtp(resolved.chart_exchange, resolved.chart_symbol);
}

// Direction-aware crossing check for a client-side spot-price exit watch:
// `action` fixes which side is favorable (target) vs unfavorable (stop).
// Structural param so both WorkspacePage's OrderInstance and the chart
// panel's own lighter shape satisfy it.
export function checkExitTrigger(
  instance: { action: "BUY" | "SELL"; targetPrice?: number | null; slLimitPrice?: number | null },
  ltp: number,
): ExitReason | null {
  if (instance.targetPrice != null) {
    const hit = instance.action === "BUY" ? ltp >= instance.targetPrice : ltp <= instance.targetPrice;
    if (hit) return "target";
  }
  if (instance.slLimitPrice != null) {
    const hit = instance.action === "BUY" ? ltp <= instance.slLimitPrice : ltp >= instance.slLimitPrice;
    if (hit) return "stop_loss";
  }
  return null;
}

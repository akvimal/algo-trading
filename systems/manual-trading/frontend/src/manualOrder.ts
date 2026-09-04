// Shared manual-order primitives - pure helpers + small constants used by
// both WorkspacePage.tsx (the full multi-instrument Workspace) and
// ChartTradePanel.tsx (the compact single-instrument panel beside the
// Live Chart). Deliberately just the stateless pieces: the stateful order
// engine (placeOrder/executeOrder, pending watches, risk sizing) still
// lives in WorkspacePage - see docs/architecture.md § "Live chart -
// inline trade panel + shared order engine" for the phased extraction
// plan. This module is Phase A's low-risk slice: no React, no state.

import {
  type ChecklistItem,
  type ManualOptionGroup,
  type ManualPosition,
  type OptionStrikeMoneyness,
  type ResolvedUnderlying,
  type Segment,
  createManualOptionGroup,
  createManualPosition,
  fetchLtp,
  resolveUnderlying,
  updateOptionGroupSpotStopLoss,
  updateOptionGroupSpotTarget,
} from "./api";

export type InstrumentType = "spot" | "future" | "option";
export type ExitReason = "manual" | "target" | "stop_loss";

// The Live Chart trade panel's three strategy choices (see
// ChartTradePanel) - "future" is a spot/future Position, the other two are
// option groups.
export type PanelStrategy = "future" | "naked" | "spread";

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

// The reason a manual trade was taken - picked in the trade panel, stored
// on the position/group (execution.positions.setup_tag), and the slice
// axis for Trading Performance's "By setup" breakdown. "Revenge / FOMO"
// is deliberately here: a trade you know was a mistake is the one most
// worth being able to count later.
export const SETUP_TAGS = [
  "OB retest",
  "BOS continuation",
  "FVG fill",
  "S/R bounce",
  "Breakout",
  "OI reversal",
  "Trend pullback",
  "Range fade",
  "News",
  "Revenge / FOMO",
  "Other",
] as const;
export type SetupTag = (typeof SETUP_TAGS)[number];

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
// resolveUnderlying is a near-static mapping (symbol -> quotable chart
// symbol) but the poll loops that call fetchUnderlyingLtp run every few
// seconds - cache it for the session so each LTP tick is a single
// request, not two. A failed resolve isn't cached.
const _resolveCache = new Map<string, Promise<ResolvedUnderlying>>();

export function resolveUnderlyingCached(segment: Segment, symbol: string): Promise<ResolvedUnderlying> {
  const key = `${segment}:${symbol.trim().toUpperCase()}`;
  let p = _resolveCache.get(key);
  if (!p) {
    p = resolveUnderlying(segment, symbol).catch((e) => {
      _resolveCache.delete(key);
      throw e;
    });
    _resolveCache.set(key, p);
  }
  return p;
}

export async function fetchUnderlyingLtp(segment: Segment, symbol: string): Promise<number> {
  const resolved = await resolveUnderlyingCached(segment, symbol);
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

// --- Risk-managed placement helpers (ported/compacted from WorkspacePage) ---

// Reward:risk for a planned trade. `entry` falls back to the live price
// when a Limit price isn't set (a market order still has a knowable
// entry). null whenever it genuinely can't be computed (a level missing,
// or zero risk). Direction-agnostic on purpose - rrDirectionValid checks
// the sides separately so the two concerns stay independent, same split
// WorkspacePage.computeRR + its own Add-button gate use.
export function computeRR(input: { entry: number | null; stop: number | null; target: number | null }): number | null {
  const { entry, stop, target } = input;
  if (entry == null || stop == null || target == null) return null;
  if (![entry, stop, target].every((n) => Number.isFinite(n))) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  return Math.abs(target - entry) / risk;
}

// Lot count from a risk budget - the client-side mirror of execution's
// compute_risk_based_quantity (position_manager.py), returning LOTS (not
// units - the "Lots" field and createManualPosition.quantity are both in
// lots, execution multiplies by lot_size itself). `entry` here is the
// LIMIT price for a risk-managed order. null when it can't be computed.
// Exact for NSE/MCX at leverage 1 (the common case); NOT accurate for
// CRYPTO, whose capital is INR while price is USD - callers gate that.
export function previewRiskLots(input: {
  capitalPerTrade: number;
  riskPerTradePct: number;
  entry: number | null;
  stop: number | null;
  lotSize: number;
}): number | null {
  const { capitalPerTrade, riskPerTradePct, entry, stop, lotSize } = input;
  if (entry == null || stop == null || !Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0 || lotSize <= 0 || entry <= 0) return null;
  const riskAmount = (capitalPerTrade * riskPerTradePct) / 100;
  const riskLots = Math.floor(riskAmount / (stopDistance * lotSize));
  const capLots = Math.max(1, Math.floor(capitalPerTrade / (entry * lotSize)));
  return Math.max(1, Math.min(riskLots, capLots));
}

// Is the target on the profit side and the stop on the loss side of entry
// for this bias? A BUY wants target > entry > stop; a SELL the mirror.
// `null` inputs are treated as "not yet a problem" (true) - the caller's
// own required-field check handles missing values.
export function rrDirectionValid(input: {
  action: "BUY" | "SELL";
  entry: number | null;
  stop: number | null;
  target: number | null;
}): boolean {
  const { action, entry, stop, target } = input;
  if (entry == null) return true;
  const stopOk = stop == null || (action === "BUY" ? stop < entry : stop > entry);
  const targetOk = target == null || (action === "BUY" ? target > entry : target < entry);
  return stopOk && targetOk;
}

// A limit entry armed by ChartTradePanel and watched by LiveChartPage's
// own poll loop (which outlives the panel's per-symbol remount) - the
// compact equivalent of WorkspacePage's pending OrderInstance. No
// client-side order id: at most one pending order per symbol (the panel
// is single-slot), so the symbol IS the key.
export type PendingOrder = {
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  strategy: PanelStrategy;
  moneyness: OptionStrikeMoneyness;
  triggerPrice: number; // the underlying's own spot level to wait for
  startedAbove: boolean; // spot vs trigger at arm time - the crossing reference
  stop: number | null;
  target: number | null;
  quantity: number | null; // null = risk-size at fill
  trendFollowed: boolean;
  riskManaged: boolean;
  setupTag: string | null;
  confidence: number | null;
  armedAt: number; // Date.now() - for display only
};

// Has the underlying crossed the pending order's trigger (from whichever
// side it started)? Same "record the starting side once, fire on the
// first crossing" logic as WorkspacePage's startedAboveTarget.
export function pendingTriggerCrossed(order: Pick<PendingOrder, "triggerPrice" | "startedAbove">, ltp: number): boolean {
  return order.startedAbove ? ltp <= order.triggerPrice : ltp >= order.triggerPrice;
}

export type PlaceManualOrderParams = {
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  strategy: PanelStrategy;
  moneyness: OptionStrikeMoneyness;
  orderType: "market" | "limit";
  entryPrice: number; // resolved fill price for a future; recorded for review either way
  quantity: number | null; // null = let execution risk-size it
  stop: number | null;
  target: number | null;
  trendFollowed: boolean;
  riskManaged: boolean;
  setupTag: string | null;
  confidence: number | null;
};

export type PlaceManualOrderResult = {
  position?: ManualPosition;
  group?: ManualOptionGroup;
  rejected: boolean;
  reason: string | null;
  warning?: string; // e.g. an option SL/target follow-up call failed
};

// The single place an order actually reaches execution from - called by
// ChartTradePanel for a market order and by LiveChartPage's pending-order
// loop when a limit trigger fires. A future is one createManualPosition
// call carrying the real stop_loss_price/target_price; an option group is
// created first, then its spot SL/target attached via their own PUT
// endpoints (execution enforces all of them server-side).
export async function placeManualOrder(p: PlaceManualOrderParams): Promise<PlaceManualOrderResult> {
  if (p.strategy === "future") {
    const position = await createManualPosition({
      segment: p.segment,
      symbol: p.symbol,
      action: p.action,
      instrument_type: "future",
      price: p.entryPrice,
      ...(p.quantity != null ? { quantity: p.quantity } : {}),
      plan_checklist: [],
      order_type: p.orderType,
      ...(p.stop != null ? { stop_loss_price: p.stop } : {}),
      ...(p.target != null ? { target_price: p.target } : {}),
      trend_followed: p.trendFollowed,
      risk_managed: p.riskManaged,
      ...(p.setupTag ? { setup_tag: p.setupTag } : {}),
      ...(p.confidence != null ? { confidence: p.confidence } : {}),
    });
    return {
      position,
      rejected: position.status === "REJECTED",
      reason: position.rejection_reason,
    };
  }

  const group = await createManualOptionGroup({
    segment: p.segment,
    symbol: p.symbol,
    action: p.action,
    option_position_style: p.strategy === "spread" ? "spread" : "naked",
    option_strike_moneyness: p.moneyness,
    ...(p.quantity != null ? { option_fixed_lots: p.quantity } : {}),
    plan_checklist: [],
    order_type: p.orderType,
    trend_followed: p.trendFollowed,
    risk_managed: p.riskManaged,
    ...(p.setupTag ? { setup_tag: p.setupTag } : {}),
    ...(p.confidence != null ? { confidence: p.confidence } : {}),
  });
  if (group.status === "REJECTED") {
    return { group, rejected: true, reason: group.rejection_reason };
  }

  const warnings: string[] = [];
  let finalGroup = group;
  if (p.stop != null) {
    try {
      finalGroup = await updateOptionGroupSpotStopLoss(group.id, p.stop);
    } catch {
      warnings.push("stop-loss didn't attach");
    }
  }
  if (p.target != null) {
    try {
      finalGroup = await updateOptionGroupSpotTarget(finalGroup.id, p.target);
    } catch {
      warnings.push("target didn't attach");
    }
  }
  return {
    group: finalGroup,
    rejected: false,
    reason: null,
    warning: warnings.length ? `opened — but the ${warnings.join(" and ")}; set it below` : undefined,
  };
}

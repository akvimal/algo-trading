import { useEffect, useRef, useState } from "react";

import ManualSettingsPage from "./ManualSettingsPage";
import ManualStatsPage from "./ManualStatsPage";
import {
  type Account,
  type ChecklistAnswer,
  type ChecklistItem,
  type DailyChecklist,
  type ManualOptionLeg,
  type ManualStopLossConfig,
  type OptionPositionStyle,
  type OptionStrikeMoneyness,
  type PendingReview,
  type Segment,
  type StopLossIndicatorParams,
  type StopLossIndicatorType,
  type StopLossInterval,
  type StopLossMethod,
  type TradeImage,
  type TradingSession,
  checkInTradingSession,
  checkOutTradingSession,
  createManualOptionGroup,
  createManualPosition,
  deleteTradeImage,
  fetchAccounts,
  fetchChecklistItems,
  fetchCryptoSymbols,
  fetchDailyChecklist,
  fetchExecPositions,
  fetchLotSize,
  fetchLtp,
  fetchOptionGroupImages,
  fetchOptionGroups,
  fetchPendingReview,
  fetchPositionImages,
  fetchTradingSessions,
  resolveUnderlying,
  squareOffManualPosition,
  squareOffOptionGroup,
  submitDailyChecklist,
  submitOptionGroupReview,
  submitPositionReview,
  tradeImageUrl,
  updateOptionGroupSpotStopLoss,
  updateStopLoss,
  uploadOptionGroupImage,
  uploadPositionImage,
} from "./api";

const ALL_SEGMENTS: Segment[] = ["NSE", "MCX", "CRYPTO"];

// Empty `segments` means every segment - shared by per-row plan checklist
// filtering, the review/day panels, and the editor's own item list.
function appliesToSegment(item: ChecklistItem, segment: Segment): boolean {
  return item.segments.length === 0 || item.segments.includes(segment);
}

const POLL_INTERVAL_MS = 5000;
const STORAGE_KEY = "manual-tab-rows-v4";

// Delta Exchange India currently only lists live options for these two
// CRYPTO perpetuals (confirmed against their real /v2/products endpoint,
// 2026-08-15) - every other live perpetual (e.g. SOLUSD, ETCUSD) shows up
// fine in the full crypto-symbols list for spot/future, but always 422s
// with "no currently-tradeable expiry available" if picked for an option
// order. Hardcoded rather than a new market-data endpoint - Delta's own
// option-eligible underlying list changes rarely enough that this is
// simpler to just update here if/when it does, matching the user's own
// call on scope.
const CRYPTO_OPTION_SYMBOLS = ["BTCUSD", "ETHUSD"];

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// A closed-but-unreviewed trade's own review affordance in the history
// list - opens the inline review form (see toggleInlineReview) right
// under that trade, a per-trade alternative to the platform-wide banner
// at the top of the page (which only ever addresses whichever ONE trade
// is the earliest still blocking every row's Add button).
function ReviewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z" />
      <path d="M8.5 12h7M8.5 15.5h5" />
    </svg>
  );
}

// A closed trade's own "attach a screenshot" affordance - see
// uploadImageForEntry/loadImagesForRow.
function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 15.5 15.5 10 6 19" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

type InstrumentType = "spot" | "future" | "option";
type ExitReason = "manual" | "target" | "stop_loss";

// Exactly one order/position slot per row now ("first open position
// visible at top", per the redesign) - action/instrumentType/optionStyle
// are snapshotted onto the instance at creation so history rows can
// label themselves correctly later without depending on the row's
// current (possibly since-changed) fields - instrumentType/optionStyle
// can't actually change post-creation anymore (segment/symbol/instrument
// are all fixed via the "+ Add instrument" toolbar now), but `action`
// still can while a row is idle, so this snapshot still matters for it.
type OrderInstance = {
  id: string;
  state: "pending" | "open";
  action: "BUY" | "SELL";
  instrumentType: InstrumentType;
  optionStyle?: OptionPositionStyle;
  triggerPrice?: number; // "Spot Limit" - entry watch, on the underlying's own spot price. undefined = market/CMP.
  startedAboveTarget?: boolean; // entry-trigger crossing direction, recorded once at pending-creation time
  quantity?: number; // as typed - undefined means auto-sized
  positionId?: string;
  groupId?: string;
  signalId?: string;
  entryPrice?: number;
  livePrice?: number;
  unrealizedPnl?: number;
  quantityLive?: number;
  // "Spot Target" / "Spot SL Limit" - a browser-side exit watch on the
  // underlying's own spot price (never the traded instrument's own live
  // price - for options that's the premium, not what these fields name),
  // same "watch, not a persisted pending order" pattern the entry trigger
  // above already uses. Editable post-open via Save; not backed by
  // execution's own target_price/stop_loss_price fields at all.
  targetPrice?: number;
  slLimitPrice?: number;
  // The REAL, backend-enforced stop-loss (spot/future only - see
  // execution's ManualPositionCreate/StopLossUpdate) - fixed
  // (stopLossMethod null) or trailing (percent/previous_candle/
  // indicator, execution's own exit-monitor re-anchors it server-side,
  // no browser polling needed at all). A completely separate mechanism
  // from targetPrice/slLimitPrice above - those are a client-side spot-
  // price watch, this is enforced even if the browser tab closes.
  stopLossPrice?: number | null;
  stopLossMethod?: StopLossMethod | null;
  trailingStopEnabled?: boolean;
  // Trade discipline checklist snapshot, captured once at placeOrder time
  // (not re-derived later) - see ManualRow.checklistChecked's own comment
  // for why. Sent to createManualPosition/createManualOptionGroup by
  // executeOrder, whenever this instance actually fires (immediately, or
  // later once a pending trigger price is crossed).
  planChecklist?: ChecklistAnswer[];
  // instrument_type='option' only - the actual resolved leg(s) execution
  // traded (real symbol, e.g. "GOLDM25AUG161000CE", not just the
  // underlying) - naked has 1, spread has 2 (CE+PE). Captured from
  // createManualOptionGroup/fetchOptionGroups' own `legs` field, which
  // the combined Qty/Entry/CMP summary line alone never showed.
  legs?: ManualOptionLeg[];
  error?: string;
};

// Normalized shape for the closed-trades list - built either from a full
// position/group record (poll-detected close) or straight from a
// square-off response (button- or spot-watch-initiated close), see
// handleSquareOff/refreshOpenInstance. action/instrumentType/optionStyle
// are carried over from the OrderInstance that closed, purely for
// labeling (see historyLabel).
type HistoryEntry = {
  id: string;
  action: "BUY" | "SELL";
  instrumentType: InstrumentType;
  optionStyle?: OptionPositionStyle;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  pnl: number | null;
  exit_reason: string | null;
  exit_time: string | null;
  // Which review endpoint owns this trade (PUT /positions/{id}/review vs
  // PUT /option-groups/{id}/review) - `id` above must be the REAL backend
  // position/group id (not a synthetic one) for the review icon below to
  // actually resolve anything.
  kind: "position" | "option_group";
  // Needed to filter the inline review's own 'review'-phase checklist by
  // segment (same appliesToSegment reasoning the global banner already
  // uses) - null (not yet reviewed) is what shows the review icon at all.
  reviewed_at: string | null;
  segment: Segment;
  // The submitted review's own answers - null until reviewed_at is set,
  // then shown read-only (see toggleReviewDetails) so a past review is
  // actually recoverable, not just a "you did this" badge. Freshly
  // detected closes (moveCurrentToHistory) always start these null; only
  // a backend refetch (refreshRowHistory, after PUT .../review) ever
  // populates them.
  review_violation: boolean | null;
  review_notes: string | null;
  review_checklist: ChecklistAnswer[] | null;
  // Frozen at close - only ever set for kind="position" (spot/future,
  // same price unit as entry_price/pnl). Options use a spot-denominated
  // SL against a premium-denominated pnl, so no clean R-multiple exists
  // for them - left null, and the stats page skips them for that one
  // metric while still counting them in trades/win-rate/pnl.
  stop_loss_price: number | null;
  // Which of ManualTab.tsx's two entry modes placed this trade - null for
  // legacy rows closed before this field existed. Purely informational
  // here (see ManualStatsPage's own breakdown for the actual review use).
  order_type: "market" | "limit" | null;
};

type ManualRow = {
  id: string;
  segment: Segment;
  instrumentType: InstrumentType;
  symbol: string;
  action: "BUY" | "SELL";
  optionStyle: OptionPositionStyle;
  moneyness: OptionStrikeMoneyness;
  draftQuantity: string;
  // "market" (default) locks draftLimitPrice to "" and disables the
  // Limit input entirely - placeOrder then always sends no price,
  // executeOrder fetches a FRESH live LTP at submit time (see its own
  // comment), never whatever was last displayed. "limit" unlocks the
  // input for a real trigger price, which instead arms a pending
  // wait-for-cross order (see placeOrder's own branch). Fixes a bug
  // where the old "MKT" quick-fill button wrote a frozen LTP snapshot
  // INTO draftLimitPrice, which placeOrder then treated as a real limit
  // price (a pending trigger, not an immediate market fill) - the order
  // could sit unfilled if price moved away before the next poll tick.
  priceMode: "market" | "limit";
  draftLimitPrice: string; // "Spot Limit" - entry, blank = market/CMP (see priceMode above - only meaningful when priceMode==="limit")
  draftPendingPrice: string; // while current.state==="pending" - editable trigger-price watch, see updatePendingTriggerPrice
  draftTarget: string; // "Spot Target"
  draftSlLimit: string; // "Spot SL Limit" - option rows only, see trailSlEnabled below
  // "Trail SL" - spot/future rows only (options keep draftSlLimit's
  // client-side watch above instead, execution has no method-based SL
  // concept for options). Off = a flat, fixed draftStopLossPrice (the
  // real backend stop_loss_price, not a client-side watch - editable
  // both before Add and after, via Save). On = draftSlMethod + whichever
  // of its own sibling fields that method needs, mirroring execution's
  // own ManualStopLossConfig exactly.
  trailSlEnabled: boolean;
  draftStopLossPrice: string;
  draftSlMethod: StopLossMethod;
  draftSlPercent: string;
  draftSlInterval: StopLossInterval;
  draftSlIndicatorType: StopLossIndicatorType;
  draftSlIndicatorPeriod: string;
  draftSlMultiplier: string;
  lastKnownLtp?: number;
  current: OrderInstance | null;
  history: HistoryEntry[];
  rowError?: string;
  // Trade discipline checklist (Manual tab only) - this row's own
  // in-progress answers, keyed by execution.checklist_items.id. One
  // checklist per ROW (not one shared/global one) since each row plans
  // an independent trade - see docs/architecture.md § 'Trade discipline
  // checklist'. Reset to {} both on page load (never persisted - a stale
  // "already checked" from a past session would defeat the whole point)
  // and immediately after placeOrder fires, same "re-plan every trade"
  // reasoning draftLimitPrice/draftTarget/draftSlLimit already follow.
  checklistChecked: Record<string, boolean>;
  // User-toggleable, persisted (unlike checklistChecked above - this is a
  // pure display preference, not trade-planning state that should reset).
  // Collapsed shows just the compact summary row; the rest of the card
  // (checklist, order fields, history) is hidden until expanded again -
  // lets a busy multi-card session keep only the ones being actively
  // worked on open.
  collapsed: boolean;
};

function newRow(segment: Segment = "NSE", symbol = "", instrumentType: InstrumentType = "option"): ManualRow {
  return {
    id: crypto.randomUUID(),
    segment,
    instrumentType,
    symbol,
    action: "BUY",
    optionStyle: "naked",
    moneyness: "ATM",
    draftQuantity: "1",
    priceMode: "market",
    draftLimitPrice: "",
    draftPendingPrice: "",
    draftTarget: "",
    draftSlLimit: "",
    trailSlEnabled: false,
    draftStopLossPrice: "",
    draftSlMethod: "percent",
    draftSlPercent: "",
    draftSlInterval: "5min",
    draftSlIndicatorType: "ema",
    draftSlIndicatorPeriod: "20",
    draftSlMultiplier: "3",
    current: null,
    history: [],
    checklistChecked: {},
    collapsed: false,
  };
}

// history/rowError/lastKnownLtp/checklistChecked aren't persisted -
// always start fresh on reload (history is re-derivable as trades close
// during the session; persisting it indefinitely could grow unbounded;
// checklistChecked resetting is deliberate discipline, see its own
// comment on ManualRow). `current` (the one pending/open slot, if any)
// does persist, so an armed watch survives a page refresh - but a row
// with NO current has no armed watch to preserve, so its own
// draftLimitPrice/draftTarget/draftSlLimit/draftStopLossPrice are reset
// too (see clearDraftPrices) rather than surfacing a stale value left
// over from a previous, already-closed trade on this same row.
function clearDraftPrices<T extends ManualRow>(r: T): T {
  return { ...r, priceMode: "market", draftLimitPrice: "", draftTarget: "", draftSlLimit: "", draftStopLossPrice: "" };
}

function loadRows(): ManualRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ManualRow[];
    return parsed.map((r) => {
      // collapsed: defaults false for rows saved before this field existed.
      // priceMode: defaults "market" for rows saved before this field
      // existed - matches what a blank draftLimitPrice already meant.
      const fresh = {
        ...r,
        history: [],
        rowError: undefined,
        lastKnownLtp: undefined,
        checklistChecked: {},
        collapsed: !!r.collapsed,
        priceMode: r.priceMode ?? "market",
      };
      return fresh.current == null ? clearDraftPrices(fresh) : fresh;
    });
  } catch {
    return [];
  }
}

function saveRows(rows: ManualRow[]) {
  const persisted = rows.map(({ history, rowError, lastKnownLtp, checklistChecked, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function fmt(n: number | null | undefined, digits = 2): string {
  return n == null ? "-" : n.toFixed(digits);
}

// Quantity display only - up to 4 decimal places (needed for fractional
// CRYPTO lot sizes, e.g. BTCUSD=0.001), but trims trailing zeros so a
// whole-number quantity reads "10", not "10.0000" - same trim already
// used by lotConversionHint's own total below.
function fmtQty(n: number | null | undefined): string {
  return n == null ? "-" : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 0 ? "pnl-positive" : "pnl-negative";
}

// "123.45 (+12.3%)" for one open leg/position row in the current-status
// table below - % is entry_price*qty-based (same base pnlPercentLabel
// uses for a CLOSED trade), omitted entirely (just the bare pnl) when
// either input needed to compute it is missing.
function fmtPnlWithPercent(pnl: number | null | undefined, entryPrice: number | null | undefined, qty: number | null | undefined): string {
  if (pnl == null) return "-";
  const base = entryPrice != null && qty != null ? Math.abs(entryPrice * qty) : 0;
  if (base === 0) return fmt(pnl);
  const pct = (pnl / base) * 100;
  return `${fmt(pnl)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

// Local-date grouping key (YYYY-MM-DD, en-CA gives that ordering
// directly) - same convention ManualStatsPage's own dayKey uses, for the
// date-filter calendar and the per-card selected-day PnL below. A
// browser-local view of "which day", not execution.settings.timezone's
// server-side "today" (the daily checklist's own reference point) - nothing
// here gates trading, it's a display filter only.
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function todayKey(): string {
  return dayKey(new Date().toISOString());
}

// Matches the trade plan checklist's own "Min reward:risk >=1:4" item -
// this is the OBJECTIVE, computed counterpart to that self-attested
// checkbox: when the user has typed concrete Limit/Target/SL numbers,
// don't just ask them to confirm the ratio, actually check it. The real
// threshold is execution.accounts.min_reward_risk_ratio, per segment,
// edited from ManualSettingsPage - this is only the fallback used before
// that fetch resolves (see the accounts state below).
const DEFAULT_MIN_REWARD_RISK_RATIO = 4;

// null whenever the ratio genuinely can't be computed yet - blank
// Target, a trailing/method-based SL (no fixed price known
// client-side ahead of time - only a flat SL Limit counts), or a
// zero-risk (SL == effective entry) input. A blank Limit (market
// order) falls back to the live LTP as the effective entry price -
// refreshes automatically as lastKnownLtp polls update - rather than
// leaving RR unknown. The Add button's own gate treats null as
// "nothing to check", not as a failure - this only blocks placement
// once real numbers are entered and they fall short. Options have no
// Trail SL concept at all - their own flat SL field is draftSlLimit
// (shared with the post-open exit-group), not draftStopLossPrice
// (spot/future's own field, which also doubles as "Trail SL enabled"
// storage via trailSlEnabled).
function computeRR(row: ManualRow): number | null {
  if (row.trailSlEnabled) return null;
  const limit = row.draftLimitPrice ? Number(row.draftLimitPrice) : row.lastKnownLtp ?? null;
  const target = row.draftTarget ? Number(row.draftTarget) : null;
  const slRaw = row.instrumentType === "option" ? row.draftSlLimit : row.draftStopLossPrice;
  const sl = slRaw ? Number(slRaw) : null;
  if (limit == null || target == null || sl == null) return null;
  if (!Number.isFinite(limit) || !Number.isFinite(target) || !Number.isFinite(sl)) return null;
  const risk = Math.abs(limit - sl);
  if (risk <= 0) return null;
  const reward = Math.abs(target - limit);
  return reward / risk;
}

// "Naked Call"/"Naked Put"/"Bull Call Spread"/"Bear Put Spread" for
// options (mirrors the Strategy <select>'s own action-conditional
// labels), "BUY spot"/"SELL future" otherwise.
function historyLabel(h: HistoryEntry): string {
  if (h.instrumentType === "option") {
    if (h.optionStyle === "naked") return h.action === "BUY" ? "Naked Call" : "Naked Put";
    return h.action === "BUY" ? "Bull Call Spread" : "Bear Put Spread";
  }
  return `${h.action} ${h.instrumentType}`;
}

// Builds execution's ManualStopLossConfig from a row's Trail SL draft
// fields - shared by both placeOrder (arms it at entry) and handleSave
// (attaches/replaces it after the position is already open), since both
// send the identical shape. `{}` (no keys at all) means "leave the
// stop-loss alone" for handleSave's purposes, or "no stop-loss requested"
// for placeOrder's - createManualPosition/updateStopLoss both treat an
// absent field as absent, not null.
function buildStopLossConfig(row: ManualRow): ManualStopLossConfig {
  if (!row.trailSlEnabled) {
    return row.draftStopLossPrice ? { stop_loss_price: Number(row.draftStopLossPrice) } : {};
  }
  const base: ManualStopLossConfig = { stop_loss_method: row.draftSlMethod, trailing_stop_enabled: true };
  if (row.draftSlMethod === "percent") {
    return row.draftSlPercent ? { ...base, stop_loss_percent: Number(row.draftSlPercent) } : {};
  }
  if (row.draftSlMethod === "previous_candle") {
    return { ...base, stop_loss_interval: row.draftSlInterval };
  }
  // indicator
  if (!row.draftSlIndicatorPeriod) return {};
  const params: StopLossIndicatorParams =
    row.draftSlIndicatorType === "supertrend"
      ? { period: Number(row.draftSlIndicatorPeriod), multiplier: Number(row.draftSlMultiplier) }
      : { period: Number(row.draftSlIndicatorPeriod) };
  return {
    ...base,
    stop_loss_interval: row.draftSlInterval,
    stop_loss_indicator_type: row.draftSlIndicatorType,
    stop_loss_indicator_params: params,
  };
}

function pnlPercentLabel(h: HistoryEntry): string {
  if (h.pnl == null || h.entry_price == null || h.quantity == null) return "";
  const base = Math.abs(h.entry_price * h.quantity);
  if (base === 0) return "";
  const pct = (h.pnl / base) * 100;
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

// "Aug-15  12:24 PM" - compact, matching the redesigned collapsible list's
// own density (App.tsx's shared formatDateTimeNoSeconds is a full
// "8/15/2026, 12:24 PM" style, too wide for this one-line-per-trade list).
function formatCompact(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate().toString().padStart(2, "0");
  const time = d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${month}-${day}  ${time}`;
}

// Just the clock time (no date, no seconds) - the session bar only ever
// shows TODAY's own check-in/out (see formatSessionSummary below), so a
// date prefix is redundant there; seconds precision used to be needed to
// make a same-minute re-click visibly move, dropped per explicit request.
function formatTimeOnly(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Today's session bar shows only the MOST RECENT check-in/out interval in
// full, plus a rolled-up "+N earlier (Xh)" for everything before it -
// listing every interval in full (the original design) got unreadable
// once a segment had several check-in/check-out cycles in one day.
// `sessions` is oldest-first (see refreshTradingSessions).
function formatDurationMs(ms: number): string {
  const totalMinutes = ms / 60000;
  if (totalMinutes < 60) return `${Math.round(totalMinutes)}m`;
  return `${(totalMinutes / 60).toFixed(1)}h`;
}

function formatSessionSummary(sessions: TradingSession[]): string {
  if (sessions.length === 0) return "Not checked in yet";
  const mostRecent = sessions[sessions.length - 1];
  const recent = `${formatTimeOnly(mostRecent.checked_in_at)}–${mostRecent.checked_out_at ? formatTimeOnly(mostRecent.checked_out_at) : "active"}`;
  const previous = sessions.slice(0, -1);
  if (previous.length === 0) return recent;
  const totalMs = previous.reduce((sum, s) => {
    if (!s.checked_out_at) return sum; // shouldn't happen for a non-most-recent session, but guard anyway
    return sum + (new Date(s.checked_out_at).getTime() - new Date(s.checked_in_at).getTime());
  }, 0);
  return `${recent} · +${previous.length} earlier (${formatDurationMs(totalMs)})`;
}

// Direction-aware crossing check for the spot-price exit watch - mirrors
// the entry trigger's own startedAboveTarget crossing logic, but simpler:
// the position's own `action` already fixes which side is "favorable"
// (target) vs "unfavorable" (stop), no need to record a starting side.
function checkExitTrigger(instance: OrderInstance, ltp: number): ExitReason | null {
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

export default function ManualTab() {
  const [rows, setRows] = useState<ManualRow[]>(() => loadRows());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Segment/Symbol/Instrument for "+ Add instrument"'s NEXT card -
  // picked ahead of time in the toolbar, rather than editable on the
  // card afterward (removed entirely at the user's explicit request,
  // along with the manual-lock feature that used to guard those fields
  // from fat-fingering - now moot, there's nothing left to fat-finger).
  // Segment defaulting to NSE-only used to make it impossible to ever
  // add an MCX/CRYPTO card without checking into NSE first (its own
  // check-in gate hid the Segment field) - reproduced live 2026-08-26,
  // fixed by this toolbar picker.
  const [newRowSegment, setNewRowSegment] = useState<Segment>("NSE");
  const [newRowSymbol, setNewRowSymbol] = useState("");
  const [newRowInstrumentType, setNewRowInstrumentType] = useState<InstrumentType>("option");

  // Which rows have their closed-trades list expanded - toggled by
  // clicking "Present day PnL" (the mockup's "Collapsible section below"
  // divider/toggle), collapsed by default.
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});

  // Cards persist until explicitly removed - the × asks for confirmation
  // first (an in-page Yes/No, not window.confirm - a native dialog blocks
  // the whole tab's event loop, including this same click handler's own
  // follow-up work). Only one row confirms removal at a time.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Transient "Saved" confirmation next to a row's own Save button (Spot
  // Target/SL Limit/trailing-SL config) - handleSave previously only
  // showed anything on FAILURE (row.current.error); a successful save
  // updated state silently, giving no visible confirmation at all. Keyed
  // by row id, cleared automatically a couple seconds after it's set.
  const [justSaved, setJustSaved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    saveRows(rows);
  }, [rows]);

  // Backfill every already-loaded row's trade history on first mount -
  // see refreshRowHistory's own docstring for why this is needed at all
  // (history itself is never persisted to localStorage).
  useEffect(() => {
    for (const row of rowsRef.current) {
      if (row.symbol.trim()) void refreshRowHistory(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trade discipline checklist (Manual tab only) - see docs/architecture.md
  // § 'Trade discipline checklist'. checklistItems: the shared, user-
  // editable master list (one fetch, reused as checkboxes by every row -
  // see ManualRow.checklistChecked). pendingReview: the platform-wide
  // "review your last closed trade" reminder - non-null surfaces the
  // banner below regardless of which row/symbol it came from. Used to
  // also block every row's Add button until reviewed; that hard gate was
  // removed 2026-08-26 at the user's explicit request - this is a
  // reminder now, not a restriction.
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  // Split by phase for rendering - 'plan' per-row (see ManualRow.
  // checklistChecked), 'review' in the post-trade banner below, 'day'
  // once per calendar day per segment (see dailyChecklists below).
  const planItems = checklistItems.filter((i) => i.phase === "plan");
  const reviewItems = checklistItems.filter((i) => i.phase === "review");
  const dayItems = checklistItems.filter((i) => i.phase === "day");
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
  // Which sub-view the Manual tab shows - "settings" swaps the row list
  // for ManualSettingsPage (checklist items editor + per-segment risk
  // knobs), leaving the day-checklist boxes/pending-review banner above it
  // untouched either way.
  const [view, setView] = useState<"trading" | "settings" | "stats">("trading");
  // Per-segment risk knobs (execution.accounts) - risk_per_trade_pct feeds
  // execution's own risk-based sizing, min_reward_risk_ratio gates this
  // row's own Add/Update button below (see computeRR/rrBelowMin). Both are
  // edited from ManualSettingsPage; re-fetched here on mount and whenever
  // that page is closed so a just-saved change takes effect immediately.
  const [accounts, setAccounts] = useState<Account[]>([]);

  async function refreshAccounts() {
    try {
      setAccounts(await fetchAccounts());
    } catch {
      // leave the existing list as-is - rows just keep using whatever
      // min_reward_risk_ratio was last successfully fetched
    }
  }

  async function refreshChecklistItems() {
    try {
      setChecklistItems(await fetchChecklistItems());
    } catch {
      // leave the existing list as-is - the editor/checkboxes just show
      // whatever was last successfully fetched
    }
  }

  // Today's day-checklist submission per segment (null = not submitted
  // yet today - the gate is active for that segment, see
  // dailySatisfied). Fetched for all 3 segments up front (cheap - one
  // row max each) rather than lazily per row, so the gate/banner can
  // render correctly even before any row happens to use a given segment.
  const [dailyChecklists, setDailyChecklists] = useState<Record<Segment, DailyChecklist | null>>({
    NSE: null,
    MCX: null,
    CRYPTO: null,
  });
  // This segment's own in-progress answers for the day-checklist FORM -
  // prefilled from dailyChecklists[segment] when already submitted today
  // (still editable), blank otherwise. Keyed by item id.
  const [dayFormAnswers, setDayFormAnswers] = useState<Record<Segment, Record<string, boolean>>>({
    NSE: {},
    MCX: {},
    CRYPTO: {},
  });
  // ONE free-text observation per segment for the whole submission, not
  // per item - see execution's own daily_checklist_log.notes comment.
  const [dayFormNotes, setDayFormNotes] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [daySubmitting, setDaySubmitting] = useState<Segment | null>(null);
  const [dayError, setDayError] = useState<{ segment: Segment; message: string } | null>(null);
  // Collapsed = just the one-line "submitted HH:MM" summary, no
  // checkboxes/notes/button - a submitted segment starts collapsed
  // (nothing left to do) and re-collapses the moment Submit/Update
  // succeeds; clicking the summary line re-expands it for editing.
  const [dayCollapsed, setDayCollapsed] = useState<Record<Segment, boolean>>({
    NSE: false,
    MCX: false,
    CRYPTO: false,
  });
  // refreshDailyChecklists is also invoked from the poll loop's
  // setInterval below (useEffect with an empty dep array - see
  // rowsRef's own identical comment) - that interval's callback is fixed
  // at mount and never sees a later render's dayItems/dayFormAnswers, so
  // reading those directly inside refreshDailyChecklists would silently
  // re-prefill with WRONG (label-text, not id) keys every 5s using the
  // permanently-stale mount-time values, clobbering the correct prefill.
  // Refs sidestep this the same way rowsRef already does for `rows`.
  const dayItemsRef = useRef(dayItems);
  dayItemsRef.current = dayItems;
  const dayFormAnswersRef = useRef(dayFormAnswers);
  dayFormAnswersRef.current = dayFormAnswers;

  async function refreshDailyChecklists() {
    try {
      const results = await Promise.all(ALL_SEGMENTS.map((seg) => fetchDailyChecklist(seg)));
      const bySegment = Object.fromEntries(results.map((r) => [r.segment, r])) as Record<Segment, DailyChecklist>;
      setDailyChecklists(bySegment);
      // Prefill each segment's form from its own latest submission, ONLY
      // the first time it appears (a submitted answer showing up) - once
      // the user starts editing the form for today, further polls
      // shouldn't silently overwrite in-progress edits with the
      // last-saved version. Collapses it too, same "already done" reason.
      //
      // Reads dayFormAnswersRef/dayItemsRef (NOT the closed-over
      // dayFormAnswers/dayItems variables directly) - this function is
      // also invoked from the poll loop's setInterval, whose callback is
      // fixed at mount; reading the bare variables there would always see
      // the permanently-stale mount-time values (dayItems=[], answers={})
      // and re-prefill with WRONG (label-text) keys every 5s, clobbering
      // the correct prefill - see dayItemsRef's own comment. Also NOT
      // computed by mutating a local array from inside setDayFormAnswers'
      // updater and reading it right after - React doesn't guarantee that
      // updater has run yet at that point.
      const newlyPrefilled = ALL_SEGMENTS.filter(
        (seg) => Object.keys(dayFormAnswersRef.current[seg]).length === 0 && bySegment[seg]?.answers != null,
      );
      if (newlyPrefilled.length === 0) return;

      setDayFormAnswers((prev) => {
        const next = { ...prev };
        for (const seg of newlyPrefilled) {
          next[seg] = Object.fromEntries(
            bySegment[seg].answers!.map((a) => [
              dayItemsRef.current.find((i) => i.label === a.label)?.id ?? a.label,
              a.checked,
            ]),
          );
        }
        return next;
      });
      setDayFormNotes((prev) => {
        const next = { ...prev };
        for (const seg of newlyPrefilled) next[seg] = bySegment[seg]?.notes ?? "";
        return next;
      });
      setDayCollapsed((prev) => {
        const next = { ...prev };
        for (const seg of newlyPrefilled) next[seg] = true;
        return next;
      });
    } catch {
      // leave the existing values as-is - retried next poll tick
    }
  }

  // Today's check-in/check-out session INSTANCES per segment, oldest
  // first - a segment can have several across a day (checked in, broke
  // for lunch, checked in again), not just one. Deliberately independent
  // of dayItems (unlike dailyChecklists' own prefill logic above) since
  // check-in should work even for a segment with no 'day'-phase
  // checklist items configured at all.
  const [tradingSessions, setTradingSessions] = useState<Record<Segment, TradingSession[]>>({
    NSE: [],
    MCX: [],
    CRYPTO: [],
  });
  const [sessionActionLoading, setSessionActionLoading] = useState<Segment | null>(null);
  const [sessionError, setSessionError] = useState<{ segment: Segment; message: string } | null>(null);

  async function refreshTradingSessions() {
    try {
      const results = await fetchTradingSessions();
      const today = todayKey();
      setTradingSessions((prev) => {
        const next = { ...prev };
        for (const seg of ALL_SEGMENTS) {
          next[seg] = results
            .filter((r) => r.segment === seg && r.log_date === today)
            .sort((a, b) => (a.checked_in_at < b.checked_in_at ? -1 : 1));
        }
        return next;
      });
    } catch {
      // leave the existing values as-is - retried next poll tick
    }
  }

  // Whether `segment` currently has an open (checked_out_at null)
  // session today - gates both buttons below (Check In disabled while
  // true, Check Out disabled while false), mirroring the server's own
  // _open_trading_session gate.
  function hasOpenSession(segment: Segment): boolean {
    return tradingSessions[segment].some((s) => s.checked_out_at == null);
  }

  async function checkIn(segment: Segment) {
    setSessionActionLoading(segment);
    setSessionError(null);
    try {
      await checkInTradingSession(segment);
      await refreshTradingSessions();
    } catch (err) {
      setSessionError({ segment, message: err instanceof Error ? err.message : "failed to check in" });
    } finally {
      setSessionActionLoading(null);
    }
  }

  async function checkOut(segment: Segment) {
    setSessionActionLoading(segment);
    setSessionError(null);
    try {
      await checkOutTradingSession(segment);
      await refreshTradingSessions();
    } catch (err) {
      setSessionError({ segment, message: err instanceof Error ? err.message : "failed to check out" });
    } finally {
      setSessionActionLoading(null);
    }
  }

  // Whether segment's day-checklist gate is satisfied - true (nothing to
  // block) if it has no active 'day'-phase items scoped to it at all, or
  // today's row already exists (submitted=true regardless of what the
  // answers actually were - see execution's own find_missing_daily_checklist).
  function dailySatisfied(segment: Segment): boolean {
    if (!dayItems.some((i) => appliesToSegment(i, segment))) return true;
    return dailyChecklists[segment]?.answers != null;
  }

  async function submitDailyForSegment(segment: Segment) {
    setDaySubmitting(segment);
    setDayError(null);
    try {
      const items = dayItems.filter((i) => appliesToSegment(i, segment));
      const answers: ChecklistAnswer[] = items.map((item) => ({
        label: item.label,
        checked: !!dayFormAnswers[segment][item.id],
      }));
      const saved = await submitDailyChecklist(segment, answers, dayFormNotes[segment] || undefined);
      setDailyChecklists((prev) => ({ ...prev, [segment]: saved }));
      setDayCollapsed((prev) => ({ ...prev, [segment]: true }));
    } catch (err) {
      setDayError({ segment, message: err instanceof Error ? err.message : "failed to submit today's checklist" });
    } finally {
      setDaySubmitting(null);
    }
  }

  useEffect(() => {
    void refreshChecklistItems();
    void refreshAccounts();
    void refreshTradingSessions();
    fetchPendingReview()
      .then(setPendingReview)
      .catch(() => {});
  }, []);

  // Resets the top banner's own review form fields whenever pendingReview
  // changes to a genuinely different trade AND no row currently matches
  // its segment+symbol (see submitPendingReviewForm's own comment) - so a
  // stale answer from a PREVIOUS bannerform trade never silently carries
  // over onto the next one. No-op whenever a matching row exists, since
  // that trade's own review lives in its Trade History row instead.
  useEffect(() => {
    if (!pendingReview) return;
    const hasCard = rows.some((r) => r.segment === pendingReview.segment && r.symbol === pendingReview.symbol);
    if (hasCard) return;
    setInlineReviewFollowedPlan(null);
    setInlineReviewNotes("");
    setInlineReviewAcceptedLoss(false);
    setInlineReviewChecklistChecked({});
    setInlineReviewError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReview?.id]);

  // Re-fetched whenever checklistItems changes (not just once on mount) -
  // refreshDailyChecklists' own answer-key matching needs dayItems
  // populated first, which only happens once the GET /checklist-items
  // fetch above resolves. Skipped entirely while checklistItems is still
  // the initial empty array (before that fetch resolves) - firing then
  // would key the prefilled answers by label text (dayItems.find(...)
  // finds nothing yet) instead of the real item id, which the "only
  // prefill once" guard below then locks in permanently - every checkbox
  // renders unchecked forever after, even though the backend has it
  // saved. Real deletions (checklistItems settling at length 0) skip this
  // fetch too, but there's nothing to gate/show in that case anyway.
  useEffect(() => {
    if (checklistItems.length === 0) return;
    void refreshDailyChecklists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklistItems]);

  // Per-trade review form, opened from a history row's own review icon -
  // the ONLY way to submit a review now (the platform-wide banner below
  // used to duplicate this same form inline above every card; removed in
  // favor of pointing at the one trade history row instead - see
  // pendingReview's own render below). Submitting here works for ANY
  // closed-but-unreviewed manual trade by id, whether or not it's the one
  // currently gating the platform - the gate itself only clears once the
  // true earliest one is done, but recording review data ahead of that is
  // still useful. One form open at a time (inlineReviewId identifies
  // which history entry), same "only one at a time" pattern
  // confirmRemoveId already uses.
  const [inlineReviewId, setInlineReviewId] = useState<string | null>(null);
  // Read-only "what did I actually answer" view for an ALREADY-reviewed
  // history entry - separate from inlineReviewId above (that one's for
  // submitting a NEW review). One at a time, same pattern.
  const [viewReviewId, setViewReviewId] = useState<string | null>(null);
  // Screenshots attached to a closed trade for future review, keyed by
  // history entry id - fetched lazily (loadImagesForEntry) whenever a
  // row's Trade History is expanded, not on every row load, since most
  // entries never get an image at all. uploadingImageId disables that
  // one entry's own upload control while its request is in flight (not
  // a global lock - uploading to one trade shouldn't block another).
  const [imagesByEntryId, setImagesByEntryId] = useState<Record<string, TradeImage[]>>({});
  const [uploadingImageId, setUploadingImageId] = useState<string | null>(null);
  const [imageError, setImageError] = useState<{ entryId: string; message: string } | null>(null);
  // Which history entries have their own "attached screenshots" panel
  // open - the actual upload control (and existing thumbnails) live only
  // in there, not in the compact summary row, so the row-level icon
  // below is a pure expand/collapse toggle, not a direct file-picker
  // trigger.
  const [expandedImagesId, setExpandedImagesId] = useState<Record<string, boolean>>({});
  const [inlineReviewFollowedPlan, setInlineReviewFollowedPlan] = useState<boolean | null>(null);
  const [inlineReviewNotes, setInlineReviewNotes] = useState("");
  const [inlineReviewAcceptedLoss, setInlineReviewAcceptedLoss] = useState(false);
  const [inlineReviewChecklistChecked, setInlineReviewChecklistChecked] = useState<Record<string, boolean>>({});
  const [inlineReviewError, setInlineReviewError] = useState<string | undefined>();
  const [inlineReviewSubmitting, setInlineReviewSubmitting] = useState(false);

  function toggleInlineReview(entryId: string) {
    if (inlineReviewId === entryId) {
      setInlineReviewId(null);
      return;
    }
    setInlineReviewId(entryId);
    setInlineReviewFollowedPlan(null);
    setInlineReviewNotes("");
    setInlineReviewAcceptedLoss(false);
    setInlineReviewChecklistChecked({});
    setInlineReviewError(undefined);
  }

  async function submitInlineReview(row: ManualRow, entry: HistoryEntry) {
    if (inlineReviewFollowedPlan === null) return;
    const violation = !inlineReviewFollowedPlan;
    if (violation && !inlineReviewNotes.trim()) {
      setInlineReviewError("Describe what was violated before submitting.");
      return;
    }
    if (entry.pnl != null && entry.pnl < 0 && !inlineReviewAcceptedLoss) {
      setInlineReviewError("Check \"I accept this loss\" before submitting.");
      return;
    }
    setInlineReviewSubmitting(true);
    setInlineReviewError(undefined);
    try {
      const checklist: ChecklistAnswer[] = reviewItems
        .filter((item) => appliesToSegment(item, entry.segment))
        .map((item) => ({
          label: item.label,
          checked: !!inlineReviewChecklistChecked[item.id],
        }));
      const payload = {
        violation,
        notes: inlineReviewNotes.trim() || undefined,
        accepted_loss: inlineReviewAcceptedLoss,
        checklist,
      };
      if (entry.kind === "position") {
        await submitPositionReview(entry.id, payload);
      } else {
        await submitOptionGroupReview(entry.id, payload);
      }
      const reviewedAt = new Date().toISOString();
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? { ...r, history: r.history.map((h) => (h.id === entry.id ? { ...h, reviewed_at: reviewedAt } : h)) }
            : r,
        ),
      );
      setInlineReviewId(null);
      // This trade may have been the one gating every row's Add button -
      // refresh so that clears immediately rather than waiting for the
      // next poll tick.
      fetchPendingReview()
        .then(setPendingReview)
        .catch(() => {});
    } catch (err) {
      setInlineReviewError(err instanceof Error ? err.message : "failed to submit review");
    } finally {
      setInlineReviewSubmitting(false);
    }
  }

  // The top banner's own review form - shown (instead of the compact
  // "open that instrument's card..." notice) whenever NO current row
  // matches pendingReview's own segment+symbol, e.g. its card was
  // removed after the trade closed. Reuses the same inlineReview*
  // fields/reset-on-submit shape as submitInlineReview above (only one
  // review can be in progress at a time regardless of which surface
  // shows it - a missing row here means no row-level form could be
  // competing for the same trade anyway).
  async function submitPendingReviewForm() {
    if (!pendingReview || inlineReviewFollowedPlan === null) return;
    const violation = !inlineReviewFollowedPlan;
    if (violation && !inlineReviewNotes.trim()) {
      setInlineReviewError("Describe what was violated before submitting.");
      return;
    }
    if (pendingReview.pnl != null && pendingReview.pnl < 0 && !inlineReviewAcceptedLoss) {
      setInlineReviewError("Check \"I accept this loss\" before submitting.");
      return;
    }
    setInlineReviewSubmitting(true);
    setInlineReviewError(undefined);
    try {
      const checklist: ChecklistAnswer[] = reviewItems
        .filter((item) => appliesToSegment(item, pendingReview.segment))
        .map((item) => ({
          label: item.label,
          checked: !!inlineReviewChecklistChecked[item.id],
        }));
      const payload = {
        violation,
        notes: inlineReviewNotes.trim() || undefined,
        accepted_loss: inlineReviewAcceptedLoss,
        checklist,
      };
      if (pendingReview.kind === "position") {
        await submitPositionReview(pendingReview.id, payload);
      } else {
        await submitOptionGroupReview(pendingReview.id, payload);
      }
      setInlineReviewFollowedPlan(null);
      setInlineReviewNotes("");
      setInlineReviewAcceptedLoss(false);
      setInlineReviewChecklistChecked({});
      const next = await fetchPendingReview();
      setPendingReview(next);
    } catch (err) {
      setInlineReviewError(err instanceof Error ? err.message : "failed to submit review");
    } finally {
      setInlineReviewSubmitting(false);
    }
  }

  // Fetches every history entry's own attached images in parallel -
  // called once per row whenever its Trade History is expanded (see the
  // divider's own onClick), not on every row load, since most trades
  // never get one at all. Only today's entries - the only ones the list
  // itself renders (see todaysHistory's own comment).
  async function loadImagesForRow(row: ManualRow) {
    const today = todayKey();
    const results = await Promise.all(
      row.history
        .filter((h) => h.exit_time && dayKey(h.exit_time) === today)
        .map(async (h): Promise<readonly [string, TradeImage[]]> => {
          try {
            const images = h.kind === "position" ? await fetchPositionImages(h.id) : await fetchOptionGroupImages(h.id);
            return [h.id, images];
          } catch {
            return [h.id, []];
          }
        }),
    );
    setImagesByEntryId((prev) => {
      const next = { ...prev };
      for (const [id, images] of results) next[id] = images;
      return next;
    });
  }

  async function uploadImageForEntry(entry: HistoryEntry, file: File) {
    setUploadingImageId(entry.id);
    setImageError(null);
    try {
      const uploaded =
        entry.kind === "position" ? await uploadPositionImage(entry.id, file) : await uploadOptionGroupImage(entry.id, file);
      setImagesByEntryId((prev) => ({ ...prev, [entry.id]: [...(prev[entry.id] ?? []), uploaded] }));
    } catch (err) {
      setImageError({ entryId: entry.id, message: err instanceof Error ? err.message : "failed to upload image" });
    } finally {
      setUploadingImageId(null);
    }
  }

  async function removeImage(entry: HistoryEntry, imageId: string) {
    try {
      await deleteTradeImage(imageId);
      setImagesByEntryId((prev) => ({ ...prev, [entry.id]: (prev[entry.id] ?? []).filter((img) => img.id !== imageId) }));
    } catch (err) {
      setImageError({ entryId: entry.id, message: err instanceof Error ? err.message : "failed to delete image" });
    }
  }

  // Every active item must be checked - vacuously true (nothing to check)
  // once every checklist item has been deleted/deactivated.
  // This row's own applicable 'plan'-phase items - filtered by segment
  // (see appliesToSegment) since e.g. OI change is NSE-only.
  function planItemsForRow(row: ManualRow): ChecklistItem[] {
    return planItems.filter((item) => appliesToSegment(item, row.segment));
  }

  function allChecklistChecked(row: ManualRow): boolean {
    return planItemsForRow(row).every((item) => row.checklistChecked[item.id]);
  }

  // Backs the CRYPTO symbol dropdown below - fetched once, not per-row,
  // since it's the same live symbol list for every row. Fails silently
  // (stays []) rather than blocking the form - a row's Symbol field just
  // falls back to free text if this hasn't loaded yet.
  const [cryptoSymbols, setCryptoSymbols] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCryptoSymbols()
      .then((symbols) => {
        if (!cancelled) setCryptoSymbols(symbols);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Real per-symbol lot multiplier - e.g. CRYPTO futures like
  // BTCUSD=0.001, or an NSE/MCX F&O contract's real lot size (NIFTY=50
  // etc) - fetched lazily per symbol as rows reference one, cached by
  // symbol since it's static (not a live-updating value like price).
  // Backs the "Lots" quantity field/order-value preview (CRYPTO) and
  // riskBasedLots' own computation below (every segment, since an
  // enforced risk-based lot count needs the real lot size to be
  // accurate, not just for CRYPTO's own display hint).
  const [lotSizeCache, setLotSizeCache] = useState<Record<string, number>>({});
  useEffect(() => {
    const missing = rows.filter((r) => r.instrumentType === "future" && r.symbol && !(r.symbol in lotSizeCache));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((r) => fetchLotSize(r.segment, r.symbol).then((lot) => [r.symbol, lot] as const).catch(() => null)),
    ).then((results) => {
      if (cancelled) return;
      const updates = Object.fromEntries(results.filter((r): r is readonly [string, number] => r !== null));
      if (Object.keys(updates).length > 0) setLotSizeCache((prev) => ({ ...prev, ...updates }));
    });
    return () => {
      cancelled = true;
    };
  }, [rows, lotSizeCache]);

  // Manual tab's own risk-based Lot auto-sizing (Account.
  // enforce_risk_based_lots) - mirrors position_manager.
  // compute_risk_based_quantity exactly, but stays purely client-side:
  // the computed lot count is written into draftQuantity and sent as an
  // explicit quantity at order time, same as a manually typed one, so
  // there's no separate server-side enforcement to keep in sync with
  // this. Spot/future only - options have no comparable premium-vs-spot
  // risk figure (same reasoning computeRR/ManualStatsPage's avg-R stat
  // already exclude them for). Returns null whenever it can't be
  // computed yet (no fixed SL, trailing SL, or SL == entry) - same
  // "nothing to enforce yet" contract computeRR's own null already uses.
  function computeRiskBasedLots(row: ManualRow, capitalPerTrade: number, riskPerTradePct: number, lotSize: number): number | null {
    if (row.trailSlEnabled) return null;
    const entry = row.draftLimitPrice ? Number(row.draftLimitPrice) : row.lastKnownLtp ?? null;
    const sl = row.draftStopLossPrice ? Number(row.draftStopLossPrice) : null;
    if (entry == null || sl == null || !Number.isFinite(entry) || !Number.isFinite(sl)) return null;
    const stopDistance = Math.abs(entry - sl);
    if (stopDistance <= 0) return null;
    const riskAmount = (capitalPerTrade * riskPerTradePct) / 100;
    const riskBasedLots = Math.floor(riskAmount / (stopDistance * lotSize));
    const capitalCappedLots = Math.max(1, Math.floor(capitalPerTrade / (entry * lotSize)));
    return Math.max(1, Math.min(riskBasedLots, capitalCappedLots));
  }

  // Keeps draftQuantity in sync with the risk-based computation above
  // for every row whose segment has enforce_risk_based_lots on - can't
  // live inside rows.map's own render (hooks can't run in a loop), so
  // this walks every row once per relevant change instead. Converges:
  // once draftQuantity already matches the computed value, the inner
  // updateRow is skipped, so this doesn't loop.
  useEffect(() => {
    for (const row of rows) {
      if (row.current || row.instrumentType === "option") continue;
      const account = accounts.find((a) => a.segment === row.segment);
      if (!account?.enforce_risk_based_lots) continue;
      const lotSize = row.instrumentType === "future" ? lotSizeCache[row.symbol] ?? 1 : 1;
      const lots = computeRiskBasedLots(row, account.capital_per_trade, account.risk_per_trade_pct, lotSize);
      const desired = lots != null ? String(lots) : "";
      if (row.draftQuantity !== desired) updateRow(row.id, { draftQuantity: desired });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, accounts, lotSizeCache]);

  function updateRow(id: string, patch: Partial<ManualRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // A bare underlying (e.g. "GOLDM") isn't always a directly-quotable
  // Dhan/Delta symbol on its own - resolve it to its chart_symbol/
  // chart_exchange first (see api.ts's ResolvedUnderlying). Every "watch
  // the underlying's live price" call site in this file goes through this
  // instead of a raw fetchLtp(segment, symbol) - resolve_underlying is a
  // local instrument-master lookup on market-data (no Dhan/Delta API call
  // of its own), so doing it on every poll tick alongside the LTP fetch
  // costs nothing against Dhan's own rate limit.
  async function fetchUnderlyingLtp(segment: Segment, symbol: string): Promise<number> {
    const resolved = await resolveUnderlying(segment, symbol);
    return fetchLtp(resolved.chart_exchange, resolved.chart_symbol);
  }

  // Fetches immediately on a Segment/Symbol change so the live price shown
  // next to the Symbol field doesn't wait for the next 5s poll tick (the
  // poll loop below still keeps it fresh after that, same as it already
  // does for lastKnownLtp everywhere else it's used).
  async function refreshLtp(rowId: string, segment: Segment, symbol: string) {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed) return;
    try {
      const ltp = await fetchUnderlyingLtp(segment, trimmed);
      updateRow(rowId, { lastKnownLtp: ltp });
    } catch {
      // leave lastKnownLtp as-is - the poll loop will retry
    }
  }

  // Merges a freshly-fetched backend history list into a row's existing
  // one, backend data winning on id collisions (fresher reviewed_at etc.
  // than whatever a live poll-tick close might have locally recorded).
  // Existing entries the fetch didn't return (e.g. an older trade past
  // the fetch's own limit) are kept, not dropped.
  function mergeHistory(existing: HistoryEntry[], fetched: HistoryEntry[]): HistoryEntry[] {
    const byId = new Map<string, HistoryEntry>();
    for (const h of existing) byId.set(h.id, h);
    for (const h of fetched) byId.set(h.id, h);
    return Array.from(byId.values()).sort((a, b) => (b.exit_time ?? "").localeCompare(a.exit_time ?? ""));
  }

  // Backfills a row's "Trade history" from execution's own records -
  // history/rowError/lastKnownLtp are deliberately NOT persisted to
  // localStorage (see loadRows' own comment), so without this, a page
  // reload always showed an empty history list even though the trade was
  // saved server-side all along - only closes detected LIVE during the
  // current browser session (via moveCurrentToHistory) ever populated it.
  // Called on mount for every loaded row and again whenever Symbol is
  // blurred (same trigger point refreshLtp already uses) - manual_only
  // scopes it to Strategy-free trades (a Strategy-driven position could
  // otherwise share this row's own symbol/segment and pollute its
  // history), status=CLOSED since an OPEN one is already `row.current`.
  async function refreshRowHistory(row: ManualRow) {
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) return;
    try {
      if (row.instrumentType === "option") {
        const groups = await fetchOptionGroups({
          symbol,
          segment: row.segment,
          status: "CLOSED",
          manualOnly: true,
          limit: 50,
        });
        const fetched: HistoryEntry[] = groups.map((g) => ({
          id: g.id,
          action: g.action,
          instrumentType: "option",
          optionStyle: g.strategy_type.startsWith("naked") ? "naked" : "spread",
          entry_price: g.net_debit,
          exit_price: null,
          quantity: g.quantity,
          pnl: g.pnl,
          exit_reason: g.exit_reason,
          exit_time: g.exit_time,
          kind: "option_group",
          reviewed_at: g.reviewed_at,
          segment: row.segment,
          review_violation: g.review_violation,
          review_notes: g.review_notes,
          review_checklist: g.review_checklist,
          stop_loss_price: null,
          order_type: g.order_type,
        }));
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, history: mergeHistory(r.history, fetched) } : r)));
      } else {
        const positions = await fetchExecPositions({
          symbol,
          segment: row.segment,
          status: "CLOSED",
          manualOnly: true,
          limit: 50,
        });
        const fetched: HistoryEntry[] = positions.map((p) => ({
          id: p.id,
          action: p.action,
          instrumentType: p.instrument_type as InstrumentType,
          entry_price: p.entry_price,
          exit_price: p.exit_price,
          quantity: p.quantity,
          pnl: p.pnl,
          exit_reason: p.exit_reason,
          exit_time: p.exit_time,
          kind: "position",
          review_violation: p.review_violation,
          review_notes: p.review_notes,
          review_checklist: p.review_checklist,
          stop_loss_price: p.stop_loss_price,
          reviewed_at: p.reviewed_at,
          segment: row.segment,
          order_type: p.order_type,
        }));
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, history: mergeHistory(r.history, fetched) } : r)));
      }
    } catch {
      // leave existing history as-is - retried on next symbol blur/reload
    }
  }

  function updateCurrent(rowId: string, instanceId: string, patch: Partial<OrderInstance>) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId && r.current?.id === instanceId ? { ...r, current: { ...r.current!, ...patch } } : r)),
    );
  }

  function moveCurrentToHistory(rowId: string, instanceId: string, entry: HistoryEntry) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId && r.current?.id === instanceId
          ? clearDraftPrices({ ...r, current: null, history: [entry, ...r.history] })
          : r,
      ),
    );
  }

  // A pending instance is a pure browser-side watch (no backend order
  // exists yet), so canceling one is just clearing local state - no API
  // call, and it never traded so it doesn't become a history entry.
  function cancelPendingCurrent(rowId: string) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? clearDraftPrices({ ...r, current: null, draftPendingPrice: "" }) : r)));
  }

  // Re-arms the pending entry watch at a new spot price - still a pure
  // browser-side watch (see cancelPendingCurrent's own comment), so this
  // is just a local state update, no API call. Reuses the freshest
  // lastKnownLtp the poll loop already keeps current every tick while
  // pending (falls back to one extra fetch if that's somehow not set yet,
  // e.g. right after the row's very first render) to recompute
  // startedAboveTarget the same way placeOrder does at initial creation -
  // getting the crossing direction wrong here would fire (or fail to
  // fire) the order on the wrong side of the new trigger price.
  async function updatePendingTriggerPrice(row: ManualRow) {
    if (!row.current || row.current.state !== "pending") return;
    const newPrice = Number(row.draftPendingPrice);
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      updateRow(row.id, { rowError: "Enter a valid trigger price." });
      return;
    }
    let ltp = row.lastKnownLtp;
    if (ltp == null) {
      try {
        ltp = await fetchUnderlyingLtp(row.segment, row.symbol.trim().toUpperCase());
        updateRow(row.id, { lastKnownLtp: ltp });
      } catch {
        // fall through - startedAboveTarget below defaults conservatively, same as placeOrder
      }
    }
    const startedAboveTarget = ltp != null ? ltp >= newPrice : true;
    updateCurrent(row.id, row.current.id, { triggerPrice: newPrice, startedAboveTarget });
    updateRow(row.id, { rowError: undefined, draftPendingPrice: String(newPrice) });
  }

  // An "open" instance whose last square-off attempt errored (typically
  // 404 - the position/group behind it was already deleted server-side,
  // e.g. via execution's "Clear positions" reset) can never resolve
  // itself. This drops the stale local entry without any further API
  // call - same "local view only" reasoning as cancelPendingCurrent.
  function clearErroredCurrent(rowId: string) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, current: null } : r)));
  }

  async function placeOrder(row: ManualRow) {
    if (row.current) return; // one open slot at a time - see the row's own hint text
    if (!dailySatisfied(row.segment)) return;
    if (!allChecklistChecked(row)) return;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) return;
    const quantity = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    // priceMode==="market" always sends no price (defensive - draftLimitPrice
    // should already be "" in that mode, see priceMode's own comment on
    // ManualRow) - executeOrder then fetches a fresh live LTP at submit time.
    const limitPrice = row.priceMode === "limit" && row.draftLimitPrice ? Number(row.draftLimitPrice) : undefined;
    const target = row.draftTarget ? Number(row.draftTarget) : undefined;
    const slLimit = row.draftSlLimit ? Number(row.draftSlLimit) : undefined;
    // Snapshotted NOW, not re-derived when a pending trigger later fires -
    // matches execution's own plan_checklist column, a frozen record of
    // what was planned at ORDER time, not whatever the master list looks
    // like later.
    const planChecklist: ChecklistAnswer[] = planItemsForRow(row).map((item) => ({
      label: item.label,
      checked: !!row.checklistChecked[item.id],
    }));

    // Cleared immediately after being captured onto the new instance below
    // (same reasoning draftLimitPrice already had) - checkExitTrigger has
    // no "starting side" guard the way the entry trigger's
    // startedAboveTarget does, so a leftover Target/SL Limit value from a
    // PREVIOUS trade on this row (never cleared before this fix) would
    // silently attach to the fresh position and could fire on the very
    // first poll tick if the current spot price already sat past it -
    // reproduced live 2026-08-21 as an order that "closed immediately."
    // checklistChecked resets too - re-plan every trade, see its own
    // comment on ManualRow.
    updateRow(row.id, { priceMode: "market", draftLimitPrice: "", draftTarget: "", draftSlLimit: "", rowError: undefined, checklistChecked: {} });

    const instance: OrderInstance = {
      id: crypto.randomUUID(),
      state: "pending",
      action: row.action,
      instrumentType: row.instrumentType,
      optionStyle: row.instrumentType === "option" ? row.optionStyle : undefined,
      quantity,
      targetPrice: target,
      slLimitPrice: slLimit,
      planChecklist,
    };

    // No Spot Limit given - fires immediately at CMP, same as leaving it
    // blank always has.
    if (limitPrice === undefined) {
      updateRow(row.id, { current: instance });
      await executeOrder(row, symbol, instance, undefined);
      return;
    }

    let startedAboveTarget = true;
    try {
      const ltp = await fetchUnderlyingLtp(row.segment, symbol);
      startedAboveTarget = ltp >= limitPrice;
      updateRow(row.id, { lastKnownLtp: ltp });
    } catch {
      // default true - corrected on the very next poll tick regardless
    }

    updateRow(row.id, {
      current: { ...instance, triggerPrice: limitPrice, startedAboveTarget },
      draftPendingPrice: String(limitPrice),
    });
  }

  async function executeOrder(row: ManualRow, symbol: string, instance: OrderInstance, price: number | undefined) {
    try {
      const resolvedPrice = price ?? (await fetchUnderlyingLtp(row.segment, symbol));
      // instance.triggerPrice is only ever set on the "limit" branch of
      // placeOrder (undefined means it fired immediately at CMP) - reused
      // here rather than adding a separate field, for future performance
      // review (see execution.positions.order_type's own comment).
      const orderType: "market" | "limit" = instance.triggerPrice != null ? "limit" : "market";
      if (instance.instrumentType === "option") {
        const created = await createManualOptionGroup({
          segment: row.segment,
          symbol,
          action: instance.action,
          option_position_style: instance.optionStyle ?? "spread",
          option_strike_moneyness: row.moneyness,
          option_fixed_lots: instance.quantity,
          plan_checklist: instance.planChecklist ?? [],
          order_type: orderType,
        });
        if (created.status === "REJECTED") {
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id && r.current?.id === instance.id
                ? { ...r, current: null, rowError: created.rejection_reason ?? "order rejected" }
                : r,
            ),
          );
          return;
        }
        updateCurrent(row.id, instance.id, {
          state: "open",
          groupId: created.id,
          signalId: created.signal_id,
          entryPrice: created.net_debit ?? undefined,
          quantityLive: created.quantity ?? undefined,
          legs: created.legs,
        });
      } else {
        const created = await createManualPosition({
          segment: row.segment,
          symbol,
          action: instance.action,
          instrument_type: instance.instrumentType as "spot" | "future",
          price: resolvedPrice,
          quantity: instance.quantity,
          plan_checklist: instance.planChecklist ?? [],
          order_type: orderType,
          ...buildStopLossConfig(row),
        });
        if (created.status === "REJECTED") {
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id && r.current?.id === instance.id
                ? { ...r, current: null, rowError: created.rejection_reason ?? "order rejected" }
                : r,
            ),
          );
          return;
        }
        updateCurrent(row.id, instance.id, {
          state: "open",
          positionId: created.id,
          signalId: created.signal_id,
          entryPrice: created.entry_price,
          quantityLive: created.quantity ?? undefined,
          stopLossPrice: created.stop_loss_price,
          stopLossMethod: created.stop_loss_method,
          trailingStopEnabled: created.trailing_stop_enabled,
        });
      }
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id && r.current?.id === instance.id
            ? { ...r, current: null, rowError: err instanceof Error ? err.message : "failed to place order" }
            : r,
        ),
      );
    }
  }

  // Refreshes an open instance's live price/P&L, or detects a backend-side
  // close (real stop-loss/target/square-off-time/counter-signal, or a
  // manual square-off from execution's own frontend) and moves it to
  // history. Returns the just-updated instance (for the caller's own
  // spot-price exit-watch check right after), "closed", or null on no
  // change/transient error - deliberately a return value rather than
  // relying on the caller re-reading state after this resolves, since
  // React's own re-render timing isn't something to build a same-tick
  // follow-up check on.
  async function refreshOpenInstance(row: ManualRow, instance: OrderInstance): Promise<OrderInstance | "closed" | null> {
    try {
      if (instance.instrumentType === "option") {
        const groups = await fetchOptionGroups({ signalId: instance.signalId, withLivePnl: true });
        const group = groups[0];
        if (!group) {
          // Not a transient fetch failure (that's the outer catch below) -
          // a successful lookup that found nothing means the group behind
          // this "open" card no longer exists server-side (e.g. execution's
          // "Clear positions" reset). Left as state="open" forever without
          // this, the card stays locked with no way out - surface it via
          // the same error+Clear affordance a failed square-off already
          // uses, rather than retrying silently forever.
          updateCurrent(row.id, instance.id, { error: "Position not found in execution (cleared there?) - click Clear to reset this card." });
          return null;
        }
        if (group.status === "CLOSED") {
          moveCurrentToHistory(row.id, instance.id, {
            id: group.id,
            action: instance.action,
            instrumentType: instance.instrumentType,
            optionStyle: instance.optionStyle,
            entry_price: instance.entryPrice ?? null,
            exit_price: null,
            quantity: group.quantity,
            pnl: group.pnl,
            exit_reason: group.exit_reason,
            exit_time: group.exit_time,
            kind: "option_group",
            reviewed_at: group.reviewed_at,
            segment: row.segment,
            review_violation: null,
            review_notes: null,
            review_checklist: null,
            stop_loss_price: null,
            order_type: group.order_type,
          });
          return "closed";
        }
        const updated: OrderInstance = {
          ...instance,
          groupId: group.id,
          livePrice: group.live_combined_price ?? undefined,
          unrealizedPnl: group.unrealized_pnl ?? undefined,
          quantityLive: group.quantity ?? undefined,
          legs: group.legs,
        };
        updateCurrent(row.id, instance.id, updated);
        return updated;
      } else {
        const positions = await fetchExecPositions({ signalId: instance.signalId, withLivePnl: true });
        const pos = positions[0];
        if (!pos) {
          // Same "genuinely gone, not a transient failure" reasoning as
          // the option branch above.
          updateCurrent(row.id, instance.id, { error: "Position not found in execution (cleared there?) - click Clear to reset this card." });
          return null;
        }
        if (pos.status === "CLOSED") {
          moveCurrentToHistory(row.id, instance.id, {
            id: pos.id,
            action: instance.action,
            instrumentType: instance.instrumentType,
            optionStyle: instance.optionStyle,
            entry_price: pos.entry_price,
            exit_price: pos.exit_price,
            quantity: pos.quantity,
            pnl: pos.pnl,
            exit_reason: pos.exit_reason,
            exit_time: pos.exit_time,
            kind: "position",
            reviewed_at: pos.reviewed_at,
            segment: row.segment,
            review_violation: null,
            review_notes: null,
            review_checklist: null,
            stop_loss_price: pos.stop_loss_price,
            order_type: pos.order_type,
          });
          return "closed";
        }
        const updated: OrderInstance = {
          ...instance,
          positionId: pos.id,
          livePrice: pos.live_price ?? undefined,
          unrealizedPnl: pos.unrealized_pnl ?? undefined,
          quantityLive: pos.quantity ?? undefined,
          entryPrice: pos.entry_price,
          stopLossPrice: pos.stop_loss_price,
          stopLossMethod: pos.stop_loss_method,
          trailingStopEnabled: pos.trailing_stop_enabled,
        };
        updateCurrent(row.id, instance.id, updated);
        return updated;
      }
    } catch {
      return null; // transient - retry next tick
    }
  }

  async function handleSquareOff(row: ManualRow, instance: OrderInstance, reason: ExitReason = "manual") {
    try {
      if (instance.instrumentType === "option") {
        const result = await squareOffOptionGroup(instance.groupId ?? "");
        moveCurrentToHistory(row.id, instance.id, {
          // The REAL group id (not a synthetic one) - needed so the
          // history row's own review icon can actually PUT
          // /option-groups/{id}/review against it afterward.
          id: result.group_id,
          action: instance.action,
          instrumentType: instance.instrumentType,
          optionStyle: instance.optionStyle,
          entry_price: instance.entryPrice ?? null,
          exit_price: null,
          quantity: instance.quantityLive ?? null,
          pnl: result.pnl,
          exit_reason: reason,
          exit_time: new Date().toISOString(),
          kind: "option_group",
          reviewed_at: null,
          segment: row.segment,
          review_violation: null,
          review_notes: null,
          review_checklist: null,
          stop_loss_price: null,
          order_type: instance.triggerPrice != null ? "limit" : "market",
        });
      } else {
        const result = await squareOffManualPosition(instance.positionId ?? "");
        moveCurrentToHistory(row.id, instance.id, {
          // The REAL position id - same reasoning as group_id above.
          id: result.position_id,
          action: instance.action,
          instrumentType: instance.instrumentType,
          optionStyle: instance.optionStyle,
          entry_price: instance.entryPrice ?? null,
          exit_price: result.exit_price,
          quantity: result.closed_quantity,
          pnl: result.pnl,
          exit_reason: reason,
          exit_time: new Date().toISOString(),
          kind: "position",
          reviewed_at: null,
          segment: row.segment,
          review_violation: null,
          review_notes: null,
          review_checklist: null,
          stop_loss_price: instance.stopLossPrice ?? null,
          order_type: instance.triggerPrice != null ? "limit" : "market",
        });
      }
    } catch (err) {
      updateCurrent(row.id, instance.id, { error: err instanceof Error ? err.message : "failed to square off" });
    }
  }

  async function handleSave(row: ManualRow) {
    if (!row.current) return;
    const target = row.draftTarget ? Number(row.draftTarget) : undefined;
    const slLimit = row.draftSlLimit ? Number(row.draftSlLimit) : undefined;
    updateCurrent(row.id, row.current.id, { targetPrice: target, slLimitPrice: slLimit });

    let ok = true;

    // The REAL backend stop-loss (spot/future, open only - options have
    // no method-based SL concept, and a pending order has no position id
    // yet to attach one to) - attaches or replaces it via the same
    // percent/previous_candle/indicator config placeOrder already sends
    // at entry time, see buildStopLossConfig.
    if (row.instrumentType !== "option" && row.current.state === "open" && row.current.positionId) {
      const config = buildStopLossConfig(row);
      if (Object.keys(config).length > 0) {
        try {
          const updated = await updateStopLoss(row.current.positionId, config);
          updateCurrent(row.id, row.current.id, {
            stopLossPrice: updated.stop_loss_price,
            stopLossMethod: updated.stop_loss_method,
            trailingStopEnabled: updated.trailing_stop_enabled,
            error: undefined,
          });
        } catch (err) {
          ok = false;
          updateCurrent(row.id, row.current.id, {
            error: err instanceof Error ? err.message : "failed to update stop-loss",
          });
        }
      }
    }

    // Option rows' "Spot SL Limit" - now the REAL backend spot stop
    // (PUT /option-groups/{id}/spot-stop-loss, same field execution's own
    // frontend edits via its pencil icon) instead of purely the client-
    // side watch above - persists server-side and shows up in execution's
    // own Positions page, survives this tab closing. "Spot Target" for
    // options has no backend equivalent yet (see updateCurrent above,
    // still client-side-only) - deliberately not wired here.
    if (row.instrumentType === "option" && row.current.state === "open" && row.current.groupId && slLimit !== undefined) {
      try {
        await updateOptionGroupSpotStopLoss(row.current.groupId, slLimit);
        updateCurrent(row.id, row.current.id, { error: undefined });
      } catch (err) {
        ok = false;
        updateCurrent(row.id, row.current.id, {
          error: err instanceof Error ? err.message : "failed to update spot stop-loss",
        });
      }
    }

    // Visible confirmation, even when neither backend call above actually
    // ran (e.g. just the client-side-only Spot Target watch changed) -
    // there was previously NO feedback at all on success, only on
    // failure (row.current.error) - reproduced live 2026-08-25.
    if (ok) {
      setJustSaved((prev) => ({ ...prev, [row.id]: true }));
      setTimeout(() => setJustSaved((prev) => ({ ...prev, [row.id]: false })), 2500);
    }
  }

  function handleExitClick(row: ManualRow) {
    if (!row.current) return;
    if (row.current.state === "pending") {
      cancelPendingCurrent(row.id);
    } else {
      void handleSquareOff(row, row.current, "manual");
    }
  }

  // Single global poll loop - a pending instance checks its entry
  // trigger, an open one refreshes live P&L (detecting a backend-side
  // close) and then, if it has a Spot Target/SL Limit armed, checks the
  // underlying's own spot price against them too - idle rows with a
  // symbol typed just refresh the value preview.
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        // Once per tick, not per row - the review gate is platform-wide
        // (see pendingReview's own comment), so one fetch covers every row.
        try {
          setPendingReview(await fetchPendingReview());
        } catch {
          // keep the last known value - retried next tick
        }
        // Catches the day rolling over (a new date's row doesn't exist
        // yet) or another tab/session submitting today's checklist.
        void refreshDailyChecklists();
        void refreshTradingSessions();
        for (const row of rowsRef.current) {
          const symbol = row.symbol.trim().toUpperCase();
          if (!symbol) continue;
          const instance = row.current;

          if (!instance) {
            try {
              const ltp = await fetchUnderlyingLtp(row.segment, symbol);
              updateRow(row.id, { lastKnownLtp: ltp });
            } catch {
              // keep last known value
            }
            continue;
          }

          if (instance.state === "pending") {
            if (instance.triggerPrice !== undefined) {
              try {
                const ltp = await fetchUnderlyingLtp(row.segment, symbol);
                updateRow(row.id, { lastKnownLtp: ltp });
                const crossed = instance.startedAboveTarget ? ltp <= instance.triggerPrice : ltp >= instance.triggerPrice;
                if (crossed) await executeOrder(row, symbol, instance, ltp);
              } catch {
                // keep waiting, retry next tick
              }
            }
            continue;
          }

          const result = await refreshOpenInstance(row, instance);
          if (result && result !== "closed" && (result.targetPrice != null || result.slLimitPrice != null)) {
            try {
              const ltp = await fetchUnderlyingLtp(row.segment, symbol);
              updateRow(row.id, { lastKnownLtp: ltp });
              const reason = checkExitTrigger(result, ltp);
              if (reason) await handleSquareOff(row, result, reason);
            } catch {
              // keep watching, retry next tick
            }
          }
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live "lots typed -> real underlying-unit total" hint, shown next to
  // the Lot input - CRYPTO futures only (the only instrumentType
  // lotSizeCache actually prefetches; options resolve their own tradeable
  // leg symbol server-side at order time, so there's no symbol to look a
  // lot size up against here yet). Exists because a fractional lot_size
  // (e.g. BTCUSD=0.001) makes "100 lots" -> "0.1 total" a jarring surprise
  // to only discover after the order's already placed - see this
  // session's own manual-order quantity confusion.
  const lotConversionHint = (row: ManualRow): string | null => {
    if (row.segment !== "CRYPTO" || row.instrumentType !== "future") return null;
    const lotSize = lotSizeCache[row.symbol];
    if (lotSize == null || lotSize === 1) return null;
    const qty = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    if (!qty || !Number.isFinite(qty)) return null;
    const total = qty * lotSize;
    return `= ${total.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} total`;
  };

  const orderValuePreview = (row: ManualRow): string => {
    const qty = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    const price = row.draftLimitPrice ? Number(row.draftLimitPrice) : row.lastKnownLtp;
    if (!qty || !price) return "-";
    // For CRYPTO futures, `qty` is a LOT count, not raw underlying units -
    // matches execution's own open_manual_position (quantity * lot_size).
    // Every other case (spot, or lot_size not loaded yet) is a no-op
    // multiply by 1.
    const lotSize = row.segment === "CRYPTO" && row.instrumentType === "future" ? (lotSizeCache[row.symbol] ?? 1) : 1;
    // CRYPTO prices are raw USD (Delta Exchange India) - every other
    // segment quotes in raw INR (Dhan) - label it so this doesn't read as
    // INR by default, same fix as execution's balance-rejection messages.
    const unit = row.segment === "CRYPTO" ? "USD" : "INR";
    return `${(qty * lotSize * price).toFixed(2)} ${unit}`;
  };

  // Always scoped to today - the date-filtered, drill-into-history view
  // moved to ManualStatsPage's own Performance page (see
  // ManualCalendarFilter there); the trading view itself always reflects
  // right-now state, reset to today on every load, no filter to leave in
  // a surprising position. realized: closed trades on this row that
  // exited today. unrealized: the row's own currently-open position's
  // live P&L.
  function cardPnlSummary(row: ManualRow): { realized: number; unrealized: number | null; unit: string } {
    const today = todayKey();
    const realized = row.history
      .filter((h) => h.exit_time && dayKey(h.exit_time) === today)
      .reduce((sum, h) => sum + (h.pnl ?? 0), 0);
    const unrealized = row.current?.state === "open" ? row.current.unrealizedPnl ?? 0 : null;
    const unit = row.segment === "CRYPTO" ? "USD" : "INR";
    return { realized, unrealized, unit };
  }

  // Only show a segment's day-checklist box once an instrument card for
  // that segment actually exists below - no rows yet (or none in that
  // segment) means nothing to show, rather than surfacing all 3
  // segments' boxes unconditionally regardless of what's actually in use.
  const usedSegments = new Set(rows.map((r) => r.segment));

  // Whether a currently-visible card can actually reach pendingReview's
  // own Trade History review icon - if not (its card was removed, or it
  // never existed in this session), the banner below renders the full
  // review form itself instead of just pointing at a dead end.
  const pendingReviewRow = pendingReview
    ? rows.find((r) => r.segment === pendingReview.segment && r.symbol === pendingReview.symbol)
    : undefined;

  if (view === "settings") {
    return (
      <ManualSettingsPage
        checklistItems={checklistItems}
        planItems={planItems}
        dayItems={dayItems}
        reviewItems={reviewItems}
        refreshChecklistItems={refreshChecklistItems}
        onBack={() => {
          setView("trading");
          void refreshAccounts();
        }}
      />
    );
  }

  if (view === "stats") {
    return <ManualStatsPage onBack={() => setView("trading")} />;
  }

  return (
    <>
      <div className="manual-toolbar">
        <span className="manual-add-instrument-group">
          <select
            className="manual-new-row-segment"
            value={newRowSegment}
            title="Segment for the next added instrument"
            onChange={(e) => {
              const segment = e.target.value as Segment;
              // CRYPTO/MCX have no spot market on this platform's
              // providers - bump off 'spot' automatically, same
              // reasoning the card's own Segment select used to follow
              // inline before it became fixed-at-creation.
              const instrumentType =
                (segment === "CRYPTO" || segment === "MCX") && newRowInstrumentType === "spot" ? "future" : newRowInstrumentType;
              setNewRowSegment(segment);
              setNewRowInstrumentType(instrumentType);
              // Symbols aren't portable across segments (e.g. BTCUSD
              // means nothing on NSE).
              setNewRowSymbol("");
            }}
          >
            <option value="NSE">NSE</option>
            <option value="MCX">MCX</option>
            <option value="CRYPTO">CRYPTO</option>
          </select>
          {newRowSegment === "CRYPTO" && cryptoSymbols.length > 0 ? (
            <select
              className="manual-new-row-symbol"
              value={newRowSymbol}
              title="Symbol for the next added instrument"
              onChange={(e) => setNewRowSymbol(e.target.value)}
            >
              <option value="" disabled>
                Select a symbol
              </option>
              {(newRowInstrumentType === "option" ? CRYPTO_OPTION_SYMBOLS : cryptoSymbols).map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="manual-new-row-symbol"
              value={newRowSymbol}
              title="Symbol for the next added instrument"
              onChange={(e) => setNewRowSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. BTCUSD, TCS"
            />
          )}
          <select
            className="manual-new-row-instrument"
            value={newRowInstrumentType}
            title="Instrument type for the next added instrument"
            onChange={(e) => {
              const instrumentType = e.target.value as InstrumentType;
              // Switching to Option for CRYPTO with a symbol that isn't
              // option-eligible (e.g. SOLUSD) would otherwise leave a
              // stale, guaranteed-to-422 selection sitting in the field -
              // clear it so "Select a symbol" forces a real pick from
              // the now-restricted list above.
              const symbolStillValid =
                instrumentType !== "option" || newRowSegment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(newRowSymbol);
              setNewRowInstrumentType(instrumentType);
              if (!symbolStillValid) setNewRowSymbol("");
            }}
          >
            {newRowSegment !== "CRYPTO" && newRowSegment !== "MCX" && <option value="spot">Spot</option>}
            <option value="future">Future</option>
            <option value="option">Option</option>
          </select>
          <button
            type="button"
            className="manual-add-instrument-btn"
            disabled={!newRowSymbol.trim()}
            title={!newRowSymbol.trim() ? "Enter a symbol first - it can't be changed after adding" : undefined}
            onClick={() => {
              const symbol = newRowSymbol.trim().toUpperCase();
              const row = newRow(newRowSegment, symbol, newRowInstrumentType);
              setRows((prev) => [...prev, row]);
              void refreshLtp(row.id, row.segment, symbol);
              void refreshRowHistory(row);
              setNewRowSymbol("");
            }}
          >
            <PlusIcon /> Add instrument
          </button>
        </span>
        <span className="manual-toolbar-links">
          <button type="button" className="manual-settings-link" onClick={() => setView("stats")}>
            Performance →
          </button>
          <button type="button" className="manual-settings-link" onClick={() => setView("settings")}>
            Checklist & Risk Settings →
          </button>
        </span>
      </div>

      {pendingReview && (
        <div className={`manual-review-banner ${pendingReviewRow ? "manual-review-banner-compact" : ""}`}>
          {/* Just the count now, not this one trade's own symbol/action/
              pnl - changed 2026-08-26 at the user's explicit request.
              pendingReview itself is still the EARLIEST unreviewed trade
              (that's what the review icon/inline form below actually
              act on), just no longer named in the headline. */}
          <span className="manual-review-banner-title">
            {pendingReview.pending_count} closed trade{pendingReview.pending_count === 1 ? "" : "s"} still need
            {pendingReview.pending_count === 1 ? "s" : ""} review
          </span>
          {pendingReviewRow ? (
            <span className="muted">
              Open that instrument&apos;s card, expand Trade History, and click the review icon on this trade.
            </span>
          ) : (
            <>
              <span className="muted">This trade&apos;s own card was removed - review it directly here instead.</span>
              <div className="manual-review-banner-row">
                <span>Did you follow your full plan without deviation?</span>
                <span className="manual-toggle-group">
                  <button
                    type="button"
                    className={`manual-toggle ${inlineReviewFollowedPlan === true ? "active-buy" : ""}`}
                    onClick={() => setInlineReviewFollowedPlan(true)}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className={`manual-toggle ${inlineReviewFollowedPlan === false ? "active-sell" : ""}`}
                    onClick={() => setInlineReviewFollowedPlan(false)}
                  >
                    No
                  </button>
                </span>
              </div>
              {inlineReviewFollowedPlan === false && (
                <textarea
                  placeholder="What was violated?"
                  value={inlineReviewNotes}
                  onChange={(e) => setInlineReviewNotes(e.target.value)}
                  rows={2}
                />
              )}
              {reviewItems.filter((item) => appliesToSegment(item, pendingReview.segment)).length > 0 && (
                <div className="manual-checklist">
                  <span className="manual-checklist-title">Self-check (unchecked = didn&apos;t happen, that&apos;s fine to record)</span>
                  <div className="manual-checklist-items">
                    {reviewItems
                      .filter((item) => appliesToSegment(item, pendingReview.segment))
                      .map((item) => (
                        <label className="checkbox-label tiny" key={item.id}>
                          <input
                            type="checkbox"
                            checked={!!inlineReviewChecklistChecked[item.id]}
                            onChange={(e) =>
                              setInlineReviewChecklistChecked((prev) => ({ ...prev, [item.id]: e.target.checked }))
                            }
                          />
                          {item.label}
                        </label>
                      ))}
                  </div>
                </div>
              )}
              {pendingReview.pnl != null && pendingReview.pnl < 0 && (
                <label className="checkbox-label tiny">
                  <input
                    type="checkbox"
                    checked={inlineReviewAcceptedLoss}
                    onChange={(e) => setInlineReviewAcceptedLoss(e.target.checked)}
                  />
                  I accept this loss
                </label>
              )}
              {inlineReviewError && <p className="error">{inlineReviewError}</p>}
              <div className="manual-review-banner-row">
                <button
                  type="button"
                  className="btn-save"
                  disabled={inlineReviewFollowedPlan === null || inlineReviewSubmitting}
                  onClick={() => void submitPendingReviewForm()}
                >
                  Submit review
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {ALL_SEGMENTS.filter((seg) => usedSegments.has(seg)).map((seg) => {
        const sessionsToday = tradingSessions[seg];
        const openSession = hasOpenSession(seg);
        // The daily checklist used to be its own separate box below this
        // bar - merged in here as a collapsible section (toggled by the
        // icon button ahead of Check in/out) so a segment's session state
        // and its once-a-day discipline checklist live in one place. A
        // segment with no active 'day'-phase items scoped to it at all
        // gets no toggle/section - nothing to show.
        const items = dayItems.filter((i) => appliesToSegment(i, seg));
        const hasDayItems = items.length > 0;
        const submitted = dailyChecklists[seg]?.answers != null;
        const collapsed = dayCollapsed[seg];
        return (
          <div className={`manual-session-bar ${hasDayItems && !submitted ? "pending" : ""}`} key={seg}>
            <div className="manual-session-bar-row">
              <span className="manual-session-bar-label">{seg} session</span>
              <span className="manual-session-bar-status">{formatSessionSummary(sessionsToday)}</span>
              <span className="manual-session-bar-actions">
                {hasDayItems && (
                  <button
                    type="button"
                    className="manual-icon-btn"
                    title={`${collapsed ? "Show" : "Hide"} today's ${seg} checklist${submitted ? " (submitted)" : " (not yet submitted)"}`}
                    onClick={() => setDayCollapsed((prev) => ({ ...prev, [seg]: !prev[seg] }))}
                  >
                    <ReviewIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="btn-save tiny"
                  disabled={sessionActionLoading === seg || openSession}
                  onClick={() => void checkIn(seg)}
                >
                  Check in
                </button>
                <button
                  type="button"
                  className="btn-save tiny"
                  disabled={sessionActionLoading === seg || !openSession}
                  onClick={() => void checkOut(seg)}
                >
                  Check out
                </button>
              </span>
            </div>
            {sessionError && sessionError.segment === seg && <p className="error">{sessionError.message}</p>}
            {hasDayItems && !collapsed && (
              <div className="manual-day-checklist-body">
                <p className="manual-day-checklist-status muted">
                  {submitted ? `Submitted ${formatCompact(dailyChecklists[seg]!.submitted_at)}` : "Not yet submitted"}
                </p>
                <div className="manual-day-checklist-items">
                  {items.map((item) => (
                    <label className="checkbox-label tiny" key={item.id}>
                      <input
                        type="checkbox"
                        checked={!!dayFormAnswers[seg][item.id]}
                        onChange={(e) =>
                          setDayFormAnswers((prev) => ({ ...prev, [seg]: { ...prev[seg], [item.id]: e.target.checked } }))
                        }
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
                <textarea
                  className="manual-day-checklist-notes"
                  placeholder={`Observation for today's ${seg} session (optional)`}
                  rows={2}
                  value={dayFormNotes[seg]}
                  onChange={(e) => setDayFormNotes((prev) => ({ ...prev, [seg]: e.target.value }))}
                />
                {dayError && dayError.segment === seg && <p className="error">{dayError.message}</p>}
                <button type="button" className="btn-save tiny" disabled={daySubmitting === seg} onClick={() => void submitDailyForSegment(seg)}>
                  {submitted ? "Update" : "Submit"} today&apos;s {seg} checklist
                </button>
              </div>
            )}
          </div>
        );
      })}

      {rows.map((row) => {
        const openLocked = !!row.current;
        // A segment's own cards stay hidden behind a "check in first"
        // placeholder until that segment has an OPEN check-in session
        // today - discipline gate, same spirit as the daily checklist/
        // plan checklist gates below, just enforced by not rendering the
        // trading form at all rather than disabling its Add button.
        // Never applies to a row with a real OPEN/pending trade
        // (openLocked) - checking out (or never checking in) must never
        // hide a live position from view, only block PLANNING a new one.
        if (!openLocked && !hasOpenSession(row.segment)) {
          return (
            <section className="panel manual-card manual-card-gated" key={row.id}>
              <div className="manual-card-top-row">
                <span className="manual-card-collapsed-summary">
                  <strong>{row.segment}</strong>
                  <span>{row.symbol || "(no symbol)"}</span>
                  <span className="muted">{row.instrumentType}</span>
                </span>
                <span className="manual-card-actions">
                  {confirmRemoveId === row.id ? (
                    <span className="manual-confirm-remove">
                      <span className="muted">Remove card?</span>
                      <button
                        type="button"
                        className="tiny btn-exit"
                        onClick={() => {
                          setRows((prev) => prev.filter((r) => r.id !== row.id));
                          setConfirmRemoveId(null);
                        }}
                      >
                        Yes
                      </button>
                      <button type="button" className="tiny secondary" onClick={() => setConfirmRemoveId(null)}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="manual-icon-btn" title="Remove" onClick={() => setConfirmRemoveId(row.id)}>
                      &#215;
                    </button>
                  )}
                </span>
              </div>
              <p className="manual-checkin-required muted">Check in to {row.segment} above to plan a trade.</p>
            </section>
          );
        }
        const pnlSummary = cardPnlSummary(row);
        // The trading view stays scoped to today, same as cardPnlSummary
        // above (see its own comment) - older trades are still fully
        // reviewable/analyzable, just from the Performance page's own
        // calendar/day drill-down now, not cluttering this per-row list.
        const todaysHistory = row.history.filter((h) => h.exit_time && dayKey(h.exit_time) === todayKey());
        const rr = computeRR(row);
        const account = accounts.find((a) => a.segment === row.segment);
        const minRR = account?.min_reward_risk_ratio ?? DEFAULT_MIN_REWARD_RISK_RATIO;
        const rrBelowMin = rr != null && rr < minRR;
        // Mirrors the top-level sync effect's own gate exactly - see its
        // comment. Lot input locks to whatever that effect last computed
        // into draftQuantity; when it's null (no fixed SL yet), the Lot
        // field stays locked but shows the "Auto" placeholder rather than
        // a stale number.
        const riskLotsEnforced = !row.current && row.instrumentType !== "option" && !!account?.enforce_risk_based_lots;
        // Shared by the Add and MKT buttons below - both place a brand
        // new order (MKT just forces limitPrice blank first, see its own
        // onClick), so both need the exact same pre-trade gates. Doesn't
        // apply once row.current exists (Update has its own, simpler
        // "not while pending" rule, handled separately at each call site).
        const newOrderBlockedReason = !row.symbol.trim()
          ? "Enter a symbol first"
          : !dailySatisfied(row.segment)
            ? `Complete today's ${row.segment} checklist first`
            : !allChecklistChecked(row)
              ? "Check every trade plan checklist item first"
              : rrBelowMin
                ? `Reward:Risk from Limit/Target/SL Limit is below the required 1:${minRR}`
                : null;
        // SL Limit/Target/RR live in this one shared entry-group,
        // positioned around Limit, for every instrument type and every
        // state except "pending" (nothing to size against yet - the
        // order hasn't actually triggered). Options keep using the same
        // draftSlLimit/draftTarget fields once open too (previously a
        // separate, right-aligned .manual-exit-group - merged in here so
        // Update/Exit stay on the same row instead of wrapping below it).
        const showEntrySlTarget = row.current?.state !== "pending";
        return (
          <section className="panel manual-card" key={row.id}>
            <div className="manual-card-top-row">
              {row.collapsed ? (
                <span className="manual-card-collapsed-summary">
                  <strong>{row.segment}</strong>
                  <span>{row.symbol || "(no symbol)"}</span>
                  <span className="muted">{row.instrumentType}</span>
                  <span className="muted">{row.current ? (row.current.state === "pending" ? "Pending" : "Open") : "—"}</span>
                  {pnlSummary.unrealized != null ? (
                    <>
                      <span className={pnlClass(pnlSummary.unrealized)}>Unrealized {fmt(pnlSummary.unrealized)}</span>
                      <span className={pnlClass(pnlSummary.realized)}>Realized {fmt(pnlSummary.realized)}</span>
                    </>
                  ) : (
                    <span className={pnlClass(pnlSummary.realized)}>{fmt(pnlSummary.realized)}</span>
                  )}
                </span>
              ) : (
                // Segment/Symbol/Instrument are all fixed at creation time
                // now, via the "+ Add instrument" toolbar's own picker - a
                // card never changes any of the three after that, so this
                // is a plain read-only summary, not a form. One compact
                // line (identity + today's realized PnL + live LTP) - used
                // to be two separate rows (manual-card-top-row's own icons,
                // then a whole extra manual-card-header row below with PnL/
                // LTP stacked vertically on the right) that ate a lot of
                // vertical space for what's ultimately one line of info.
                <span className="manual-card-identity">
                  <strong>{row.segment}</strong>
                  <span>{row.symbol}</span>
                  <span className="muted">{row.instrumentType}</span>
                  <button
                    type="button"
                    className="manual-pnl-toggle"
                    title="This position's live unrealized PnL, plus today's realized PnL on this row - click to view trade history"
                    onClick={() => setExpandedHistory((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                  >
                    {pnlSummary.unrealized != null ? (
                      <>
                        <span className={pnlClass(pnlSummary.unrealized)}>Unrealized {fmt(pnlSummary.unrealized)}</span>
                        <span className={pnlClass(pnlSummary.realized)}>Realized {fmt(pnlSummary.realized)}</span>
                      </>
                    ) : (
                      <span className={pnlClass(pnlSummary.realized)}>{fmt(pnlSummary.realized)}</span>
                    )}
                  </button>
                  {row.symbol && (
                    <span className="manual-ltp-live">
                      LTP {row.lastKnownLtp != null ? fmt(row.lastKnownLtp) : "..."}
                      <span className="manual-ltp-unit">{row.segment === "CRYPTO" ? "USD" : "INR"}</span>
                    </span>
                  )}
                </span>
              )}
              <span className="manual-card-actions">
                <button
                  type="button"
                  className="manual-icon-btn manual-collapse-toggle"
                  title={row.collapsed ? "Expand" : "Collapse"}
                  onClick={() => updateRow(row.id, { collapsed: !row.collapsed })}
                >
                  {row.collapsed ? "▸" : "▾"}
                </button>
                {!openLocked &&
                  (confirmRemoveId === row.id ? (
                    <span className="manual-confirm-remove">
                      <span className="muted">Remove card?</span>
                      <button
                        type="button"
                        className="tiny btn-exit"
                        onClick={() => {
                          setRows((prev) => prev.filter((r) => r.id !== row.id));
                          setConfirmRemoveId(null);
                        }}
                      >
                        Yes
                      </button>
                      <button type="button" className="tiny secondary" onClick={() => setConfirmRemoveId(null)}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="manual-icon-btn" title="Remove" onClick={() => setConfirmRemoveId(row.id)}>
                      &#215;
                    </button>
                  ))}
              </span>
            </div>
            {!row.collapsed && (
            <>
            {!row.current && planItemsForRow(row).length > 0 && (
              <div className="manual-checklist">
                <span className="manual-checklist-title">Trade plan checklist</span>
                <div className="manual-checklist-items">
                  {planItemsForRow(row).map((item) => (
                    <label className="checkbox-label tiny" key={item.id}>
                      <input
                        type="checkbox"
                        checked={!!row.checklistChecked[item.id]}
                        onChange={(e) =>
                          updateRow(row.id, { checklistChecked: { ...row.checklistChecked, [item.id]: e.target.checked } })
                        }
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="manual-order-row">
              <div className="manual-entry-group">
                {/* Entry-only fields (Buy/Sell, Naked/Spread, Strike, Lot,
                    Limit/Market) - shown ONLY for a brand-new, not-yet-
                    placed row. Once row.current exists (pending OR open)
                    these are all either already resolved (the leg/entry
                    price) or frozen (action/style/qty can't change on an
                    existing order) - kept them rendered-but-disabled here
                    before, which just cluttered an open position's card
                    with a wall of dead controls above its own SL/Target/
                    status. Removed 2026-08-26 at the user's explicit
                    request - only SL/Target (still genuinely editable
                    post-open, see showEntrySlTarget below) and the
                    Update/Exit buttons remain once placed. */}
                {!row.current && (
                  <>
                <span className="manual-field-group">
                  <span className="manual-field-label">Buy/Sell</span>
                  <span className="manual-toggle-group">
                    <button
                      type="button"
                      className={`manual-toggle ${row.action === "BUY" ? "active-buy" : ""}`}
                      onClick={() => updateRow(row.id, { action: "BUY" })}
                    >
                      BUY
                    </button>
                    <button
                      type="button"
                      className={`manual-toggle ${row.action === "SELL" ? "active-sell" : ""}`}
                      onClick={() => updateRow(row.id, { action: "SELL" })}
                    >
                      SELL
                    </button>
                  </span>
                </span>
                {row.instrumentType === "option" && (
                  <>
                    <label>
                      Naked/Spread
                      <select
                        value={row.optionStyle}
                        onChange={(e) => updateRow(row.id, { optionStyle: e.target.value as OptionPositionStyle })}
                      >
                        <option value="spread">{row.action === "BUY" ? "Bull Call Spread" : "Bear Put Spread"}</option>
                        <option value="naked">{row.action === "BUY" ? "Buy Call" : "Buy Put"}</option>
                      </select>
                    </label>
                    <label>
                      Strike
                      <select
                        value={row.moneyness}
                        onChange={(e) => updateRow(row.id, { moneyness: e.target.value as OptionStrikeMoneyness })}
                      >
                        <option value="ITM2">ITM2</option>
                        <option value="ITM1">ITM1</option>
                        <option value="ATM">ATM</option>
                        <option value="OTM1">OTM1</option>
                        <option value="OTM2">OTM2</option>
                      </select>
                    </label>
                  </>
                )}
                <label>
                  {row.instrumentType === "spot" ? "Qty" : "Lot"}
                  <input
                    type="number"
                    min="0"
                    // Lot counts (future/option) are whole numbers - only
                    // spot quantity (e.g. fractional BTC) needs decimal
                    // increment/decrement.
                    step={row.instrumentType === "spot" ? "0.01" : "1"}
                    value={row.draftQuantity}
                    disabled={riskLotsEnforced}
                    title={riskLotsEnforced ? "Auto-computed from Risk/trade % - set a stop-loss to size this. Turn off in Checklist & Risk Settings to type your own." : undefined}
                    onChange={(e) => updateRow(row.id, { draftQuantity: e.target.value })}
                    placeholder={riskLotsEnforced ? "Set SL" : "Auto"}
                  />
                  {lotConversionHint(row) && (
                    <span className="manual-lot-hint" title="Lots × real per-lot size (market-data's DeltaProvider.get_lot_size) = total underlying units, matching Delta's own Lot convention">
                      {lotConversionHint(row)}
                    </span>
                  )}
                </label>
                  </>
                )}
                {showEntrySlTarget && row.instrumentType === "option" && (
                  <label title="Compared against the underlying's spot LTP - a pure browser-side watch until this order is open, then Update also persists it server-side via PUT /option-groups/{id}/spot-stop-loss (execution's own exit-monitor, survives this tab closing).">
                    SL Limit
                    <input
                      type="number"
                      className="manual-price-input"
                      min="0"
                      step="0.01"
                      value={row.draftSlLimit}
                      onChange={(e) => updateRow(row.id, { draftSlLimit: e.target.value })}
                      placeholder="None"
                    />
                  </label>
                )}
                {showEntrySlTarget && row.instrumentType !== "option" && (
                  <>
                    <label className="checkbox-label tiny">
                      <input
                        type="checkbox"
                        checked={row.trailSlEnabled}
                        onChange={(e) => updateRow(row.id, { trailSlEnabled: e.target.checked })}
                      />
                      Trail SL
                    </label>
                    {row.trailSlEnabled ? (
                      <>
                        <label>
                          Method
                          <select
                            value={row.draftSlMethod}
                            onChange={(e) => updateRow(row.id, { draftSlMethod: e.target.value as StopLossMethod })}
                          >
                            <option value="percent">%</option>
                            <option value="previous_candle">Previous low</option>
                            <option value="indicator">Indicator</option>
                          </select>
                        </label>
                        {row.draftSlMethod === "percent" && (
                          <label>
                            SL %
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={row.draftSlPercent}
                              onChange={(e) => updateRow(row.id, { draftSlPercent: e.target.value })}
                              placeholder="e.g. 2"
                            />
                          </label>
                        )}
                        {(row.draftSlMethod === "previous_candle" || row.draftSlMethod === "indicator") && (
                          <label>
                            Interval
                            <select
                              value={row.draftSlInterval}
                              onChange={(e) => updateRow(row.id, { draftSlInterval: e.target.value as StopLossInterval })}
                            >
                              <option value="1min">1 min</option>
                              <option value="3min">3 min</option>
                              <option value="5min">5 min</option>
                              <option value="15min">15 min</option>
                              <option value="25min">25 min</option>
                              <option value="30min">30 min</option>
                              <option value="60min">60 min</option>
                            </select>
                          </label>
                        )}
                        {row.draftSlMethod === "indicator" && (
                          <>
                            <label>
                              Indicator
                              <select
                                value={row.draftSlIndicatorType}
                                onChange={(e) =>
                                  updateRow(row.id, { draftSlIndicatorType: e.target.value as StopLossIndicatorType })
                                }
                              >
                                <option value="ema">EMA</option>
                                <option value="supertrend">SuperTrend</option>
                              </select>
                            </label>
                            <label>
                              Period
                              <input
                                type="number"
                                min="2"
                                step="1"
                                value={row.draftSlIndicatorPeriod}
                                onChange={(e) => updateRow(row.id, { draftSlIndicatorPeriod: e.target.value })}
                              />
                            </label>
                            {row.draftSlIndicatorType === "supertrend" && (
                              <label>
                                Multiplier
                                <input
                                  type="number"
                                  min="0"
                                  step="0.1"
                                  value={row.draftSlMultiplier}
                                  onChange={(e) => updateRow(row.id, { draftSlMultiplier: e.target.value })}
                                />
                              </label>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <label>
                        SL Limit
                        <input
                          type="number"
                          className="manual-price-input"
                          min="0"
                          step="0.01"
                          value={row.draftStopLossPrice}
                          onChange={(e) => updateRow(row.id, { draftStopLossPrice: e.target.value })}
                          placeholder="None"
                        />
                      </label>
                    )}
                  </>
                )}
                {!row.current && (
                  <label>
                    <span className="manual-field-label-row">
                      Limit
                      <span className="manual-toggle-group manual-price-mode-toggle">
                        <button
                          type="button"
                          className={`manual-toggle ${row.priceMode === "market" ? "active" : ""}`}
                          title="Fill at the live market price when submitted"
                          onClick={() => updateRow(row.id, { priceMode: "market", draftLimitPrice: "" })}
                        >
                          Market
                        </button>
                        <button
                          type="button"
                          className={`manual-toggle ${row.priceMode === "limit" ? "active" : ""}`}
                          title="Wait until spot crosses a price you set"
                          onClick={() =>
                            updateRow(row.id, {
                              priceMode: "limit",
                              draftLimitPrice: row.lastKnownLtp != null ? row.lastKnownLtp.toFixed(2) : row.draftLimitPrice,
                            })
                          }
                        >
                          Limit
                        </button>
                      </span>
                    </span>
                    <input
                      type="number"
                      className="manual-price-input"
                      min="0"
                      step="0.01"
                      value={row.priceMode === "market" ? (row.lastKnownLtp != null ? row.lastKnownLtp.toFixed(2) : "") : row.draftLimitPrice}
                      disabled={row.priceMode === "market"}
                      onChange={(e) => updateRow(row.id, { draftLimitPrice: e.target.value })}
                      placeholder={row.priceMode === "market" ? "Current market price" : "e.g. 24350"}
                      title={row.priceMode === "market" ? "Live preview only - the order fills at whatever price is current when you submit" : undefined}
                    />
                  </label>
                )}
                {showEntrySlTarget && (
                  <span className="manual-field-group manual-target-group">
                    <label title="Browser-only watch - closes the position from this tab when spot crosses it. Requires this tab to stay open; not visible in execution's own Positions page.">
                      Target (browser only)
                      <input
                        type="number"
                        className="manual-price-input"
                        min="0"
                        step="0.01"
                        value={row.draftTarget}
                        onChange={(e) => updateRow(row.id, { draftTarget: e.target.value })}
                        placeholder="None"
                      />
                    </label>
                    {rr != null && (
                      <span
                        className={`manual-rr-indicator ${rrBelowMin ? "pnl-negative" : "pnl-positive"}`}
                        title={
                          row.current
                            ? "Reward:Risk from Limit (or live LTP)/Target/SL Limit"
                            : `Reward:Risk from Limit (or live LTP)/Target/SL Limit - needs >=1:${minRR} to place this order`
                        }
                      >
                        RR 1:{rr.toFixed(1)}
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="manual-action-group">
                <button
                  type="button"
                  className="btn-add"
                  disabled={row.current ? row.current.state === "pending" : newOrderBlockedReason != null}
                  title={row.current ? undefined : (newOrderBlockedReason ?? undefined)}
                  onClick={() => (row.current ? void handleSave(row) : placeOrder(row))}
                >
                  {row.current ? "Update" : "Add"}
                </button>
                {justSaved[row.id] && (
                  <span className="manual-saved-badge">
                    <CheckIcon /> Saved
                  </span>
                )}
              </div>
            </div>

            {/* Option rows: the real cost is the resolved legs' NET premium
                (long - short for a spread), only known once the option
                chain is actually resolved server-side at order time - this
                preview only ever has the underlying's own spot LTP to work
                with, which would be wildly misleading shown as "order
                value" for an option trade (spot price vs. a premium are
                different orders of magnitude). Suppressed here rather than
                shown wrong. */}
            {!row.current && row.instrumentType !== "option" && (
              <span className="muted">Order value &#8776; {orderValuePreview(row)}</span>
            )}

            {row.rowError && <p className="error">{row.rowError}</p>}

            {row.current && (
              <div className="manual-current-status">
                {row.current.state === "pending" ? (
                  <div className="manual-pending-grid">
                    <div className="manual-pending-cell">
                      <span>Symbol</span>
                      <span className="manual-pending-value">{row.symbol}</span>
                    </div>
                    <div className="manual-pending-cell">
                      <span>Action</span>
                      <span className="manual-pending-value">{row.current.action}</span>
                    </div>
                    <div className="manual-pending-cell">
                      <span>Qty</span>
                      <span className="manual-pending-value">{row.current.quantity != null ? fmtQty(row.current.quantity) : "Auto"}</span>
                    </div>
                    <label className="manual-pending-cell">
                      Trigger
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.draftPendingPrice}
                        onChange={(e) => updateRow(row.id, { draftPendingPrice: e.target.value })}
                      />
                    </label>
                    <div className="manual-pending-actions">
                      <button type="button" className="btn-save tiny" onClick={() => void updatePendingTriggerPrice(row)}>
                        Update
                      </button>
                      <button type="button" className="btn-exit tiny" onClick={() => cancelPendingCurrent(row.id)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="manual-open-table-wrap">
                    <table className="manual-open-table">
                      <thead>
                        <tr>
                          <th>Leg</th>
                          <th>Trade</th>
                          <th>{row.instrumentType === "option" ? "Strike" : "Symbol"}</th>
                          <th>Qty</th>
                          <th>Entry</th>
                          <th>LTP</th>
                          <th>PnL</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.instrumentType === "option" && row.current.legs && row.current.legs.length > 0 ? (
                          (() => {
                            const legs = row.current!.legs!;
                            return legs.map((leg, i) => (
                              <tr key={leg.id}>
                                <td>{i + 1}</td>
                                <td className={leg.action === "BUY" ? "manual-leg-buy" : "manual-leg-sell"}>{leg.action}</td>
                                <td>{leg.symbol}</td>
                                <td>{fmtQty(leg.quantity)}</td>
                                <td>{fmt(leg.entry_price)}</td>
                                <td>{fmt(leg.live_price)}</td>
                                <td className={pnlClass(leg.unrealized_pnl)}>{fmtPnlWithPercent(leg.unrealized_pnl, leg.entry_price, leg.quantity)}</td>
                                {i === 0 && (
                                  <td rowSpan={legs.length} className="manual-open-table-close">
                                    <button type="button" className="manual-icon-btn" title="Exit position" onClick={() => handleExitClick(row)}>
                                      &#215;
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ));
                          })()
                        ) : (
                          <tr>
                            <td>1</td>
                            <td className={row.current.action === "BUY" ? "manual-leg-buy" : "manual-leg-sell"}>{row.current.action}</td>
                            <td>{row.symbol}</td>
                            <td>{fmtQty(row.current.quantityLive ?? row.current.quantity)}</td>
                            <td>{fmt(row.current.entryPrice)}</td>
                            <td>{fmt(row.current.livePrice)}</td>
                            <td className={pnlClass(row.current.unrealizedPnl)}>
                              {fmtPnlWithPercent(row.current.unrealizedPnl, row.current.entryPrice, row.current.quantityLive ?? row.current.quantity)}
                            </td>
                            <td className="manual-open-table-close">
                              <button type="button" className="manual-icon-btn" title="Exit position" onClick={() => handleExitClick(row)}>
                                &#215;
                              </button>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {row.current.stopLossPrice != null && (
                      <p className="manual-open-table-sl muted">
                        SL{row.current.trailingStopEnabled ? " (trailing)" : ""}: {fmt(row.current.stopLossPrice)}
                        {row.current.trailingStopEnabled && row.current.stopLossMethod ? ` ${row.current.stopLossMethod}` : ""}
                      </p>
                    )}
                  </div>
                )}
                {row.current.error && (
                  <p className="error">
                    {row.current.error}{" "}
                    <button type="button" className="tiny secondary" onClick={() => clearErroredCurrent(row.id)}>
                      Clear
                    </button>
                  </p>
                )}
              </div>
            )}

            {todaysHistory.length > 0 && (
              <>
                <button
                  type="button"
                  className="manual-divider"
                  onClick={() => {
                    const nowExpanded = !expandedHistory[row.id];
                    setExpandedHistory((prev) => ({ ...prev, [row.id]: nowExpanded }));
                    if (nowExpanded) void loadImagesForRow(row);
                  }}
                >
                  <span>Trade history</span>
                  <span className="manual-divider-chevron">{expandedHistory[row.id] ? "▾" : "▸"}</span>
                </button>
                {expandedHistory[row.id] && (
                  <div className="manual-history-list">
                    {todaysHistory.map((h) => (
                      <div key={h.id}>
                        <div className="manual-history-row">
                          <span className="manual-history-meta">
                            <span className="muted">{formatCompact(h.exit_time)}</span>
                            <span>{historyLabel(h)}</span>
                            <span className="muted">Qty {fmtQty(h.quantity)}</span>
                            {h.order_type && (
                              <span className="manual-order-type-badge" title={h.order_type === "market" ? "Market order" : "Limit order"}>
                                {h.order_type === "market" ? "MKT" : "LMT"}
                              </span>
                            )}
                          </span>
                          <span className="manual-history-right">
                            <span className={pnlClass(h.pnl)}>
                              {fmt(h.pnl)}
                              {pnlPercentLabel(h)}
                            </span>
                            {h.reviewed_at == null ? (
                              <button
                                type="button"
                                className="manual-icon-btn"
                                title="Review this trade"
                                onClick={() => toggleInlineReview(h.id)}
                              >
                                <ReviewIcon />
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="manual-reviewed-badge manual-icon-btn"
                                title={`Reviewed ${formatCompact(h.reviewed_at)} - click to view`}
                                onClick={() => setViewReviewId((id) => (id === h.id ? null : h.id))}
                              >
                                <CheckIcon />
                              </button>
                            )}
                            <button
                              type="button"
                              className={`manual-icon-btn ${expandedImagesId[h.id] ? "active" : ""}`}
                              title={
                                (imagesByEntryId[h.id]?.length ?? 0) > 0
                                  ? `${imagesByEntryId[h.id]!.length} attached screenshot(s) - click to view`
                                  : "Attach a screenshot for future review"
                              }
                              onClick={() => setExpandedImagesId((prev) => ({ ...prev, [h.id]: !prev[h.id] }))}
                            >
                              <ImageIcon />
                              {(imagesByEntryId[h.id]?.length ?? 0) > 0 && (
                                <span className="manual-icon-btn-count">{imagesByEntryId[h.id]!.length}</span>
                              )}
                            </button>
                          </span>
                        </div>
                        {expandedImagesId[h.id] && (
                          <div className="manual-history-images-panel">
                            {(imagesByEntryId[h.id]?.length ?? 0) > 0 && (
                              <div className="manual-history-images">
                                {imagesByEntryId[h.id]!.map((img) => (
                                  <span className="manual-history-image-thumb" key={img.id}>
                                    <a href={tradeImageUrl(img.id)} target="_blank" rel="noreferrer">
                                      <img src={tradeImageUrl(img.id)} alt="attached chart" loading="lazy" />
                                    </a>
                                    <button
                                      type="button"
                                      className="manual-history-image-remove"
                                      title="Delete this image"
                                      onClick={() => void removeImage(h, img.id)}
                                    >
                                      &#215;
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                            <label className="manual-image-upload-label">
                              {uploadingImageId === h.id ? "Uploading..." : "+ Add screenshot"}
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp,image/gif"
                                className="manual-file-input-hidden"
                                disabled={uploadingImageId === h.id}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (file) void uploadImageForEntry(h, file);
                                }}
                              />
                            </label>
                            {imageError?.entryId === h.id && <p className="error">{imageError.message}</p>}
                          </div>
                        )}
                        {viewReviewId === h.id && (
                          <div className="manual-inline-review manual-review-readonly">
                            <div className="manual-review-banner-row">
                              <span>Followed plan without deviation?</span>
                              <span className={h.review_violation ? "pnl-negative" : "pnl-positive"}>
                                {h.review_violation ? "No" : "Yes"}
                              </span>
                            </div>
                            {h.review_violation && h.review_notes && (
                              <p className="manual-review-readonly-notes">&ldquo;{h.review_notes}&rdquo;</p>
                            )}
                            {h.review_checklist && h.review_checklist.length > 0 && (
                              <div className="manual-checklist">
                                <span className="manual-checklist-title">Self-check</span>
                                <div className="manual-checklist-items">
                                  {h.review_checklist.map((a) => (
                                    <span className="manual-review-readonly-item" key={a.label}>
                                      {a.checked ? "✓" : "✗"} {a.label}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {inlineReviewId === h.id && (
                          <div className="manual-inline-review">
                            <div className="manual-review-banner-row">
                              <span>Did you follow your full plan without deviation?</span>
                              <span className="manual-toggle-group">
                                <button
                                  type="button"
                                  className={`manual-toggle ${inlineReviewFollowedPlan === true ? "active-buy" : ""}`}
                                  onClick={() => setInlineReviewFollowedPlan(true)}
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  className={`manual-toggle ${inlineReviewFollowedPlan === false ? "active-sell" : ""}`}
                                  onClick={() => setInlineReviewFollowedPlan(false)}
                                >
                                  No
                                </button>
                              </span>
                            </div>
                            {inlineReviewFollowedPlan === false && (
                              <textarea
                                placeholder="What was violated?"
                                value={inlineReviewNotes}
                                onChange={(e) => setInlineReviewNotes(e.target.value)}
                                rows={2}
                              />
                            )}
                            {reviewItems.filter((item) => appliesToSegment(item, h.segment)).length > 0 && (
                              <div className="manual-checklist">
                                <span className="manual-checklist-title">
                                  Self-check (unchecked = didn't happen, that's fine to record)
                                </span>
                                <div className="manual-checklist-items">
                                  {reviewItems
                                    .filter((item) => appliesToSegment(item, h.segment))
                                    .map((item) => (
                                      <label className="checkbox-label tiny" key={item.id}>
                                        <input
                                          type="checkbox"
                                          checked={!!inlineReviewChecklistChecked[item.id]}
                                          onChange={(e) =>
                                            setInlineReviewChecklistChecked((prev) => ({
                                              ...prev,
                                              [item.id]: e.target.checked,
                                            }))
                                          }
                                        />
                                        {item.label}
                                      </label>
                                    ))}
                                </div>
                              </div>
                            )}
                            {h.pnl != null && h.pnl < 0 && (
                              <label className="checkbox-label tiny">
                                <input
                                  type="checkbox"
                                  checked={inlineReviewAcceptedLoss}
                                  onChange={(e) => setInlineReviewAcceptedLoss(e.target.checked)}
                                />
                                I accept this loss
                              </label>
                            )}
                            {inlineReviewError && <p className="error">{inlineReviewError}</p>}
                            <div className="manual-review-banner-row">
                              <button
                                type="button"
                                className="btn-save tiny"
                                disabled={inlineReviewFollowedPlan === null || inlineReviewSubmitting}
                                onClick={() => void submitInlineReview(row, h)}
                              >
                                Submit review
                              </button>
                              <button type="button" className="tiny secondary" onClick={() => setInlineReviewId(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            </>
            )}
          </section>
        );
      })}
    </>
  );
}

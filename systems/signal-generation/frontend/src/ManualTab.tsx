import { useEffect, useRef, useState } from "react";

import {
  type ManualStopLossConfig,
  type OptionPositionStyle,
  type OptionStrikeMoneyness,
  type Segment,
  type StopLossIndicatorParams,
  type StopLossIndicatorType,
  type StopLossInterval,
  type StopLossMethod,
  createManualOptionGroup,
  createManualPosition,
  fetchCryptoSymbols,
  fetchExecPositions,
  fetchLotSize,
  fetchLtp,
  fetchOptionGroups,
  resolveUnderlying,
  squareOffManualPosition,
  squareOffOptionGroup,
  updateStopLoss,
} from "./api";

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

function LockIcon({ locked }: { locked: boolean }) {
  return locked ? (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  );
}

type InstrumentType = "spot" | "future" | "option";
type ExitReason = "manual" | "target" | "stop_loss";

// Exactly one order/position slot per row now ("first open position
// visible at top", per the redesign) - action/instrumentType/optionStyle
// are snapshotted onto the instance at creation so the row's own header
// fields can be locked (and safely stay locked) while it's pending/open,
// and so history rows can label themselves correctly later without
// depending on the row's current (possibly since-changed) fields.
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
  draftLimitPrice: string; // "Spot Limit" - entry, blank = market/CMP
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
  // User-toggleable, independent of whether a position is open (which
  // always locks these 3 regardless) - lets Segment/Symbol/Instrument be
  // locked proactively too, e.g. to avoid fat-fingering a change between
  // sequential orders on the same symbol.
  manualLock: boolean;
  lastKnownLtp?: number;
  current: OrderInstance | null;
  history: HistoryEntry[];
  rowError?: string;
};

function newRow(): ManualRow {
  return {
    id: crypto.randomUUID(),
    segment: "CRYPTO",
    instrumentType: "spot",
    symbol: "",
    action: "BUY",
    optionStyle: "spread",
    moneyness: "ATM",
    draftQuantity: "",
    draftLimitPrice: "",
    manualLock: false,
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
  };
}

// history/rowError/lastKnownLtp aren't persisted - always start fresh on
// reload (history is re-derivable as trades close during the session;
// persisting it indefinitely could grow unbounded). `current` (the one
// pending/open slot, if any) does persist, so an armed watch survives a
// page refresh.
function loadRows(): ManualRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ManualRow[];
    return parsed.map((r) => ({ ...r, history: [], rowError: undefined, lastKnownLtp: undefined }));
  } catch {
    return [];
  }
}

function saveRows(rows: ManualRow[]) {
  const persisted = rows.map(({ history, rowError, lastKnownLtp, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function fmt(n: number | null | undefined, digits = 2): string {
  return n == null ? "-" : n.toFixed(digits);
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 0 ? "pnl-positive" : "pnl-negative";
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

  // Which rows have their closed-trades list expanded - toggled by
  // clicking "Present day PnL" (the mockup's "Collapsible section below"
  // divider/toggle), collapsed by default.
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});

  // Cards persist until explicitly removed - the × asks for confirmation
  // first (an in-page Yes/No, not window.confirm - a native dialog blocks
  // the whole tab's event loop, including this same click handler's own
  // follow-up work). Only one row confirms removal at a time.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  useEffect(() => {
    saveRows(rows);
  }, [rows]);

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

  // Real per-symbol lot multiplier for CRYPTO futures (e.g. BTCUSD=0.001)
  // - fetched lazily per symbol as rows reference one, cached by symbol
  // since it's static (not a live-updating value like price). Backs the
  // "Lots" quantity field and order-value preview below, matching
  // execution's own lot-based sizing (see position_manager.py's
  // open_manual_position).
  const [lotSizeCache, setLotSizeCache] = useState<Record<string, number>>({});
  useEffect(() => {
    const missing = rows
      .filter((r) => r.segment === "CRYPTO" && r.instrumentType === "future" && r.symbol && !(r.symbol in lotSizeCache))
      .map((r) => r.symbol);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((sym) => fetchLotSize("CRYPTO", sym).then((lot) => [sym, lot] as const).catch(() => null)))
      .then((results) => {
        if (cancelled) return;
        const updates = Object.fromEntries(results.filter((r): r is readonly [string, number] => r !== null));
        if (Object.keys(updates).length > 0) setLotSizeCache((prev) => ({ ...prev, ...updates }));
      });
    return () => {
      cancelled = true;
    };
  }, [rows, lotSizeCache]);

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

  function updateCurrent(rowId: string, instanceId: string, patch: Partial<OrderInstance>) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId && r.current?.id === instanceId ? { ...r, current: { ...r.current!, ...patch } } : r)),
    );
  }

  function moveCurrentToHistory(rowId: string, instanceId: string, entry: HistoryEntry) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId && r.current?.id === instanceId ? { ...r, current: null, history: [entry, ...r.history] } : r,
      ),
    );
  }

  // A pending instance is a pure browser-side watch (no backend order
  // exists yet), so canceling one is just clearing local state - no API
  // call, and it never traded so it doesn't become a history entry.
  function cancelPendingCurrent(rowId: string) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, current: null } : r)));
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
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) return;
    const quantity = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    const limitPrice = row.draftLimitPrice ? Number(row.draftLimitPrice) : undefined;
    const target = row.draftTarget ? Number(row.draftTarget) : undefined;
    const slLimit = row.draftSlLimit ? Number(row.draftSlLimit) : undefined;

    updateRow(row.id, { draftLimitPrice: "", rowError: undefined });

    const instance: OrderInstance = {
      id: crypto.randomUUID(),
      state: "pending",
      action: row.action,
      instrumentType: row.instrumentType,
      optionStyle: row.instrumentType === "option" ? row.optionStyle : undefined,
      quantity,
      targetPrice: target,
      slLimitPrice: slLimit,
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

    updateRow(row.id, { current: { ...instance, triggerPrice: limitPrice, startedAboveTarget } });
  }

  async function executeOrder(row: ManualRow, symbol: string, instance: OrderInstance, price: number | undefined) {
    try {
      const resolvedPrice = price ?? (await fetchUnderlyingLtp(row.segment, symbol));
      if (instance.instrumentType === "option") {
        const created = await createManualOptionGroup({
          segment: row.segment,
          symbol,
          action: instance.action,
          option_position_style: instance.optionStyle ?? "spread",
          option_strike_moneyness: row.moneyness,
          option_fixed_lots: instance.quantity,
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
        });
      } else {
        const created = await createManualPosition({
          segment: row.segment,
          symbol,
          action: instance.action,
          instrument_type: instance.instrumentType as "spot" | "future",
          price: resolvedPrice,
          quantity: instance.quantity,
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
            exit_time: null,
          });
          return "closed";
        }
        const updated: OrderInstance = {
          ...instance,
          groupId: group.id,
          livePrice: group.live_combined_price ?? undefined,
          unrealizedPnl: group.unrealized_pnl ?? undefined,
          quantityLive: group.quantity ?? undefined,
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
          id: crypto.randomUUID(),
          action: instance.action,
          instrumentType: instance.instrumentType,
          optionStyle: instance.optionStyle,
          entry_price: instance.entryPrice ?? null,
          exit_price: null,
          quantity: instance.quantityLive ?? null,
          pnl: result.pnl,
          exit_reason: reason,
          exit_time: new Date().toISOString(),
        });
      } else {
        const result = await squareOffManualPosition(instance.positionId ?? "");
        moveCurrentToHistory(row.id, instance.id, {
          id: crypto.randomUUID(),
          action: instance.action,
          instrumentType: instance.instrumentType,
          optionStyle: instance.optionStyle,
          entry_price: instance.entryPrice ?? null,
          exit_price: result.exit_price,
          quantity: result.closed_quantity,
          pnl: result.pnl,
          exit_reason: reason,
          exit_time: new Date().toISOString(),
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
          updateCurrent(row.id, row.current.id, {
            error: err instanceof Error ? err.message : "failed to update stop-loss",
          });
        }
      }
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

  const presentDayPnl = (row: ManualRow): { text: string; cls: string } => {
    const today = new Date().toDateString();
    const total = row.history
      .filter((h) => h.exit_time && new Date(h.exit_time).toDateString() === today)
      .reduce((sum, h) => sum + (h.pnl ?? 0), 0);
    const unit = row.segment === "CRYPTO" ? "USD" : "INR";
    return { text: `Present day PnL: ${total.toFixed(2)} ${unit}`, cls: pnlClass(total) };
  };

  return (
    <>
      <button type="button" className="manual-add-instrument-btn" onClick={() => setRows((prev) => [...prev, newRow()])}>
        <PlusIcon /> Add instrument
      </button>

      {rows.map((row) => {
        const openLocked = !!row.current;
        const fieldsDisabled = openLocked || row.manualLock;
        const pnl = presentDayPnl(row);
        return (
          <section className="panel manual-card" key={row.id}>
            <div className="manual-card-header">
              <div className="manual-card-fields">
                <label>
                  Segment
                  <select
                    value={row.segment}
                    disabled={fieldsDisabled}
                    onChange={(e) => {
                      const segment = e.target.value as Segment;
                      // Symbols aren't portable across segments (e.g.
                      // BTCUSD means nothing on NSE) - clear it rather than
                      // leave a stale, guaranteed-invalid value sitting in
                      // the field.
                      updateRow(row.id, { segment, symbol: "", lastKnownLtp: undefined });
                    }}
                  >
                    <option value="NSE">NSE</option>
                    <option value="MCX">MCX</option>
                    <option value="CRYPTO">CRYPTO</option>
                  </select>
                </label>
                <label>
                  Symbol
                  {row.segment === "CRYPTO" && cryptoSymbols.length > 0 ? (
                    <select
                      value={row.symbol}
                      disabled={fieldsDisabled}
                      onChange={(e) => updateRow(row.id, { symbol: e.target.value, lastKnownLtp: undefined })}
                      onBlur={(e) => void refreshLtp(row.id, row.segment, e.target.value)}
                    >
                      <option value="" disabled>
                        Select a symbol
                      </option>
                      {(row.instrumentType === "option" ? CRYPTO_OPTION_SYMBOLS : cryptoSymbols).map((sym) => (
                        <option key={sym} value={sym}>
                          {sym}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={row.symbol}
                      disabled={fieldsDisabled}
                      onChange={(e) => updateRow(row.id, { symbol: e.target.value.toUpperCase(), lastKnownLtp: undefined })}
                      onBlur={(e) => void refreshLtp(row.id, row.segment, e.target.value)}
                      placeholder="e.g. BTCUSD, TCS"
                    />
                  )}
                </label>
                <label>
                  Instrument
                  <select
                    value={row.instrumentType}
                    disabled={fieldsDisabled}
                    onChange={(e) => {
                      const instrumentType = e.target.value as InstrumentType;
                      // Switching to Option for CRYPTO with a symbol that
                      // isn't option-eligible (e.g. SOLUSD) would otherwise
                      // leave a stale, guaranteed-to-422 selection sitting
                      // in the field - clear it so "Select a symbol" forces
                      // a real pick from the now-restricted list above.
                      const symbolStillValid =
                        instrumentType !== "option" ||
                        row.segment !== "CRYPTO" ||
                        CRYPTO_OPTION_SYMBOLS.includes(row.symbol);
                      updateRow(row.id, { instrumentType, symbol: symbolStillValid ? row.symbol : "" });
                    }}
                  >
                    <option value="spot">Spot</option>
                    <option value="future">Future</option>
                    <option value="option">Option</option>
                  </select>
                </label>
                <button
                  type="button"
                  className={`manual-icon-btn manual-lock-btn ${row.manualLock ? "active" : ""}`}
                  disabled={openLocked}
                  title={row.manualLock ? "Unlock Segment/Symbol/Instrument" : "Lock Segment/Symbol/Instrument"}
                  onClick={() => updateRow(row.id, { manualLock: !row.manualLock })}
                >
                  <LockIcon locked={fieldsDisabled} />
                </button>
              </div>
              <div className="manual-card-summary">
                <button
                  type="button"
                  className="manual-pnl-toggle"
                  onClick={() => setExpandedHistory((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                >
                  <span className={pnl.cls}>{pnl.text}</span>
                </button>
                {!row.current &&
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
              </div>
            </div>

            <div className="manual-order-row">
              <div className="manual-entry-group">
                <span className="manual-field-group">
                  <span className="manual-field-label">Buy/Sell</span>
                  <span className="manual-toggle-group">
                    <button
                      type="button"
                      className={`manual-toggle ${row.action === "BUY" ? "active-buy" : ""}`}
                      disabled={openLocked}
                      onClick={() => updateRow(row.id, { action: "BUY" })}
                    >
                      BUY
                    </button>
                    <button
                      type="button"
                      className={`manual-toggle ${row.action === "SELL" ? "active-sell" : ""}`}
                      disabled={openLocked}
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
                        disabled={openLocked}
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
                        disabled={openLocked}
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
                    disabled={openLocked}
                    onChange={(e) => updateRow(row.id, { draftQuantity: e.target.value })}
                    placeholder="Auto"
                  />
                </label>
                <label>
                  Spot Limit
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.draftLimitPrice}
                    disabled={openLocked}
                    onChange={(e) => updateRow(row.id, { draftLimitPrice: e.target.value })}
                    placeholder="Market"
                  />
                </label>
                <button type="button" className="btn-add" disabled={openLocked || !row.symbol.trim()} onClick={() => placeOrder(row)}>
                  Add
                </button>
              </div>
              {row.symbol && (
                <span className="manual-ltp-live">
                  LTP {row.lastKnownLtp != null ? fmt(row.lastKnownLtp) : "..."}
                  <span className="manual-ltp-unit">{row.segment === "CRYPTO" ? "USD" : "INR"}</span>
                </span>
              )}
              <div className="manual-exit-group">
                <label>
                  Spot Target
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.draftTarget}
                    onChange={(e) => updateRow(row.id, { draftTarget: e.target.value })}
                    placeholder="None"
                  />
                </label>
                {row.instrumentType === "option" ? (
                  <label>
                    Spot SL Limit
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.draftSlLimit}
                      onChange={(e) => updateRow(row.id, { draftSlLimit: e.target.value })}
                      placeholder="None"
                    />
                  </label>
                ) : (
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
                        SL Price
                        <input
                          type="number"
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
                <button type="button" className="btn-save" disabled={!row.current} onClick={() => void handleSave(row)}>
                  Save
                </button>
              </div>
              <button
                type="button"
                className="btn-exit manual-squareoff-btn"
                disabled={!row.current}
                onClick={() => handleExitClick(row)}
              >
                {row.current?.state === "pending" ? "Cancel" : "Square off"}
              </button>
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
                  <span>Pending @ {row.current.triggerPrice} (spot)</span>
                ) : (
                  <span>
                    Open &middot; Qty {fmt(row.current.quantityLive ?? row.current.quantity, 4)} &middot; Entry{" "}
                    {fmt(row.current.entryPrice)} &middot; CMP {fmt(row.current.livePrice)} &middot; P&amp;L{" "}
                    <span className={pnlClass(row.current.unrealizedPnl)}>{fmt(row.current.unrealizedPnl)}</span>
                    {row.current.stopLossPrice != null && (
                      <>
                        {" "}
                        &middot; SL {fmt(row.current.stopLossPrice)}
                        {row.current.trailingStopEnabled &&
                          ` (trailing${row.current.stopLossMethod ? `: ${row.current.stopLossMethod}` : ""})`}
                      </>
                    )}
                  </span>
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

            {row.history.length > 0 && (
              <>
                <div className="manual-divider">
                  <span>Trade history</span>
                </div>
                {expandedHistory[row.id] && (
                  <div className="manual-history-list">
                    {row.history.map((h) => (
                      <div className="manual-history-row" key={h.id}>
                        <span className="manual-history-meta">
                          <span className="muted">{formatCompact(h.exit_time)}</span>
                          <span>{historyLabel(h)}</span>
                          <span className="muted">Qty {fmt(h.quantity, 4)}</span>
                        </span>
                        <span className={pnlClass(h.pnl)}>
                          {fmt(h.pnl)}
                          {pnlPercentLabel(h)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}

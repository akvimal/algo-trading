import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  type Account,
  type ManualOptionGroup,
  type ManualOptionLeg,
  type ManualPosition,
  type ManualStopLossConfig,
  type OptionPositionStyle,
  type OptionStrikeMoneyness,
  type Segment,
  type StopLossIndicatorType,
  type StopLossInterval,
  fetchExecPositions,
  fetchOptionGroups,
  squareOffManualPosition,
  squareOffOptionGroup,
  updateOptionGroupNotes,
  updateOptionGroupSpotStopLoss,
  updateOptionGroupSpotTarget,
  updateOptionGroupSquareOffTime,
  updateOptionGroupTags,
  updatePositionNotes,
  updatePositionSquareOffTime,
  updatePositionTags,
  updateStopLoss,
} from "./api";
import type { PricePickField } from "./LiveChartPanel";
import {
  CRYPTO_OPTION_SYMBOLS,
  type PanelStrategy,
  type PendingOrder,
  SETUP_TAGS,
  checkExitTrigger,
  computeRR,
  dayKey,
  fetchUnderlyingLtp,
  fmt,
  fmtQty,
  formatCompact,
  pnlClass,
  placeManualOrder,
  previewRiskLots,
  resolveUnderlyingCached,
  rrDirectionValid,
  todayKey,
} from "./manualOrder";

// The compact single-instrument order panel down the right side of the
// Live Chart (docs/architecture.md § "Live chart - inline trade panel").
// The chart fixes the symbol, so this is single-slot: one order at a
// time, no "+ Add instrument", no segment picker, NO discipline-checklist
// step (that gate was removed from POST /positions|option-groups/manual
// 2026-09-03 - the checklist system is record-only now).
//
// A "Trade with the <interval> trend only" checkbox sits above the form
// (persisted, off by default): when on it locks the bias to the chart
// interval's confirmed SMC structure trend (up -> Bullish, down ->
// Bearish, ranging -> no trade). The trend comes in as a prop, lifted
// from LiveChartPanel by LiveChartPage.
//
// SCOPE - a focused subset of WorkspacePage, not a second copy of its
// engine. Entry: Bullish/Bearish bias (tints the panel), an FnO strategy
// dropdown (Future / Naked / Spread, call vs put from the bias) + strike,
// MARKET orders, an optional stop-loss. Open position: a "Leg n" block
// per leg (one now, one per leg once spreads land) showing
// Entry / Qty / LTP / P&L, and below the grid a manage section:
//  - Stop-loss - Fixed price, OR (future only) Trail by an EMA /
//    SuperTrend on a chosen candle interval (execution's own
//    method-based trailing stop, updateStopLoss with
//    stop_loss_method='indicator').
//  - Target - a browser-side spot-price watch (no backend target field
//    exists for a manual order) that squares off on cross, mounted-only.
//  - Close-by time (backend) + Square off.
// Risk-per-trade and today's realized/unrealized P&L sit in the header;
// a formatted closed-trade history at the bottom. Not covered here at
// all (WorkspacePage.tsx still has the code, just unrouted since
// 2026-09-03): limit / SL-limit entries, %/previous-candle stop methods,
// partial exits, the trade-review flow.

const POLL_MS = 5000;

const MONEYNESS: OptionStrikeMoneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];

const SL_INTERVALS: StopLossInterval[] = ["1min", "3min", "5min", "15min", "25min", "30min", "60min"];

// The Live Chart persists its display interval here (LiveChartPanel's
// INTERVAL_STORAGE_KEY) - default the trailing-SL interval to match.
function chartSlInterval(): StopLossInterval {
  const v = localStorage.getItem("manualLiveChartInterval");
  return (SL_INTERVALS as string[]).includes(v ?? "") ? (v as StopLossInterval) : "5min";
}

// Normalized closed-trade row for the history list.
type ClosedTrade = {
  id: string;
  kind: "future" | "option"; // which /notes endpoint a comment edit hits
  label: string;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  pnl: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  exitTime: string | null;
  trendFollowed: boolean;
  riskManaged: boolean;
  notes: string;
  setupTag: string;
  confidence: number | null;
};

// One row of the open-position grid - a future position is a single row;
// an option group is one row per leg (all legs share the group's time).
type LegRow = {
  key: string;
  contract: string;
  contractFull: string;
  time: string;
  entry: number | null;
  qty: number | null;
  ltp: number | null;
  pnl: number | null;
};

function optionLabel(action: "BUY" | "SELL", style: OptionPositionStyle): string {
  if (style === "naked") return action === "BUY" ? "Naked Call" : "Naked Put";
  return action === "BUY" ? "Bull Call Spread" : "Bear Put Spread";
}

// The little ⌖ button beside a price field - click to arm a chart pick
// for that field (click again, or Esc, to cancel).
function PickBtn({ armed, onToggle }: { armed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`ctp-pick${armed ? " armed" : ""}`}
      title={armed ? "Click a price on the chart (Esc to cancel)" : "Set from the chart"}
      onClick={onToggle}
    >
      ⌖
    </button>
  );
}

function pnlPct(pnl: number | null, entry: number | null, qty: number | null): number | null {
  if (pnl == null || entry == null || qty == null) return null;
  const base = Math.abs(entry * qty);
  return base === 0 ? null : (pnl / base) * 100;
}

function positionToClosed(p: ManualPosition): ClosedTrade {
  return {
    id: p.id,
    kind: "future",
    label: `${p.action} ${p.instrument_type}`,
    entry: p.entry_price,
    exit: p.exit_price,
    qty: p.quantity,
    pnl: p.pnl,
    pnlPct: pnlPct(p.pnl, p.entry_price, p.quantity),
    exitReason: p.exit_reason,
    exitTime: p.exit_time,
    trendFollowed: p.trend_followed === true,
    riskManaged: p.risk_managed === true,
    notes: p.notes ?? "",
    setupTag: p.setup_tag ?? "",
    confidence: p.confidence ?? null,
  };
}

function groupToClosed(g: ManualOptionGroup): ClosedTrade {
  return {
    id: g.id,
    kind: "option",
    label: optionLabel(g.action, g.strategy_type.startsWith("naked") ? "naked" : "spread"),
    entry: g.net_debit,
    exit: null,
    qty: g.quantity,
    pnl: g.pnl,
    pnlPct: pnlPct(g.pnl, g.net_debit, g.quantity),
    exitReason: g.exit_reason,
    exitTime: g.exit_time,
    trendFollowed: g.trend_followed === true,
    riskManaged: g.risk_managed === true,
    notes: g.notes ?? "",
    setupTag: g.setup_tag ?? "",
    confidence: g.confidence ?? null,
  };
}

// A tradeable option symbol carries the strike + CE/PE at the end
// ("...24000CE"). Show the underlying prefix stripped for brevity, full
// thing on hover - reliably parsing the strike out of every provider's
// symbol scheme isn't worth it.
function contractLabel(legSymbol: string, underlying: string): string {
  const trimmed = legSymbol.toUpperCase().startsWith(underlying) ? legSymbol.slice(underlying.length) : legSymbol;
  return trimmed || legSymbol;
}

// HH:MM from an ISO timestamp, local.
function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function legRows(pos: ManualPosition | null, group: ManualOptionGroup | null, sym: string): LegRow[] {
  if (group) {
    const t = clock(group.entry_time);
    return group.legs.map((l: ManualOptionLeg) => ({
      key: l.id,
      contract: contractLabel(l.symbol, sym),
      contractFull: l.symbol,
      time: t,
      entry: l.entry_price,
      qty: l.quantity,
      ltp: l.live_price ?? null,
      pnl: l.unrealized_pnl ?? null,
    }));
  }
  if (pos) {
    return [
      {
        key: pos.id,
        contract: `${pos.action === "BUY" ? "Long" : "Short"} fut`,
        contractFull: pos.symbol,
        time: clock(pos.entry_time),
        entry: pos.entry_price,
        qty: pos.quantity,
        ltp: pos.live_price ?? null,
        pnl: pos.unrealized_pnl ?? null,
      },
    ];
  }
  return [];
}

// "15:20:00" | "15:20" | null -> "15:20" (the <input type="time"> value).
function hhmm(t: string | null | undefined): string {
  return (t ?? "").slice(0, 5);
}

export default function ChartTradePanel({
  segment,
  symbol,
  account,
  intervalTrend,
  chartInterval,
  forceTrend,
  riskManaged,
  chartLtp,
  pendingOrder,
  pendingNote,
  onArmPending,
  onCancelPending,
  pickField,
  onPickField,
  pickedPrice,
  onOpenTradeChange,
}: {
  segment: Segment;
  symbol: string;
  // The segment account (capital / risk% / min R:R) - fetched by
  // LiveChartPage (once per segment), passed in so "Risk/Trade" can live
  // in the discipline strip.
  account: Account | null;
  // Confirmed structure trend for the chart's current interval (null when
  // structure detection isn't running on that timeframe), + the interval
  // itself for the label. Lifted from LiveChartPanel by LiveChartPage.
  intervalTrend: "up" | "down" | "range" | null;
  chartInterval: string;
  // The "trade with the interval trend only" lock - its checkbox lives up
  // in LiveChartPage (aligned with the chart's interval strip), not here.
  forceTrend: boolean;
  // The "Risk managed" gate - its checkbox also lives in LiveChartPage.
  // When on: Limit/SL/Target required, lots omitted (execution risk-sizes
  // them), and Proceed blocked until reward:risk clears the segment's
  // min_reward_risk_ratio.
  riskManaged: boolean;
  // The chart's own live price - used as THE ltp (display + target watch)
  // so the panel never drifts from the chart. null until the chart has a
  // tick; the panel's own fetch is only a fallback for that gap.
  chartLtp: number | null;
  // A limit order armed for THIS symbol, watched by LiveChartPage's own
  // loop (which outlives this panel's per-symbol remount). null = none.
  pendingOrder: PendingOrder | null;
  // A post-fire message for this symbol (rejection reason / soft warning).
  pendingNote: string | null;
  onArmPending: (order: PendingOrder) => void;
  onCancelPending: (symbol: string) => void;
  // Chart price-pick: which of this panel's price fields is armed for a
  // chart click, a setter to arm/cancel, and the last price picked from
  // the chart (applied to whichever field is armed / open).
  pickField: PricePickField | null;
  onPickField: (f: PricePickField | null) => void;
  pickedPrice: { field: PricePickField; price: number; nonce: number } | null;
  // Emits this panel's single open trade (with its live P&L) so the chart
  // can mark it without a second live-P&L poll.
  onOpenTradeChange?: (t: { pos: ManualPosition | null; group: ManualOptionGroup | null }) => void;
}) {
  const sym = symbol.trim().toUpperCase();
  const optionEligible = segment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(sym);
  const unit = segment === "CRYPTO" ? "USD" : "INR";

  const [ltp, setLtp] = useState<number | null>(null);
  // The future contract's lot size for THIS underlying (65 for NIFTY, 10
  // for GOLDM, 0.001 for BTCUSD...) - resolveUnderlying returns it; used
  // only for the risk-managed lot-count preview.
  const [lotSize, setLotSize] = useState<number | null>(null);

  // --- Entry form ---
  const [action, setAction] = useState<"BUY" | "SELL">("BUY");
  // Market fires immediately at the live price; Limit arms a pending order
  // (LiveChartPage watches the spot and fires it on a crossing).
  const [entryType, setEntryType] = useState<"market" | "limit">("market");
  const [limitInput, setLimitInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  // Default the strategy by segment: CRYPTO trades the perpetual future
  // (its options are thin and only exist for a couple of symbols), NSE/MCX
  // default to a naked option (the usual manual play there). The panel
  // remounts on every segment/symbol switch (LiveChartPage keys it on
  // `ctp:<segment>:<symbol>`), so this initializer re-runs and re-picks
  // the right default each time - no effect needed. Still fully
  // overridable in the dropdown (and the `optionEligible` effect below
  // still forces `future` for a CRYPTO symbol with no option chain).
  const [strategy, setStrategy] = useState<PanelStrategy>(segment === "CRYPTO" ? "future" : "naked");
  const isOption = strategy !== "future";
  const [moneyness, setMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [qtyInput, setQtyInput] = useState("1");
  const [slInput, setSlInput] = useState("");
  // Trade journal, set at order time - the setup reason + a 1-5 confidence.
  // Optional; feeds Trading Performance's by-setup / confidence slices.
  const [setupTag, setSetupTag] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Open position (source of truth: execution, re-derived each poll) ---
  const [openPos, setOpenPos] = useState<ManualPosition | null>(null);
  const [openGroup, setOpenGroup] = useState<ManualOptionGroup | null>(null);
  const [squaringOff, setSquaringOff] = useState(false);
  const hasOpen = openPos != null || openGroup != null;
  const openId = openGroup?.id ?? openPos?.id ?? null;
  const openAction = openGroup?.action ?? openPos?.action ?? null;

  // Inline post-open edits, seeded once when a position first appears
  // (keyed on openId) so a poll never clobbers what the user is typing.
  // One "Save changes" button commits SL/trail/target/close-by together.
  const [edit, setEdit] = useState({ sl: "", target: "", closeBy: "" });
  const [savingAll, setSavingAll] = useState(false);
  const [savedAll, setSavedAll] = useState(false);
  // Stop-loss mode + the method-based trailing config (future only -
  // execution has no method-based SL for options).
  const [slMode, setSlMode] = useState<"fixed" | "trail">("fixed");
  const [slType, setSlType] = useState<StopLossIndicatorType>("ema");
  const [slPeriod, setSlPeriod] = useState("20");
  const [slMult, setSlMult] = useState("3");
  const [slInterval, setSlInterval] = useState<StopLossInterval>(chartSlInterval);
  // Armed browser-side target (a spot-price watch on the underlying) -
  // squares off on cross. Lives only while the panel is mounted; there's
  // no backend target field on a manual order.
  const [targetPx, setTargetPx] = useState<number | null>(null);
  // Latch so the target watch squares off exactly once - the 5s poll's
  // closure is stale after squareOff nulls openGroup/targetPx, so without
  // this it re-fires squareOff against an already-CLOSED group every tick.
  const exitFiredRef = useRef(false);
  // Re-entrancy guard for squareOff (state alone can't stop the stale
  // poll closure from calling it again mid-flight).
  const squaringOffRef = useRef(false);

  const [history, setHistory] = useState<ClosedTrade[]>([]);
  // Which history row's journal is being edited + its draft (note text +
  // setup tag + confidence). Saving diffs against the row and only calls
  // the endpoints whose value changed.
  const [noteEdit, setNoteEdit] = useState<{ id: string; text: string; tag: string; confidence: number | null } | null>(
    null,
  );
  const [noteBusy, setNoteBusy] = useState(false);
  // History rows whose (existing) note is expanded - collapsed by default.
  const [noteOpen, setNoteOpen] = useState<Set<string>>(() => new Set());
  const toggleNote = useCallback((id: string) => {
    setNoteOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // --- Lot size for the risk-managed preview (resolveUnderlyingCached is
  // a session-cached instrument-master lookup, no broker call). ---
  useEffect(() => {
    let cancelled = false;
    resolveUnderlyingCached(segment, sym)
      .then((r) => {
        if (!cancelled) setLotSize(r.lot_size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [segment, sym]);

  // A manual FUTURE persists its RESOLVED contract symbol (e.g.
  // "NIFTY-25Sep2026-FUT", or an MCX active-month contract), not the bare
  // underlying - so the server-side `symbol=` filter would never match.
  // Match on prefix instead (contract symbols start with the underlying);
  // option groups are keyed by `underlying_symbol` so those match direct.
  // A standalone future/spot Position for THIS symbol: matching prefix AND
  // NOT an option leg (option legs also carry an option_group_id and a
  // "NIFTY...CE" symbol that'd pass the prefix test - the group row is what
  // represents that trade, not its legs).
  const isStandaloneFuture = useCallback(
    (p: ManualPosition) => p.option_group_id == null && p.symbol.toUpperCase().startsWith(sym),
    [sym],
  );
  const isThisGroup = useCallback((g: ManualOptionGroup) => g.underlying_symbol.toUpperCase() === sym, [sym]);

  // --- Poll: LTP + open-position live P&L (+ backend-close detection).
  // History refreshes on the open→closed edge, not every tick. ---
  const refreshOpen = useCallback(async (): Promise<boolean | null> => {
    if (!sym) return false;
    try {
      const [positions, groups] = await Promise.all([
        fetchExecPositions({ segment, status: "OPEN", manualOnly: true, withLivePnl: true }),
        fetchOptionGroups({ segment, status: "OPEN", manualOnly: true, withLivePnl: true }),
      ]);
      const pos = positions.find(isStandaloneFuture) ?? null;
      const grp = groups.find(isThisGroup) ?? null;
      setOpenPos(pos);
      setOpenGroup(grp);
      return pos != null || grp != null;
    } catch {
      return null;
    }
  }, [sym, segment, isStandaloneFuture, isThisGroup]);

  const refreshHistory = useCallback(async () => {
    if (!sym) return;
    try {
      const today = todayKey();
      const [positions, groups] = await Promise.all([
        fetchExecPositions({ segment, status: "CLOSED", manualOnly: true, limit: 50 }),
        fetchOptionGroups({ segment, status: "CLOSED", manualOnly: true, limit: 50 }),
      ]);
      const seen = new Set<string>();
      const rows = [
        ...positions.filter(isStandaloneFuture).map(positionToClosed),
        ...groups.filter(isThisGroup).map(groupToClosed),
      ]
        .filter((r) => r.exitTime && dayKey(r.exitTime) === today && !seen.has(r.id) && seen.add(r.id))
        .sort((a, b) => (b.exitTime ?? "").localeCompare(a.exitTime ?? ""));
      setHistory(rows);
    } catch {
      // keep last
    }
  }, [sym, segment, isStandaloneFuture, isThisGroup]);

  // The chart is the source of truth for the live price - mirror it into
  // `ltp` (used by the header, the target watch and saveAll's checks) so
  // the panel is never a step behind what's on the chart.
  const chartLtpRef = useRef<number | null>(null);
  useEffect(() => {
    chartLtpRef.current = chartLtp;
    if (chartLtp != null) setLtp(chartLtp);
  }, [chartLtp]);

  useEffect(() => {
    let cancelled = false;
    let wasOpen = false;
    void refreshHistory();
    const tick = async () => {
      if (cancelled) return;
      // Prefer the chart's live price; only fetch our own while the chart
      // hasn't produced a tick yet (first second or two after a switch).
      let price: number | null = chartLtpRef.current;
      if (price == null) {
        try {
          price = await fetchUnderlyingLtp(segment, sym);
          if (!cancelled && price != null) setLtp(price);
        } catch {
          // keep last
        }
      }
      const nowOpen = await refreshOpen();
      if (nowOpen !== null) {
        if (wasOpen && !nowOpen) void refreshHistory();
        wasOpen = nowOpen;
      }
      if (!cancelled && nowOpen && price != null && targetPx != null && openAction && !exitFiredRef.current) {
        if (checkExitTrigger({ action: openAction, targetPrice: targetPx }, price) === "target") {
          exitFiredRef.current = true;
          void squareOff();
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, sym, refreshOpen, refreshHistory, targetPx, openAction]);

  // Seed the edit fields once per open position.
  useEffect(() => {
    exitFiredRef.current = false;
    if (!openId) {
      setEdit({ sl: "", target: "", closeBy: "" });
      setTargetPx(null);
      setSlMode("fixed");
      return;
    }
    // SL field: for an option it's the group's spot stop; for a future
    // it's the position's own stop (unless that came from a trailing
    // method - then the trail block below owns it, keep the field blank).
    const seededSl = openGroup
      ? openGroup.spot_stop_loss_price
      : openPos?.stop_loss_method == null
        ? openPos?.stop_loss_price
        : null;
    // Target field: seed from the server-enforced value set at entry
    // (positions.target_price / option_position_groups.spot_target_price),
    // so a risk-managed order shows its real target. For a future, saveAll
    // then also arms the browser watch off it; for a group it's persisted
    // via updateOptionGroupSpotTarget.
    const seededTarget = openGroup ? openGroup.spot_target_price : openPos?.target_price;
    setEdit({
      sl: seededSl != null ? String(seededSl) : "",
      target: seededTarget != null ? String(seededTarget) : "",
      closeBy: hhmm(openGroup?.square_off_time ?? openPos?.square_off_time),
    });
    setSavedAll(false);
    // Prefill the trailing-SL config from an already-attached one, else
    // default the interval to the chart's current display interval.
    if (openPos?.stop_loss_method === "indicator") {
      setSlMode("trail");
      if (openPos.stop_loss_indicator_type) setSlType(openPos.stop_loss_indicator_type);
      if (openPos.stop_loss_indicator_params?.period != null) setSlPeriod(String(openPos.stop_loss_indicator_params.period));
      if (openPos.stop_loss_indicator_params?.multiplier != null)
        setSlMult(String(openPos.stop_loss_indicator_params.multiplier));
      setSlInterval(openPos.stop_loss_interval ?? chartSlInterval());
    } else {
      setSlMode("fixed");
      setSlInterval(chartSlInterval());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // No option chain for this symbol -> a futures position.
  useEffect(() => {
    if (!optionEligible && strategy !== "future") setStrategy("future");
  }, [optionEligible, strategy]);

  // Feed the open trade (with its live P&L, from this panel's own poll) up
  // to the chart so the trade marker doesn't re-poll it.
  useEffect(() => {
    onOpenTradeChange?.({ pos: openPos, group: openGroup });
  }, [openPos, openGroup, onOpenTradeChange]);

  // --- Apply a price picked off the chart to the armed field. For an
  // open position "stop"/"target" fill the manage-bar edit fields; in the
  // entry form they fill the entry inputs. ---
  const pickNonceRef = useRef(0);
  useEffect(() => {
    if (!pickedPrice || pickedPrice.nonce === pickNonceRef.current) return;
    pickNonceRef.current = pickedPrice.nonce;
    const v = String(pickedPrice.price);
    if (hasOpen) {
      if (pickedPrice.field === "stop") setEdit((s) => ({ ...s, sl: v }));
      else if (pickedPrice.field === "target") setEdit((s) => ({ ...s, target: v }));
    } else if (pickedPrice.field === "limit") setLimitInput(v);
    else if (pickedPrice.field === "stop") setSlInput(v);
    else setTargetInput(v);
  }, [pickedPrice, hasOpen]);

  // --- Direction lock (see `forceTrend`) ---
  // "Trend only" means exactly that: a directional trade is allowed ONLY
  // when the chart interval has a CONFIRMED up/down trend and the bias
  // matches it. No confirmed trend at all - ranging, OR structure
  // detection not running so the trend is unknown - blocks both
  // directions, same as ranging (an unknown trend is not a licence to
  // trade either way).
  const trendLock = forceTrend;
  const trendAllows: "BUY" | "SELL" | null =
    !trendLock ? null : intervalTrend === "up" ? "BUY" : intervalTrend === "down" ? "SELL" : null;
  // Lock on but no confirmed direction (ranging or unknown) -> no trade.
  const trendUndirected = trendLock && trendAllows == null;
  const trendUnknown = trendLock && intervalTrend == null;
  const trendBlocked = trendLock && (trendUndirected || action !== trendAllows);

  // Snap the bias to the permitted side when the lock is (or becomes) active.
  useEffect(() => {
    if (trendAllows && action !== trendAllows) setAction(trendAllows);
  }, [trendAllows, action]);

  // Risk-managed = limit orders only (a market order can't be pre-sized
  // against a known entry, and the whole point is a planned entry). Snap
  // to Limit whenever the mode is (or becomes) on.
  useEffect(() => {
    if (riskManaged && entryType !== "limit") setEntryType("limit");
  }, [riskManaged, entryType]);

  // --- Entry / risk inputs ---
  const numOrNull = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : null);
  const effEntryType: "market" | "limit" = riskManaged ? "limit" : entryType;
  const limitPrice = numOrNull(limitInput);
  const stopPrice = numOrNull(slInput);
  const targetPrice = numOrNull(targetInput);
  // The entry price reward:risk (and risk-managed sizing) is measured from
  // - the typed Limit, or (a plain market order) the live price.
  const entryRef = effEntryType === "limit" ? limitPrice : ltp;
  const rr = computeRR({ entry: entryRef, stop: stopPrice, target: targetPrice });
  const dirValid = rrDirectionValid({ action, entry: entryRef, stop: stopPrice, target: targetPrice });
  const minRR = account?.min_reward_risk_ratio ?? null;

  // Risk-managed: Limit + SL + Target all required, RR must clear the
  // segment minimum, and the lot count is sized from the risk budget.
  const riskFieldsComplete = stopPrice != null && targetPrice != null && limitPrice != null;
  const rrClears = rr != null && minRR != null && rr >= minRR;
  const riskGateOk = !riskManaged || (riskFieldsComplete && dirValid && rrClears);

  // Risk-managed lot-count preview (NSE/MCX only - CRYPTO's INR-vs-USD
  // capital conversion is server-side, so the client can't size it). null
  // -> the Lots field shows "auto" and execution sizes it at fill.
  const previewLots =
    riskManaged && segment !== "CRYPTO" && lotSize != null
      ? previewRiskLots({
          capitalPerTrade: account?.capital_per_trade ?? 0,
          riskPerTradePct: account?.risk_per_trade_pct ?? 0,
          entry: limitPrice,
          stop: stopPrice,
          lotSize,
        })
      : null;
  const autoQty = riskManaged && stopPrice != null;

  const qty = qtyInput.trim() ? Number(qtyInput) : undefined;
  const qtyValid = autoQty || (qty != null && Number.isFinite(qty) && qty > 0);
  const limitReady = effEntryType === "market" || limitPrice != null;
  const canProceed =
    !placing && !hasOpen && !pendingOrder && !!sym && qtyValid && limitReady && dirValid && riskGateOk && !trendBlocked;

  // Why Proceed is blocked (first applicable), for the hint under the button.
  const blockReason = !qtyValid
    ? "Enter a valid lot quantity."
    : !limitReady
      ? "Enter a limit price."
      : !dirValid
        ? action === "BUY"
          ? "For a Bullish trade, the target must be above and the stop below your entry."
          : "For a Bearish trade, the target must be below and the stop above your entry."
        : riskManaged && !riskFieldsComplete
          ? "Risk managed: set a limit price, a stop-loss and a target."
          : riskManaged && !rrClears
            ? rr == null
              ? "Risk managed: reward:risk can't be computed yet."
              : `Reward:risk ${rr.toFixed(2)} is below the ${minRR?.toFixed(2)} segment minimum.`
            : trendBlocked
              ? trendUnknown
                ? `No confirmed ${chartInterval} trend (enable Structure on this interval) — "Trend only" allows a trade only with the trend.`
                : trendUndirected
                  ? `${chartInterval} trend is ranging — no directional trade while "Trend only" is on.`
                  : `Locked to ${trendAllows === "BUY" ? "Bullish" : "Bearish"} by the ${chartInterval} trend.`
              : null;

  async function proceed() {
    if (!canProceed) return;
    setPlacing(true);
    setError(null);
    try {
      const trendFollowed = trendLock && trendAllows === action;
      const placeQty = autoQty ? null : (qty ?? null);

      if (effEntryType === "limit") {
        if (limitPrice == null) {
          setError("Enter a limit price.");
          return;
        }
        let startedAbove = true;
        try {
          startedAbove = (await fetchUnderlyingLtp(segment, sym)) >= limitPrice;
        } catch {
          // default true - LiveChartPage's loop corrects it on its first tick
        }
        onArmPending({
          segment,
          symbol: sym,
          action,
          strategy,
          moneyness,
          triggerPrice: limitPrice,
          startedAbove,
          stop: stopPrice,
          target: targetPrice,
          quantity: placeQty,
          trendFollowed,
          riskManaged,
          setupTag: setupTag || null,
          confidence,
          armedAt: Date.now(),
        });
        setLimitInput("");
        setSlInput("");
        setTargetInput("");
        return;
      }

      // Market - fire now. A future needs a concrete entry price (used for
      // sizing); an option group prices its own legs off a live quote
      // server-side, so the chart's own LTP is enough there (and skipping
      // the extra fetch removes a failure point on the option path).
      const price =
        strategy === "future" ? await fetchUnderlyingLtp(segment, sym) : (ltp ?? (await fetchUnderlyingLtp(segment, sym)));
      const result = await placeManualOrder({
        segment,
        symbol: sym,
        action,
        strategy,
        moneyness,
        orderType: "market",
        entryPrice: price,
        quantity: placeQty,
        stop: stopPrice,
        target: targetPrice,
        trendFollowed,
        riskManaged,
        setupTag: setupTag || null,
        confidence,
      });
      if (result.rejected) {
        setError(result.reason ?? "order rejected");
        return;
      }
      if (result.position) setOpenPos(result.position);
      if (result.group) setOpenGroup(result.group);
      if (result.warning) setError(result.warning);
      setSlInput("");
      setTargetInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to place order");
    } finally {
      setPlacing(false);
    }
  }

  // Build the ManualStopLossConfig for a Trail-mode save. null if the
  // inputs aren't usable yet.
  function trailConfig(): ManualStopLossConfig | null {
    const period = Number(slPeriod);
    if (!Number.isFinite(period) || period <= 0) return null;
    const params =
      slType === "supertrend"
        ? { period, multiplier: Number.isFinite(Number(slMult)) && Number(slMult) > 0 ? Number(slMult) : 3 }
        : { period };
    return {
      stop_loss_method: "indicator",
      trailing_stop_enabled: true,
      stop_loss_interval: slInterval,
      stop_loss_indicator_type: slType,
      stop_loss_indicator_params: params,
    };
  }

  // One button - commit SL / trailing SL / close-by (backend) and arm the
  // target watch (local), whatever's set.
  async function saveAll() {
    if (!openId) return;
    // Validate the target watch up front - it's a spot-price level, and
    // if it's already on the exit side of the current price it would fire
    // the instant it's armed (this is what "square-off: group is CLOSED"
    // came from). Bail before touching the backend.
    const rawT = edit.target.trim() ? Number(edit.target) : null;
    const tValid = rawT != null && Number.isFinite(rawT) && rawT > 0;
    if (tValid && ltp != null && openAction) {
      const alreadyPast = openAction === "BUY" ? ltp >= rawT : ltp <= rawT;
      if (alreadyPast) {
        setError(
          `Target ${fmt(rawT)} is already past the spot price (${fmt(ltp)}) — set it ${openAction === "BUY" ? "above" : "below"} spot.`,
        );
        return;
      }
    }
    setSavingAll(true);
    setSavedAll(false);
    setError(null);
    try {
      // Stop-loss.
      if (openGroup) {
        const px = Number(edit.sl);
        if (edit.sl.trim() && Number.isFinite(px)) await updateOptionGroupSpotStopLoss(openGroup.id, px);
      } else if (openPos) {
        if (slMode === "trail") {
          const cfg = trailConfig();
          if (!cfg) {
            setError("enter a valid trailing-SL period");
            return;
          }
          await updateStopLoss(openPos.id, cfg);
        } else {
          const px = Number(edit.sl);
          if (edit.sl.trim() && Number.isFinite(px)) await updateStopLoss(openPos.id, { stop_loss_price: px });
        }
      }
      // Close-by time (null clears it).
      const closeVal = edit.closeBy.trim() ? `${edit.closeBy}:00` : null;
      if (openGroup) await updateOptionGroupSquareOffTime(openGroup.id, closeVal);
      else if (openPos) await updatePositionSquareOffTime(openPos.id, closeVal);
      // Target - an option group persists it server-side (spot_target_price,
      // exit-monitor enforced); a future has no target-update route, so it
      // stays a browser-side watch. Either way, drop the local watch for a
      // group so it isn't double-armed.
      if (openGroup && tValid) {
        await updateOptionGroupSpotTarget(openGroup.id, rawT);
        setTargetPx(null);
      } else {
        setTargetPx(tValid ? rawT : null);
      }
      exitFiredRef.current = false;

      setSavedAll(true);
      window.setTimeout(() => setSavedAll(false), 1600);
      void refreshOpen();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save changes");
    } finally {
      setSavingAll(false);
    }
  }

  async function squareOff() {
    if (squaringOffRef.current) return;
    squaringOffRef.current = true;
    setSquaringOff(true);
    setError(null);
    let closed = false;
    try {
      if (openGroup) await squareOffOptionGroup(openGroup.id);
      else if (openPos) await squareOffManualPosition(openPos.id);
      closed = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed to square off";
      // Already gone (backend SL/target/square-off beat us, or a double
      // fire) - reconcile silently. A quote-unavailable 502 means it's
      // still OPEN - show the error and DON'T clear the panel.
      if (/not OPEN|is CLOSED/i.test(msg)) closed = true;
      else setError(msg);
    } finally {
      if (closed) {
        setOpenGroup(null);
        setOpenPos(null);
        setTargetPx(null);
      }
      await refreshHistory();
      void refreshOpen();
      squaringOffRef.current = false;
      setSquaringOff(false);
    }
  }

  async function saveNote() {
    if (!noteEdit || noteBusy) return;
    const row = history.find((h) => h.id === noteEdit.id);
    if (!row) {
      setNoteEdit(null);
      return;
    }
    const text = noteEdit.text.trim().slice(0, 2000);
    const tag = noteEdit.tag;
    const conf = noteEdit.confidence;
    const noteChanged = text !== row.notes;
    const tagsChanged = tag !== row.setupTag || conf !== row.confidence;
    if (!noteChanged && !tagsChanged) {
      setNoteEdit(null);
      return;
    }
    setNoteBusy(true);
    setError(null);
    try {
      if (noteChanged) {
        if (row.kind === "option") await updateOptionGroupNotes(row.id, text);
        else await updatePositionNotes(row.id, text);
      }
      if (tagsChanged) {
        const patch: { setup_tag?: string; confidence?: number } = {};
        if (tag !== row.setupTag) patch.setup_tag = tag; // "" clears
        if (conf !== row.confidence && conf != null) patch.confidence = conf;
        if (Object.keys(patch).length) {
          if (row.kind === "option") await updateOptionGroupTags(row.id, patch);
          else await updatePositionTags(row.id, patch);
        }
      }
      setHistory((prev) =>
        prev.map((h) => (h.id === row.id ? { ...h, notes: text, setupTag: tag, confidence: conf } : h)),
      );
      setNoteEdit(null);
      // Back to collapsed once saved - keeps the list tidy.
      setNoteOpen((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save note");
    } finally {
      setNoteBusy(false);
    }
  }

  // --- Derived display values ---
  const realized = history.reduce((s, h) => s + (h.pnl ?? 0), 0);
  const unrealized = openGroup?.unrealized_pnl ?? openPos?.unrealized_pnl ?? null;
  const openQty = openGroup?.quantity ?? openPos?.quantity ?? null;
  const openLabel = openGroup
    ? optionLabel(openGroup.action, openGroup.strategy_type.startsWith("naked") ? "naked" : "spread")
    : openPos
      ? `${openPos.action === "BUY" ? "Long" : "Short"} ${openPos.instrument_type}`
      : "";
  const tintAction = openAction ?? action;
  const rows = legRows(openPos, openGroup, sym);

  return (
    <div className={`chart-trade-panel ${tintAction === "BUY" ? "ctp-bull" : "ctp-bear"}`}>
      <div className="ctp-head">
        <span className="ctp-sym">
          {sym}
          <span className="ctp-ltp" title="Live underlying price">
            {ltp != null ? ltp.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
          </span>
        </span>
        <span className="ctp-pnl-head" title={`Today's realized / unrealized P&L on ${sym} · ${unit}`}>
          <b className={pnlClass(realized)}>{fmt(realized)}</b>
          {" / "}
          <b className={pnlClass(unrealized)}>{fmt(unrealized)}</b>
        </span>
      </div>

      {pendingOrder && (
        <div className="ctp-pending">
          <div className="ctp-pending-head">
            <span className="ctp-pending-dot">⏳</span>
            <b>Limit armed</b>
          </div>
          <p className="ctp-pending-body">
            {pendingOrder.action === "BUY" ? "Bullish" : "Bearish"}{" "}
            {pendingOrder.strategy === "future" ? "future" : pendingOrder.strategy}
            {" · waiting for price to "}
            {pendingOrder.startedAbove ? "fall to" : "rise to"} <b>{fmt(pendingOrder.triggerPrice)}</b>
            {pendingOrder.stop != null && ` · SL ${fmt(pendingOrder.stop)}`}
            {pendingOrder.target != null && ` · T ${fmt(pendingOrder.target)}`}
          </p>
          <button type="button" className="ctp-squareoff" onClick={() => onCancelPending(sym)}>
            Cancel
          </button>
        </div>
      )}
      {pendingNote && !pendingOrder && <p className="ctp-error">{pendingNote}</p>}

      {!hasOpen && !pendingOrder && (
        <>
          <div className="ctp-seg" role="group" aria-label="Direction">
            <button
              type="button"
              className={action === "BUY" ? "active buy" : ""}
              disabled={trendLock && trendAllows !== "BUY"}
              onClick={() => setAction("BUY")}
            >
              Bullish
            </button>
            <button
              type="button"
              className={action === "SELL" ? "active sell" : ""}
              disabled={trendLock && trendAllows !== "SELL"}
              onClick={() => setAction("SELL")}
            >
              Bearish
            </button>
          </div>

          <div className="ctp-row">
            <label className="ctp-field ctp-field-grow">
              <span>Strategy</span>
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as PanelStrategy)}>
                <option value="future">{action === "BUY" ? "Future · long" : "Future · short"}</option>
                <option value="naked" disabled={!optionEligible}>
                  {action === "BUY" ? "Naked Call" : "Naked Put"}
                </option>
                <option value="spread" disabled={!optionEligible}>
                  {action === "BUY" ? "Bull Call Spread" : "Bear Put Spread"}
                </option>
              </select>
            </label>
            {isOption && (
              <label className="ctp-field">
                <span>Strike</span>
                <select value={moneyness} onChange={(e) => setMoneyness(e.target.value as OptionStrikeMoneyness)}>
                  {MONEYNESS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="ctp-seg ctp-seg-sm" role="group" aria-label="Entry type">
            <button
              type="button"
              className={effEntryType === "market" ? "active" : ""}
              disabled={riskManaged}
              title={riskManaged ? "Risk managed uses limit orders only" : undefined}
              onClick={() => setEntryType("market")}
            >
              Market
            </button>
            <button
              type="button"
              className={effEntryType === "limit" ? "active" : ""}
              onClick={() => setEntryType("limit")}
            >
              Limit
            </button>
          </div>

          <div className="ctp-row">
            {effEntryType === "limit" && (
              <label className="ctp-field">
                <span>Limit</span>
                <span className="ctp-input-pick">
                  <input
                    inputMode="decimal"
                    value={limitInput}
                    onChange={(e) => setLimitInput(e.target.value)}
                    placeholder="entry price"
                  />
                  <PickBtn armed={pickField === "limit"} onToggle={() => onPickField(pickField === "limit" ? null : "limit")} />
                </span>
              </label>
            )}
            <label className="ctp-field">
              <span>Lots</span>
              <input
                inputMode="numeric"
                value={autoQty ? (previewLots != null ? String(previewLots) : "") : qtyInput}
                onChange={(e) => setQtyInput(e.target.value)}
                placeholder={autoQty ? "auto" : "1"}
                disabled={autoQty}
                title={
                  autoQty
                    ? previewLots != null
                      ? `Sized from your risk budget: ${riskManaged && account ? fmt((account.capital_per_trade * account.risk_per_trade_pct) / 100) : "risk"} ÷ (limit − stop-loss). Execution confirms the exact count at fill.`
                      : "Sized from your risk budget at fill (execution.compute_risk_based_quantity)"
                    : undefined
                }
              />
            </label>
          </div>

          <div className="ctp-row">
            <label className="ctp-field">
              <span>Stop-loss</span>
              <span className="ctp-input-pick">
                <input
                  inputMode="decimal"
                  value={slInput}
                  onChange={(e) => setSlInput(e.target.value)}
                  placeholder={riskManaged ? "required" : "optional"}
                />
                <PickBtn armed={pickField === "stop"} onToggle={() => onPickField(pickField === "stop" ? null : "stop")} />
              </span>
            </label>
            <label className="ctp-field">
              <span>Target</span>
              <span className="ctp-input-pick">
                <input
                  inputMode="decimal"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  placeholder={riskManaged ? "required" : "optional"}
                />
                <PickBtn armed={pickField === "target"} onToggle={() => onPickField(pickField === "target" ? null : "target")} />
              </span>
            </label>
          </div>

          {(stopPrice != null || targetPrice != null || riskManaged) && (
            <div className={`ctp-rr ${riskManaged ? (rrClears ? "ok" : "bad") : ""}`}>
              <span>R:R {rr != null ? rr.toFixed(2) : "—"}</span>
              {minRR != null && <span className="muted">min {minRR.toFixed(2)}</span>}
            </div>
          )}

          <div className="ctp-row ctp-journal-row">
            <label className="ctp-field ctp-field-grow">
              <span>Setup</span>
              <select value={setupTag} onChange={(e) => setSetupTag(e.target.value)}>
                <option value="">— reason —</option>
                {SETUP_TAGS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="ctp-field">
              <span>Confidence</span>
              <span className="ctp-conf">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={confidence === n ? "active" : ""}
                    onClick={() => setConfidence(confidence === n ? null : n)}
                    title={`${n} / 5`}
                  >
                    {n}
                  </button>
                ))}
              </span>
            </label>
          </div>

          <button type="button" className="ctp-proceed" disabled={!canProceed} onClick={() => void proceed()}>
            {placing ? (effEntryType === "limit" ? "Arming…" : "Placing…") : effEntryType === "limit" ? "Arm limit" : "Proceed"}
          </button>
          {blockReason && !placing && <p className="ctp-hint">{blockReason}</p>}
        </>
      )}

      {hasOpen && (
        <div className="ctp-open">
          <div className="ctp-open-head">
            <b>{openLabel}</b>
            <span className="muted">{fmtQty(openQty)} lots</span>
          </div>

          <div className="ctp-legs">
            <span className="ctp-legs-h">Time</span>
            <span className="ctp-legs-h">Entry</span>
            <span className="ctp-legs-h">Qty</span>
            <span className="ctp-legs-h">LTP</span>
            <span className="ctp-legs-h">P&amp;L</span>
            {rows.map((r, i) => (
              <Fragment key={r.key}>
                <span className="ctp-legs-leg" title={r.contractFull}>
                  {r.contract} <em>(L{i + 1})</em>
                </span>
                <span>{r.time}</span>
                <span>{fmt(r.entry)}</span>
                <span>{fmtQty(r.qty)}</span>
                <span>{fmt(r.ltp)}</span>
                <span className={pnlClass(r.pnl)}>{fmt(r.pnl)}</span>
              </Fragment>
            ))}
          </div>

          <div className="ctp-manage">
            <div className="ctp-manage-bar">
              {openPos && (
                <label className="ctp-trail-toggle">
                  <input
                    type="checkbox"
                    checked={slMode === "trail"}
                    onChange={(e) => setSlMode(e.target.checked ? "trail" : "fixed")}
                  />
                  Trail SL
                </label>
              )}

              {openPos && slMode === "trail" ? (
                <>
                  <label className="ctp-mf">
                    <span>Interval</span>
                    <select value={slInterval} onChange={(e) => setSlInterval(e.target.value as StopLossInterval)}>
                      {SL_INTERVALS.map((iv) => (
                        <option key={iv} value={iv}>
                          {iv.replace("min", "m")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ctp-mf">
                    <span>Indicator</span>
                    <select value={slType} onChange={(e) => setSlType(e.target.value as StopLossIndicatorType)}>
                      <option value="ema">EMA</option>
                      <option value="supertrend">SuperTrend</option>
                    </select>
                  </label>
                  <label className="ctp-mf">
                    <span>{slType === "supertrend" ? "Period · Mult" : "Period"}</span>
                    <span className="ctp-mf-row">
                      <input
                        className="ctp-num"
                        inputMode="numeric"
                        value={slPeriod}
                        title="period"
                        onChange={(e) => setSlPeriod(e.target.value)}
                      />
                      {slType === "supertrend" && (
                        <input
                          className="ctp-num"
                          inputMode="decimal"
                          value={slMult}
                          title="multiplier"
                          onChange={(e) => setSlMult(e.target.value)}
                        />
                      )}
                    </span>
                  </label>
                </>
              ) : (
                <label className="ctp-mf">
                  <span>Spot SL</span>
                  <span className="ctp-input-pick">
                    <input
                      inputMode="decimal"
                      value={edit.sl}
                      placeholder="price"
                      onChange={(e) => setEdit((s) => ({ ...s, sl: e.target.value }))}
                    />
                    <PickBtn armed={pickField === "stop"} onToggle={() => onPickField(pickField === "stop" ? null : "stop")} />
                  </span>
                </label>
              )}

              <label
                className="ctp-mf"
                title="A watch on the underlying SPOT price - squares this position off when spot reaches the level (set it above spot for a long/call, below for a short/put)."
              >
                <span>
                  {openGroup ? "Spot target" : "Target"}
                  {targetPx != null ? " ●" : ""}
                </span>
                <span className="ctp-input-pick">
                  <input
                    inputMode="decimal"
                    value={edit.target}
                    placeholder="spot price"
                    onChange={(e) => setEdit((s) => ({ ...s, target: e.target.value }))}
                  />
                  <PickBtn armed={pickField === "target"} onToggle={() => onPickField(pickField === "target" ? null : "target")} />
                </span>
              </label>

              <label className="ctp-mf">
                <span>Close by</span>
                <input
                  type="time"
                  value={edit.closeBy}
                  onChange={(e) => setEdit((s) => ({ ...s, closeBy: e.target.value }))}
                />
              </label>
            </div>

            <div className="ctp-manage-actions">
              <span className="ctp-manage-actions-spacer" />
              <button type="button" className="ctp-save-all" disabled={savingAll} onClick={() => void saveAll()}>
                {savedAll ? "✓ Saved" : savingAll ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ctp-squareoff" disabled={squaringOff} onClick={() => void squareOff()}>
                {squaringOff ? "…" : "Square off"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="ctp-error">{error}</p>}

      <div className="ctp-history">
        <div className="ctp-history-head">
          <span>History</span>
          <span className="muted">{history.length} trade{history.length === 1 ? "" : "s"}</span>
        </div>
        {history.length === 0 && <p className="muted">No closed trades today.</p>}
        {history.slice(0, 6).map((h) => (
          <div key={h.id} className="ctp-history-row">
            <div className="ctp-history-line1">
              <span className="ctp-history-label">
                {h.label}
                {h.trendFollowed && (
                  <span className="ctp-tag ctp-tag-tr" title="Placed under the Trend-only lock">
                    TR
                  </span>
                )}
                {h.riskManaged && (
                  <span className="ctp-tag ctp-tag-rm" title="Placed in Risk-managed mode (R:R cleared the segment minimum)">
                    RM
                  </span>
                )}
                {h.setupTag && (
                  <span className="ctp-tag ctp-tag-setup" title="Setup tag">
                    {h.setupTag}
                  </span>
                )}
                {h.confidence != null && (
                  <span className="ctp-tag ctp-tag-conf" title={`Confidence ${h.confidence}/5`}>
                    {"●".repeat(h.confidence)}
                    {"○".repeat(5 - h.confidence)}
                  </span>
                )}
              </span>
              <span className={pnlClass(h.pnl)}>
                {h.pnl != null && h.pnl >= 0 ? "+" : ""}
                {fmt(h.pnl)}
                {h.pnlPct != null && ` (${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(1)}%)`}
              </span>
            </div>
            <div className="ctp-history-line2 muted">
              {h.qty != null && `${fmtQty(h.qty)}× `}
              {h.entry != null && fmt(h.entry)}
              {h.exit != null && ` → ${fmt(h.exit)}`}
              {h.exitReason && ` · ${h.exitReason}`}
              {h.exitTime && ` · ${formatCompact(h.exitTime).split("  ")[1] ?? formatCompact(h.exitTime)}`}
            </div>
            {noteEdit?.id === h.id ? (
              <div className="ctp-note-edit">
                <div className="ctp-row ctp-journal-row">
                  <label className="ctp-field ctp-field-grow">
                    <span>Setup</span>
                    <select
                      value={noteEdit.tag}
                      onChange={(e) => setNoteEdit((s) => (s ? { ...s, tag: e.target.value } : s))}
                    >
                      <option value="">— reason —</option>
                      {SETUP_TAGS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ctp-field">
                    <span>Confidence</span>
                    <span className="ctp-conf">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          type="button"
                          key={n}
                          className={noteEdit.confidence === n ? "active" : ""}
                          onClick={() =>
                            setNoteEdit((s) => (s ? { ...s, confidence: s.confidence === n ? null : n } : s))
                          }
                        >
                          {n}
                        </button>
                      ))}
                    </span>
                  </label>
                </div>
                <textarea
                  className="ctp-note-input"
                  rows={2}
                  maxLength={2000}
                  placeholder="Why this trade? What worked / what to fix?"
                  value={noteEdit.text}
                  onChange={(e) => setNoteEdit((s) => (s ? { ...s, text: e.target.value } : s))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setNoteEdit(null);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveNote();
                  }}
                />
                <div className="ctp-note-actions">
                  <button type="button" className="ctp-note-save" disabled={noteBusy} onClick={() => void saveNote()}>
                    {noteBusy ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="ctp-note-cancel" disabled={noteBusy} onClick={() => setNoteEdit(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : h.notes || h.setupTag || h.confidence != null ? (
              <>
                <button
                  type="button"
                  className={`ctp-note-toggle${noteOpen.has(h.id) ? " open" : ""}`}
                  onClick={() => toggleNote(h.id)}
                  title={noteOpen.has(h.id) ? "Hide journal" : "Show journal"}
                >
                  {noteOpen.has(h.id) ? "▾" : "▸"} journal
                </button>
                {noteOpen.has(h.id) && (
                  <div
                    className="ctp-note"
                    role="button"
                    tabIndex={0}
                    title="Click to edit"
                    onClick={() => setNoteEdit({ id: h.id, text: h.notes, tag: h.setupTag, confidence: h.confidence })}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      setNoteEdit({ id: h.id, text: h.notes, tag: h.setupTag, confidence: h.confidence })
                    }
                  >
                    {h.notes || <span className="muted">no note — click to add</span>}
                  </div>
                )}
              </>
            ) : (
              <button
                type="button"
                className="ctp-note-add"
                onClick={() => setNoteEdit({ id: h.id, text: "", tag: "", confidence: null })}
              >
                + journal
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

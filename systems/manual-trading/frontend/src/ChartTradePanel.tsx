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
  createManualOptionGroup,
  createManualPosition,
  fetchAccounts,
  fetchExecPositions,
  fetchOptionGroups,
  squareOffManualPosition,
  squareOffOptionGroup,
  updateOptionGroupSpotStopLoss,
  updateOptionGroupSquareOffTime,
  updatePositionSquareOffTime,
  updateStopLoss,
} from "./api";
import {
  CRYPTO_OPTION_SYMBOLS,
  checkExitTrigger,
  dayKey,
  fetchUnderlyingLtp,
  fmt,
  fmtQty,
  formatCompact,
  pnlClass,
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
  label: string;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  pnl: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  exitTime: string | null;
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

function pnlPct(pnl: number | null, entry: number | null, qty: number | null): number | null {
  if (pnl == null || entry == null || qty == null) return null;
  const base = Math.abs(entry * qty);
  return base === 0 ? null : (pnl / base) * 100;
}

function positionToClosed(p: ManualPosition): ClosedTrade {
  return {
    id: p.id,
    label: `${p.action} ${p.instrument_type}`,
    entry: p.entry_price,
    exit: p.exit_price,
    qty: p.quantity,
    pnl: p.pnl,
    pnlPct: pnlPct(p.pnl, p.entry_price, p.quantity),
    exitReason: p.exit_reason,
    exitTime: p.exit_time,
  };
}

function groupToClosed(g: ManualOptionGroup): ClosedTrade {
  return {
    id: g.id,
    label: optionLabel(g.action, g.strategy_type.startsWith("naked") ? "naked" : "spread"),
    entry: g.net_debit,
    exit: null,
    qty: g.quantity,
    pnl: g.pnl,
    pnlPct: pnlPct(g.pnl, g.net_debit, g.quantity),
    exitReason: g.exit_reason,
    exitTime: g.exit_time,
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
  intervalTrend,
  chartInterval,
  forceTrend,
}: {
  segment: Segment;
  symbol: string;
  // Confirmed structure trend for the chart's current interval (null when
  // structure detection isn't running on that timeframe), + the interval
  // itself for the label. Lifted from LiveChartPanel by LiveChartPage.
  intervalTrend: "up" | "down" | "range" | null;
  chartInterval: string;
  // The "trade with the interval trend only" lock - its checkbox lives up
  // in LiveChartPage (aligned with the chart's interval strip), not here.
  forceTrend: boolean;
}) {
  const sym = symbol.trim().toUpperCase();
  const optionEligible = segment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(sym);
  const unit = segment === "CRYPTO" ? "USD" : "INR";

  const [ltp, setLtp] = useState<number | null>(null);
  const [account, setAccount] = useState<Account | null>(null);

  // --- Entry form ---
  const [action, setAction] = useState<"BUY" | "SELL">("BUY");
  const [strategy, setStrategy] = useState<"future" | "naked" | "spread">("naked");
  const isOption = strategy !== "future";
  const [moneyness, setMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [qtyInput, setQtyInput] = useState("1");
  const [slInput, setSlInput] = useState("");
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

  // --- Account (risk-per-trade readout) ---
  useEffect(() => {
    let cancelled = false;
    fetchAccounts()
      .then((accts) => {
        if (!cancelled) setAccount(accts.find((a) => a.segment === segment) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [segment]);

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

  useEffect(() => {
    let cancelled = false;
    let wasOpen = false;
    void refreshHistory();
    const tick = async () => {
      if (cancelled) return;
      let price: number | null = null;
      try {
        price = await fetchUnderlyingLtp(segment, sym);
        if (!cancelled) setLtp(price);
      } catch {
        // keep last
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
    setEdit({
      sl: seededSl != null ? String(seededSl) : "",
      target: "",
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

  // --- Direction lock (see `forceTrend`) ---
  // Only enforce when the lock is on AND we actually know the trend.
  const trendLock = forceTrend && intervalTrend != null;
  const trendAllows: "BUY" | "SELL" | null =
    !trendLock ? null : intervalTrend === "up" ? "BUY" : intervalTrend === "down" ? "SELL" : null;
  // Lock on + trend known + it's ranging -> no directional trade at all.
  const trendRanging = trendLock && trendAllows == null;
  const trendBlocked = trendLock && (trendRanging || action !== trendAllows);

  // Snap the bias to the permitted side when the lock is (or becomes) active.
  useEffect(() => {
    if (trendAllows && action !== trendAllows) setAction(trendAllows);
  }, [trendAllows, action]);

  const qty = qtyInput.trim() ? Number(qtyInput) : undefined;
  const qtyValid = qty != null && Number.isFinite(qty) && qty > 0;
  const canProceed = !placing && !hasOpen && !!sym && qtyValid && !trendBlocked;

  async function proceed() {
    if (!canProceed) return;
    setPlacing(true);
    setError(null);
    try {
      if (isOption) {
        const created = await createManualOptionGroup({
          segment,
          symbol: sym,
          action,
          option_position_style: strategy === "spread" ? "spread" : "naked",
          option_strike_moneyness: moneyness,
          option_fixed_lots: qty,
          plan_checklist: [],
          order_type: "market",
        });
        if (created.status === "REJECTED") {
          setError(created.rejection_reason ?? "order rejected");
          return;
        }
        setOpenGroup(created);
        if (slInput.trim() && Number.isFinite(Number(slInput))) {
          try {
            await updateOptionGroupSpotStopLoss(created.id, Number(slInput));
          } catch {
            setError("opened — but the stop-loss didn't save, set it below");
          }
        }
      } else {
        const price = await fetchUnderlyingLtp(segment, sym);
        const created = await createManualPosition({
          segment,
          symbol: sym,
          action,
          instrument_type: "future",
          price,
          quantity: qty,
          plan_checklist: [],
          order_type: "market",
          ...(slInput.trim() && Number.isFinite(Number(slInput)) ? { stop_loss_price: Number(slInput) } : {}),
        });
        if (created.status === "REJECTED") {
          setError(created.rejection_reason ?? "order rejected");
          return;
        }
        setOpenPos(created);
      }
      setSlInput("");
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
      // Target - a local watch, no backend call.
      setTargetPx(tValid ? rawT : null);
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
    try {
      if (openGroup) await squareOffOptionGroup(openGroup.id);
      else if (openPos) await squareOffManualPosition(openPos.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed to square off";
      // Already gone (backend SL/target/square-off beat us, or a double
      // fire) - reconcile silently rather than showing an error.
      if (!/not OPEN|is CLOSED/i.test(msg)) setError(msg);
    } finally {
      setOpenGroup(null);
      setOpenPos(null);
      setTargetPx(null);
      await refreshHistory();
      squaringOffRef.current = false;
      setSquaringOff(false);
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

  // Max loss budgeted per trade, from the segment account.
  const riskAmount = account ? (account.capital_per_trade * account.risk_per_trade_pct) / 100 : null;

  return (
    <div className={`chart-trade-panel ${tintAction === "BUY" ? "ctp-bull" : "ctp-bear"}`}>
      <div className="ctp-head">
        <span className="ctp-title">Trade</span>
        <span className="ctp-ltp" title="Live underlying price">
          {ltp != null ? ltp.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
        </span>
      </div>
      <div className="ctp-topline">
        <span title="Max loss budgeted per trade (segment account)">
          Risk/Trade{" "}
          <b>
            {riskAmount != null ? fmt(riskAmount) : "—"}
            {account ? ` · ${account.risk_per_trade_pct}%` : ""}
          </b>
        </span>
        <span title={`Today's realized / unrealized P&L on ${sym} · ${unit}`}>
          <b className={pnlClass(realized)}>{fmt(realized)}</b> /{" "}
          <b className={pnlClass(unrealized)}>{fmt(unrealized)}</b>
        </span>
      </div>

      {!hasOpen && (
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
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
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

          <div className="ctp-row">
            <label className="ctp-field">
              <span>Lots</span>
              <input inputMode="numeric" value={qtyInput} onChange={(e) => setQtyInput(e.target.value)} placeholder="1" />
            </label>
            <label className="ctp-field">
              <span>SL</span>
              <input inputMode="decimal" value={slInput} onChange={(e) => setSlInput(e.target.value)} placeholder="optional" />
            </label>
          </div>

          <button type="button" className="ctp-proceed" disabled={!canProceed} onClick={() => void proceed()}>
            {placing ? "Placing…" : "Proceed"}
          </button>
          {!qtyValid && !placing && <p className="ctp-hint">Enter a valid lot quantity.</p>}
          {qtyValid && trendBlocked && !placing && (
            <p className="ctp-hint">
              {trendRanging
                ? `${chartInterval} trend is ranging — no directional trade while the lock is on.`
                : `Locked to ${trendAllows === "BUY" ? "Bullish" : "Bearish"} by the ${chartInterval} trend.`}
            </p>
          )}
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
                  <input
                    inputMode="decimal"
                    value={edit.sl}
                    placeholder="price"
                    onChange={(e) => setEdit((s) => ({ ...s, sl: e.target.value }))}
                  />
                </label>
              )}

              <label
                className="ctp-mf"
                title="A browser-side watch on the underlying SPOT price - squares this position off when spot reaches the level (set it above spot for a long/call, below for a short/put)."
              >
                <span>
                  {openGroup ? "Spot target" : "Target"}
                  {targetPx != null ? " ●" : ""}
                </span>
                <input
                  inputMode="decimal"
                  value={edit.target}
                  placeholder="spot price"
                  onChange={(e) => setEdit((s) => ({ ...s, target: e.target.value }))}
                />
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
              <span className="ctp-history-label">{h.label}</span>
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
          </div>
        ))}
      </div>
    </div>
  );
}

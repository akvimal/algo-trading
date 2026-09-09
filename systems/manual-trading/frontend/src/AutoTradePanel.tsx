import { useEffect, useRef, useState } from "react";

import {
  type Account,
  type ChartInterval,
  type ManualPosition,
  type ResolvedUnderlying,
  type Segment,
  fetchCandleHistory,
  fetchExecPositions,
} from "./api";
import {
  type AutoTradeConfig,
  intervalMinutes,
  loadAutoTradeState,
  lookbackDaysFor,
  saveAutoTradeState,
  symbolKey,
} from "./autoTrade";
import { fetchUnderlyingLtp, fmt, placeManualOrder, resolveUnderlyingCached } from "./manualOrder";
import { computeSupertrend, detectSupertrendFlips, type SupertrendFlip } from "./supertrend";

// The Intraday auto-trader panel + its watcher loop. Sits above
// ChartTradePanel in LiveChartPage's .chart-trade-col. See autoTrade.ts
// for the config/state model and docs/architecture.md § "Live chart -
// Intraday auto-trader" for the full design.
//
// Watcher: every POLL_MS, fetch completed `interval` bars for the chart's
// symbol, run the shared SuperTrend (supertrend.ts - literally the same
// function the chart draws), and on a NEW flip (one past the seeded
// `lastActedBarTs`) place a MARKET future order in the flip's direction
// with a server-trailed SuperTrend stop. Stop-and-reverse comes for free:
// execution's manual-future path always runs counter_signal_policy=
// 'close_and_flip', so an opposite open position is closed atomically
// when the new order lands.
//
// This component is rendered by LiveChartPage, which does NOT remount on a
// symbol-tab switch - but auto-trade is deliberately disarmed on a switch
// (LiveChartPage.pick), so "one armed symbol at a time" holds and there's
// no orphaned-watcher problem. An already-open position keeps its
// server-side trailing stop regardless.

const POLL_MS = 15_000;
// Ignore a bar until this long past its scheduled close - the provider
// can still be finalising the most recent candle's OHLC (same reason
// signal-engine's engine.py waits breakout_ltf_settle_seconds; a touch
// more here since we read market-data's cache, not Dhan directly).
const SETTLE_BUFFER_MS = 10_000;

const INTERVAL_OPTIONS: ChartInterval[] = ["1min", "3min", "5min", "15min", "30min", "60min"];

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Bar = { timestamp: number; open: number; high: number; low: number; close: number };

type Phase = "idle" | "seeding" | "watching" | "firing" | "error" | "halted";

type WatchStatus = {
  phase: Phase;
  message: string;
  dir: "up" | "down" | null;
  line: number | null;
};

async function todayRealizedManualPnl(segment: Segment): Promise<number> {
  try {
    const closed = await fetchExecPositions({ segment, status: "CLOSED", manualOnly: true, limit: 100 });
    const today = ymdLocal(new Date());
    return closed
      .filter((p) => p.exit_time != null && ymdLocal(new Date(p.exit_time)) === today)
      .reduce((s, p) => s + (p.pnl ?? 0), 0);
  } catch {
    return 0;
  }
}

export default function AutoTradePanel({
  on,
  onToggle,
  config,
  onConfigChange,
  segment,
  symbol,
  account,
}: {
  on: boolean;
  onToggle: () => void;
  config: AutoTradeConfig;
  onConfigChange: (c: AutoTradeConfig) => void;
  segment: Segment;
  symbol: string;
  account: Account | null;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WatchStatus | null>(null);

  // Draft config strings so a half-typed number doesn't fight the parse.
  const [draft, setDraft] = useState(() => ({
    period: String(config.period),
    multiplier: String(config.multiplier),
    lots: String(config.lots),
  }));
  useEffect(() => {
    setDraft({ period: String(config.period), multiplier: String(config.multiplier), lots: String(config.lots) });
  }, [config.period, config.multiplier, config.lots]);

  function commitDraft() {
    const period = Math.round(Number(draft.period));
    const multiplier = Number(draft.multiplier);
    const lots = Math.round(Number(draft.lots));
    onConfigChange({
      ...config,
      period: Number.isFinite(period) && period >= 2 && period <= 100 ? period : config.period,
      multiplier: Number.isFinite(multiplier) && multiplier >= 0.5 && multiplier <= 20 ? multiplier : config.multiplier,
      lots: Number.isFinite(lots) && lots >= 1 && lots <= 100000 ? lots : config.lots,
    });
  }

  // --- The watcher loop (only while armed). ---
  const firingRef = useRef(false);
  useEffect(() => {
    if (!on) {
      setStatus(null);
      return;
    }
    const key = symbolKey(segment, symbol);
    const iv = config.interval;
    const ivMs = intervalMinutes(iv) * 60_000;
    const sym = symbol.trim().toUpperCase();
    let cancelled = false;

    async function completedBars(): Promise<Bar[] | null> {
      let resolved: ResolvedUnderlying;
      try {
        resolved = await resolveUnderlyingCached(segment, sym);
      } catch {
        return null;
      }
      const to = new Date();
      const from = new Date(to.getTime() - lookbackDaysFor(iv) * 86_400_000);
      let candles: Awaited<ReturnType<typeof fetchCandleHistory>>;
      try {
        candles = await fetchCandleHistory(resolved.chart_exchange, resolved.chart_symbol, iv, ymdLocal(from), ymdLocal(to));
      } catch {
        return null;
      }
      const now = Date.now();
      return candles
        .map((c) => ({
          timestamp: Date.parse(c.timestamp),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        .filter((b) => Number.isFinite(b.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((b) => now - b.timestamp >= ivMs + SETTLE_BUFFER_MS);
    }

    async function executeFlip(flip: SupertrendFlip): Promise<{ rejected: boolean; skipped: boolean; reason: string | null }> {
      const desired: "BUY" | "SELL" = flip.direction === "up" ? "BUY" : "SELL";
      let positions: ManualPosition[] = [];
      try {
        positions = await fetchExecPositions({ segment, status: "OPEN", manualOnly: true });
      } catch {
        positions = [];
      }
      // A manual future persists its resolved contract symbol (not the
      // bare underlying) - prefix-match, and exclude option legs.
      const mine = positions.filter(
        (p) => p.option_group_id == null && p.symbol.toUpperCase().startsWith(sym),
      );
      if (mine.some((p) => p.action === desired)) {
        return { rejected: false, skipped: true, reason: `Already ${desired === "BUY" ? "Long" : "Short"} - no action.` };
      }
      const price = await fetchUnderlyingLtp(segment, sym);
      const result = await placeManualOrder({
        segment,
        symbol: sym,
        action: desired,
        strategy: "future",
        moneyness: "ATM",
        orderType: "market",
        entryPrice: price,
        quantity: config.lots,
        stop: null,
        target: null,
        trendFollowed: false,
        riskManaged: false,
        setupTag: null,
        confidence: null,
        entryInterval: iv,
        // Server-trailed SuperTrend stop - keeps working with the tab
        // closed, and re-anchors to the same line the chart draws.
        slConfig: {
          stop_loss_method: "indicator",
          stop_loss_indicator_type: "supertrend",
          stop_loss_indicator_params: { period: config.period, multiplier: config.multiplier },
          stop_loss_interval: iv,
          trailing_stop_enabled: true,
        },
      });
      return { rejected: result.rejected, skipped: false, reason: result.reason };
    }

    async function tick() {
      if (cancelled || firingRef.current) return;
      const bars = await completedBars();
      if (cancelled || bars == null) return;
      if (bars.length < config.period + 2) {
        setStatus({ phase: "error", message: `Not enough completed ${iv} bars yet (${bars.length}).`, dir: null, line: null });
        return;
      }
      const st = computeSupertrend(bars, config.period, config.multiplier);
      const cur = st[st.length - 1] ?? null;
      const flips = detectSupertrendFlips(bars, config.period, config.multiplier);

      let state = loadAutoTradeState(key);
      if (state == null) {
        // Seed: arm from now. Any flip already on the chart is history -
        // only a flip AFTER this point should ever fire.
        const latestFlipTs = flips.length ? flips[flips.length - 1].barTs : 0;
        state = { armedAt: Date.now(), lastActedBarTs: latestFlipTs };
        saveAutoTradeState(key, state);
        setStatus({
          phase: "watching",
          message: `Armed on ${iv} SuperTrend(${config.period}, ${config.multiplier}). Currently ${cur?.dir === "up" ? "bullish" : cur?.dir === "down" ? "bearish" : "—"} — waiting for the next flip.`,
          dir: cur?.dir ?? null,
          line: cur?.line ?? null,
        });
        return;
      }

      // Daily-loss safety net (halts until toggled off/on).
      if (account?.max_daily_loss != null && account.max_daily_loss > 0) {
        const realized = await todayRealizedManualPnl(segment);
        if (realized <= -account.max_daily_loss) {
          setStatus({
            phase: "halted",
            message: `Daily loss budget reached (${fmt(realized)} / ${fmt(-account.max_daily_loss)}). Auto-trade halted — toggle off and on to resume.`,
            dir: cur?.dir ?? null,
            line: cur?.line ?? null,
          });
          return;
        }
      }

      const fresh = flips.filter((f) => f.barTs > state!.lastActedBarTs);
      if (fresh.length === 0) {
        setStatus({
          phase: "watching",
          message: `Watching ${iv} SuperTrend(${config.period}, ${config.multiplier}). Trend ${cur?.dir === "up" ? "up" : cur?.dir === "down" ? "down" : "—"}${cur ? ` · line ${fmt(cur.line)}` : ""}.`,
          dir: cur?.dir ?? null,
          line: cur?.line ?? null,
        });
        return;
      }

      // Only the most recent flip matters - an older un-acted one would
      // have been reversed straight back by this one anyway.
      const flip = fresh[fresh.length - 1];
      firingRef.current = true;
      setStatus({
        phase: "firing",
        message: `SuperTrend flipped ${flip.direction === "up" ? "up → BUY" : "down → SELL"} @ ${fmt(flip.close)} — placing…`,
        dir: flip.direction,
        line: flip.line,
      });
      try {
        const result = await executeFlip(flip);
        // Advance the dedupe cursor only on a settled outcome (placed,
        // rejected, or deliberately skipped) - a thrown error leaves it so
        // the next tick retries the same flip.
        saveAutoTradeState(key, { ...state, lastActedBarTs: flip.barTs });
        if (result.rejected) {
          setStatus({ phase: "error", message: `Order rejected: ${result.reason ?? "unknown"}.`, dir: flip.direction, line: flip.line });
        } else if (result.skipped) {
          setStatus({ phase: "watching", message: result.reason ?? "Skipped.", dir: flip.direction, line: flip.line });
        } else {
          setStatus({
            phase: "watching",
            message: `In ${flip.direction === "up" ? "Long" : "Short"} ${config.lots} lot(s) from the ${iv} flip @ ${fmt(flip.close)}. SL trails SuperTrend(${config.period}, ${config.multiplier}).`,
            dir: flip.direction,
            line: flip.line,
          });
        }
      } catch (e) {
        setStatus({ phase: "error", message: e instanceof Error ? e.message : "failed to place the auto order.", dir: flip.direction, line: flip.line });
      } finally {
        firingRef.current = false;
      }
    }

    setStatus({ phase: "seeding", message: "Reading recent candles…", dir: null, line: null });
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [on, segment, symbol, config, account]);

  const dirClass = status?.dir === "up" ? "at-up" : status?.dir === "down" ? "at-down" : "";

  return (
    <div className={`auto-trade-panel ${on ? "armed" : ""} ${dirClass}`}>
      <div className="auto-trade-head">
        <label className="auto-trade-toggle" title="Automatically place a market future order on every SuperTrend flip, with a server-trailed SuperTrend stop. Stop-and-reverse. Disarms if you switch symbols.">
          <input type="checkbox" checked={on} onChange={onToggle} />
          <span>Auto-trade</span>
          <span className="auto-trade-sub">
            {symbol} · {config.interval} ST({config.period}, {config.multiplier}) · {config.lots} lot{config.lots === 1 ? "" : "s"}
          </span>
        </label>
        <button type="button" className="auto-trade-cfg-btn" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} config
        </button>
      </div>

      {open && (
        <div className="auto-trade-config">
          <label className="auto-trade-field">
            <span>Interval</span>
            <select
              value={config.interval}
              onChange={(e) => onConfigChange({ ...config, interval: e.target.value as ChartInterval })}
            >
              {INTERVAL_OPTIONS.map((iv) => (
                <option key={iv} value={iv}>
                  {iv.replace("min", "m")}
                </option>
              ))}
            </select>
          </label>
          <label className="auto-trade-field">
            <span>ATR period</span>
            <input
              inputMode="numeric"
              value={draft.period}
              onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value }))}
              onBlur={commitDraft}
            />
          </label>
          <label className="auto-trade-field">
            <span>Multiplier</span>
            <input
              inputMode="decimal"
              value={draft.multiplier}
              onChange={(e) => setDraft((d) => ({ ...d, multiplier: e.target.value }))}
              onBlur={commitDraft}
            />
          </label>
          <label className="auto-trade-field">
            <span>Lots</span>
            <input
              inputMode="numeric"
              value={draft.lots}
              onChange={(e) => setDraft((d) => ({ ...d, lots: e.target.value }))}
              onBlur={commitDraft}
            />
          </label>
          <p className="auto-trade-config-note">
            Futures only. Opens a market order on each flip; execution closes any opposite position and flips. The stop
            trails SuperTrend server-side, so it holds even with this tab closed.
          </p>
        </div>
      )}

      {on && status && (
        <p className={`auto-trade-status is-${status.phase}`}>
          {status.phase === "firing" && "⚡ "}
          {status.phase === "error" && "⚠ "}
          {status.phase === "halted" && "⛔ "}
          {status.message}
        </p>
      )}
    </div>
  );
}

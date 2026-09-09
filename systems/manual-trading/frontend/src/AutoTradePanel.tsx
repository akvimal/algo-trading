import { useEffect, useRef, useState } from "react";

import {
  type Account,
  type ChartInterval,
  type ManualOptionGroup,
  type ManualPosition,
  type OptionStrikeMoneyness,
  type ResolvedUnderlying,
  type Segment,
  fetchCandleHistory,
  fetchExecPositions,
  fetchOptionGroups,
} from "./api";
import {
  AUTO_TRADE_MAX_RETRIES,
  type AutoTradeConfig,
  type AutoTradeInstrument,
  intervalMinutes,
  loadAutoTradeState,
  lookbackDaysFor,
  saveAutoTradeState,
  symbolKey,
} from "./autoTrade";
import { CRYPTO_OPTION_SYMBOLS, fetchUnderlyingLtp, fmt, placeManualOrder, resolveUnderlyingCached } from "./manualOrder";
import { computeSupertrend, detectSupertrendFlips, type SupertrendFlip } from "./supertrend";

// The Intraday auto-trader panel + its watcher loop. Sits above
// ChartTradePanel in LiveChartPage's .chart-trade-col. See autoTrade.ts
// for the config/state model and docs/architecture.md § "Live chart -
// Intraday auto-trader" for the full design.
//
// Watcher: every POLL_MS, fetch completed `interval` bars for the chart's
// symbol, run the shared SuperTrend (supertrend.ts - literally the same
// function the chart draws), and on arm (the current direction) or a NEW
// flip (one past the seeded `lastActedBarTs`) place a MARKET order in that
// direction:
//   - future: a future with a server-trailed SuperTrend stop
//   - option: a naked call (up) / naked put (down) at `moneyness` with a
//     flat spot stop at the SuperTrend line
// Stop-and-reverse comes for free either way: both execution manual paths
// (open_manual_position / open_manual_option_group) run
// counter_signal_policy='close_and_flip', so an opposite open
// position/group is closed atomically when the new order lands.
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
const MONEYNESS_OPTIONS: OptionStrikeMoneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];

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
  setupTag,
}: {
  on: boolean;
  onToggle: () => void;
  config: AutoTradeConfig;
  onConfigChange: (c: AutoTradeConfig) => void;
  segment: Segment;
  symbol: string;
  account: Account | null;
  // Setup tag from the SetupCardRow below the chart - stamped on every
  // auto-trade fill's journal. "" = none.
  setupTag: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WatchStatus | null>(null);

  const sym = symbol.trim().toUpperCase();
  // Delta only lists options for BTCUSD/ETHUSD; every NSE/MCX symbol here
  // has an option chain. Mirrors ChartTradePanel's own `optionEligible`.
  const optionEligible = segment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(sym);
  // Force back to Future when the current symbol has no option chain.
  useEffect(() => {
    if (!optionEligible && config.instrument === "option") {
      onConfigChange({ ...config, instrument: "future" });
    }
  }, [optionEligible, config, onConfigChange]);
  const instrument: AutoTradeInstrument = optionEligible ? config.instrument : "future";

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
  // Current setup tag, read at fire time - a ref so changing it doesn't
  // re-run the effect (which would re-seed / re-fire the on-arm entry).
  const setupTagRef = useRef(setupTag);
  setupTagRef.current = setupTag;
  // Retry counter for the ON-ARM entry (which persists no state until it
  // lands - a rejected seed just re-seeds next tick). Non-seed flip
  // retries live in the persisted run state instead.
  const seedRetriesRef = useRef(0);
  useEffect(() => {
    if (!on) {
      setStatus(null);
      return;
    }
    seedRetriesRef.current = 0;
    const key = symbolKey(segment, symbol);
    const iv = config.interval;
    const ivMs = intervalMinutes(iv) * 60_000;
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

    // The effective instrument for THIS symbol - CRYPTO options only exist
    // for BTCUSD/ETHUSD (matches ChartTradePanel's optionEligible).
    const instr: AutoTradeInstrument =
      segment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(sym) ? config.instrument : "future";

    async function executeFlip(flip: SupertrendFlip): Promise<{ rejected: boolean; skipped: boolean; reason: string | null }> {
      const desired: "BUY" | "SELL" = flip.direction === "up" ? "BUY" : "SELL";
      const price = await fetchUnderlyingLtp(segment, sym);

      if (instr === "option") {
        // Naked call (up / BUY) or naked put (down / SELL). An open group
        // in the OPPOSITE direction is closed by execution itself
        // (counter_signal_policy='close_and_flip'); one in the SAME
        // direction would pyramid (add_position), so skip that.
        let groups: ManualOptionGroup[] = [];
        try {
          groups = await fetchOptionGroups({ segment, status: "OPEN", manualOnly: true });
        } catch {
          groups = [];
        }
        const mine = groups.filter((g) => g.underlying_symbol.toUpperCase() === sym);
        if (mine.some((g) => g.action === desired)) {
          return { rejected: false, skipped: true, reason: `Already holding a naked ${desired === "BUY" ? "call" : "put"} — no action.` };
        }
        const result = await placeManualOrder({
          segment,
          symbol: sym,
          action: desired,
          strategy: "naked",
          moneyness: config.moneyness,
          orderType: "market",
          entryPrice: price,
          quantity: config.lots,
          // Flat spot stop at the SuperTrend line - execution has no
          // method/trailing SL for options, so it doesn't trail (the
          // opposite flip is the real exit anyway).
          stop: flip.line,
          target: null,
          trendFollowed: false,
          riskManaged: false,
          setupTag: setupTagRef.current || null,
        autoTraded: true,
          confidence: null,
          entryInterval: iv,
        });
        return { rejected: result.rejected, skipped: false, reason: result.reason };
      }

      // --- future ---
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
        return { rejected: false, skipped: true, reason: `Already ${desired === "BUY" ? "Long" : "Short"} — no action.` };
      }
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
        setupTag: setupTagRef.current || null,
        autoTraded: true,
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
      const lastBar = bars[bars.length - 1];
      const latestFlipTs = flips.length ? flips[flips.length - 1].barTs : 0;

      const state = loadAutoTradeState(key);
      const seeding = state == null;

      // Daily-loss safety net (halts until toggled off/on) - checked
      // before an on-arm entry too, so being over budget never opens one.
      if (account?.max_daily_loss != null && account.max_daily_loss > 0) {
        const realized = await todayRealizedManualPnl(segment);
        if (cancelled) return;
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

      // What to act on this tick:
      //  - seeding + a current trend -> enter it NOW (synthesize a flip
      //    from the latest completed bar; executeFlip no-ops if we're
      //    already positioned that way). Stop-and-reverse then continues
      //    from the real flips.
      //  - otherwise -> the most recent flip past the dedupe cursor, if any
      //    (an older un-acted flip would have been reversed straight back).
      let act: { flip: SupertrendFlip; seed: boolean } | null = null;
      if (seeding) {
        if (cur) {
          act = {
            seed: true,
            flip: { index: bars.length - 1, barTs: lastBar.timestamp, direction: cur.dir, line: cur.line, close: lastBar.close },
          };
        }
      } else {
        const fresh = flips.filter((f) => f.barTs > state.lastActedBarTs);
        if (fresh.length > 0) act = { seed: false, flip: fresh[fresh.length - 1] };
      }

      if (act == null) {
        // Nothing to act on - seed the cursor (if seeding) and just
        // refresh the status line.
        if (seeding) {
          seedRetriesRef.current = 0;
          saveAutoTradeState(key, { armedAt: Date.now(), lastActedBarTs: latestFlipTs });
        }
        setStatus({
          phase: "watching",
          message: seeding
            ? `Armed on ${iv} SuperTrend(${config.period}, ${config.multiplier}) — no trend yet, waiting for a flip.`
            : `Watching ${iv} SuperTrend(${config.period}, ${config.multiplier}). Trend ${cur?.dir === "up" ? "up" : cur?.dir === "down" ? "down" : "—"}${cur ? ` · line ${fmt(cur.line)}` : ""}.`,
          dir: cur?.dir ?? null,
          line: cur?.line ?? null,
        });
        return;
      }

      const { flip, seed } = act;
      // "Long"/"Short" for a future, "naked call"/"naked put" for an option.
      const posLabel =
        instr === "option"
          ? flip.direction === "up"
            ? "a naked call"
            : "a naked put"
          : flip.direction === "up"
            ? "Long"
            : "Short";
      firingRef.current = true;
      setStatus({
        phase: "firing",
        message: seed
          ? `Arming — entering ${posLabel} on the current ${iv} SuperTrend @ ${fmt(flip.close)}…`
          : `SuperTrend flipped ${flip.direction === "up" ? "up → BUY" : "down → SELL"} @ ${fmt(flip.close)} — placing…`,
        dir: flip.direction,
        line: flip.line,
      });
      // A rejected / errored order - retry on later ticks rather than
      // advancing past the flip (transient NSE quote timeouts are common,
      // and a rejected stop-and-reverse leaves the OLD position open the
      // wrong way). Bounded by AUTO_TRADE_MAX_RETRIES so a permanent
      // rejection (balance, validation) doesn't loop forever.
      const onFailure = (reason: string) => {
        if (seed) {
          seedRetriesRef.current += 1;
          const n = seedRetriesRef.current;
          if (n >= AUTO_TRADE_MAX_RETRIES) {
            seedRetriesRef.current = 0;
            saveAutoTradeState(key, { armedAt: Date.now(), lastActedBarTs: latestFlipTs });
            setStatus({ phase: "error", message: `Gave up entering after ${n} tries: ${reason}. Waiting for the next flip.`, dir: flip.direction, line: flip.line });
          } else {
            // No state saved -> next tick re-seeds and retries the entry.
            setStatus({ phase: "error", message: `Entry rejected (${reason}) — retrying (${n}/${AUTO_TRADE_MAX_RETRIES}).`, dir: flip.direction, line: flip.line });
          }
          return;
        }
        const s = state as NonNullable<typeof state>;
        const attempts = (s.retryBarTs === flip.barTs ? (s.retryCount ?? 0) : 0) + 1;
        if (attempts >= AUTO_TRADE_MAX_RETRIES) {
          saveAutoTradeState(key, { armedAt: s.armedAt, lastActedBarTs: flip.barTs });
          setStatus({
            phase: "error",
            message: `Gave up reversing after ${attempts} tries: ${reason}. Your position from the previous flip is still open — square it off manually if it's against the trend.`,
            dir: flip.direction,
            line: flip.line,
          });
        } else {
          saveAutoTradeState(key, { armedAt: s.armedAt, lastActedBarTs: s.lastActedBarTs, retryBarTs: flip.barTs, retryCount: attempts });
          setStatus({
            phase: "error",
            message: `Reverse rejected (${reason}) — retrying (${attempts}/${AUTO_TRADE_MAX_RETRIES}). Your position from the previous flip is still live and now against the trend.`,
            dir: flip.direction,
            line: flip.line,
          });
        }
      };

      try {
        const result = await executeFlip(flip);
        if (result.rejected) {
          onFailure(result.reason ?? "order rejected");
          return;
        }
        // Settled OK (placed or skipped) - advance the cursor, clear retries.
        seedRetriesRef.current = 0;
        saveAutoTradeState(key, {
          armedAt: seeding ? Date.now() : (state as NonNullable<typeof state>).armedAt,
          lastActedBarTs: seed ? latestFlipTs : flip.barTs,
        });
        if (result.skipped) {
          setStatus({ phase: "watching", message: result.reason ?? "Skipped.", dir: flip.direction, line: flip.line });
        } else {
          setStatus({
            phase: "watching",
            message: `In ${posLabel} · ${config.lots} lot(s)${seed ? " (armed at current trend)" : ` from the ${iv} flip`} @ ${fmt(flip.close)}. ${
              instr === "option"
                ? `Spot SL ${fmt(flip.line)} (flat); exits on the opposite flip.`
                : `SL trails SuperTrend(${config.period}, ${config.multiplier}).`
            }`,
            dir: flip.direction,
            line: flip.line,
          });
        }
      } catch (e) {
        onFailure(e instanceof Error ? e.message : "failed to place the auto order");
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
        <label className="auto-trade-toggle" title="Enters the current SuperTrend direction on arming, then places a market order on every flip after — stop-and-reverse. Future (server-trailed SuperTrend stop) or naked option (flat spot stop). Disarms if you switch symbols.">
          <input type="checkbox" checked={on} onChange={onToggle} />
          <span>Auto-trade</span>
          <span className="auto-trade-sub">
            {sym} · {config.interval} ST({config.period}, {config.multiplier}) ·{" "}
            {instrument === "option" ? `naked ${config.moneyness}` : "future"} · {config.lots} lot
            {config.lots === 1 ? "" : "s"}
          </span>
        </label>
        <button type="button" className="auto-trade-cfg-btn" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} config
        </button>
      </div>

      {open && (
        <div className="auto-trade-config">
          <label className="auto-trade-field">
            <span>Instrument</span>
            <select
              value={instrument}
              onChange={(e) => onConfigChange({ ...config, instrument: e.target.value as AutoTradeInstrument })}
            >
              <option value="future">Future</option>
              <option value="option" disabled={!optionEligible}>
                Naked option
              </option>
            </select>
          </label>
          {instrument === "option" && (
            <label className="auto-trade-field">
              <span>Strike</span>
              <select
                value={config.moneyness}
                onChange={(e) => onConfigChange({ ...config, moneyness: e.target.value as OptionStrikeMoneyness })}
              >
                {MONEYNESS_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
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
            On arming it enters the current SuperTrend direction, then places a market order on every flip after
            (execution closes any opposite position and flips).{" "}
            {instrument === "option"
              ? "Naked call on an up-flip, naked put on a down-flip, with a flat spot stop at the SuperTrend line — options have no server-side trailing stop, so the opposite flip is the real exit."
              : "The stop trails SuperTrend server-side, so it holds even with this tab closed."}
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

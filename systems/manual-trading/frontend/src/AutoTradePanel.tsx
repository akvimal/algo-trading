import { useEffect, useRef, useState } from "react";

import {
  type ChartInterval,
  type Indicator,
  type OptionStrikeMoneyness,
  type Rule,
  type Segment,
  type Strategy,
  createIndicator,
  createRule,
  createStrategy,
  deleteIndicator,
  deleteRule,
  deleteStrategy,
  fetchCandleHistory,
  fetchIndicators,
  fetchRules,
  fetchStrategies,
  updateIndicator,
  updateRule,
  updateStrategy,
} from "./api";
import {
  type AutoTradeConfig,
  type AutoTradeWindow,
  DEFAULT_AUTO_TRADE_CONFIG,
  autoTradeAdxIndicatorName,
  autoTradeDmiIndicatorName,
  autoTradeIndicatorName,
  autoTradeStrategyName,
  isValidHhmm,
  loadAutoTradeConfig,
  saveAutoTradeConfig,
} from "./autoTrade";
import { CRYPTO_OPTION_SYMBOLS, fmt, formatCompact, resolveUnderlyingCached } from "./manualOrder";
import { computeSupertrend } from "./supertrend";

// The Intraday auto-trader panel - config + a thin status readout. The
// watcher/order-placement itself is SERVER-SIDE (signal-engine's in-house
// Rule engine, see autoTrade.ts's own module docstring): pressing "Auto-
// trade: ON" provisions (find-or-creates, by name - see autoTrade.ts's
// autoTradeStrategyName) an Indicator+Rule+Strategy trio there and flips
// the Strategy to status='live'; pressing it again PATCHes status='paused'.
// Nothing here runs a poll loop or places an order directly any more -
// this component only reads back signal-engine's own state to show it.
//
// One Strategy per (segment, symbol) - switching the chart's symbol just
// shows/arms a DIFFERENT Strategy, it does NOT disarm whatever's already
// armed elsewhere (unlike the old browser-only version, which could only
// ever run one symbol at a time and died on tab close) - see
// docs/architecture.md § "Live chart - Intraday auto-trader".

const INTERVAL_OPTIONS: ChartInterval[] = ["1min", "3min", "5min", "15min", "30min", "60min"];
const MONEYNESS_OPTIONS: OptionStrikeMoneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];
// Sensible fixed defaults for the ADX-gate's regime indicators - not
// exposed in this panel's UI (it's one checkbox, "ADX gate — trend must
// agree", same as before) since tuning them isn't this panel's job; edit
// the provisioned Indicator rows directly in signal-engine's own
// Indicators screen if you need something other than these.
const ADX_GATE_PARAMS = { period: 14, trend_threshold: 20 };
const DMI_GATE_PARAMS = { period: 14 };

const STATUS_POLL_MS = 20_000;
// How long a candle series to fetch for the read-only trend preview below
// the toggle - generous enough for the SuperTrend warmup at any offered
// interval, not tied to what the server-side Rule actually uses (it fetches
// its own window independently).
function previewLookbackDays(interval: ChartInterval): number {
  return { "1min": 3, "3min": 6, "5min": 10, "15min": 30, "30min": 45, "60min": 75 }[interval];
}

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type TrendPreview = { dir: "up" | "down"; line: number } | null;

export default function AutoTradePanel({
  segment,
  symbol,
  onArmedChange,
}: {
  segment: Segment;
  symbol: string;
  // Read-only echo of this panel's own armed status for this symbol, for
  // a parent that wants to reflect it elsewhere (e.g. ChartTradePanel's
  // own display) - this panel still owns all the actual arm/disarm logic.
  // No `account` prop any more - the old client-side daily-loss halt (see
  // git history's AutoTradePanel.tsx) doesn't have a server-side
  // equivalent yet; this is a known gap, not carried over silently.
  onArmedChange?: (armed: boolean) => void;
}) {
  const sym = symbol.trim().toUpperCase();
  // Delta only lists options for BTCUSD/ETHUSD; every NSE/MCX symbol here
  // has an option chain. Mirrors ChartTradePanel's own `optionEligible`.
  const optionEligible = segment !== "CRYPTO" || CRYPTO_OPTION_SYMBOLS.includes(sym);

  const [open, setOpen] = useState(false);
  const [strategyRow, setStrategyRow] = useState<Strategy | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutoTradeConfig>(() => loadAutoTradeConfig());
  const [trend, setTrend] = useState<TrendPreview>(null);
  // In-page Yes/No for "Clear config" (not window.confirm - a native
  // dialog blocks the whole tab's event loop, same reasoning
  // WorkspacePage.tsx's own confirmRemoveId already established) - a
  // destructive action (deletes the provisioned Strategy/Rule/Indicator
  // rows), so it asks first.
  const [confirmClear, setConfirmClear] = useState(false);

  const armed = strategyRow?.status === "live";
  const instrument = optionEligible ? draft.instrument : "future";

  useEffect(() => {
    onArmedChange?.(armed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed]);

  // Draft numeric fields as strings so a half-typed number doesn't fight
  // the parse - same pattern account/strategy edit forms elsewhere use.
  const [numDraft, setNumDraft] = useState(() => ({
    period: String(draft.period),
    multiplier: String(draft.multiplier),
    lots: String(draft.lots),
  }));
  useEffect(() => {
    setNumDraft({ period: String(draft.period), multiplier: String(draft.multiplier), lots: String(draft.lots) });
  }, [draft.period, draft.multiplier, draft.lots]);

  function commitConfig(patch: Partial<AutoTradeConfig>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      saveAutoTradeConfig(next);
      return next;
    });
  }

  function commitNumDraft() {
    const period = Math.round(Number(numDraft.period));
    const multiplier = Number(numDraft.multiplier);
    const lots = Math.round(Number(numDraft.lots));
    commitConfig({
      period: Number.isFinite(period) && period >= 2 && period <= 100 ? period : draft.period,
      multiplier: Number.isFinite(multiplier) && multiplier >= 0.5 && multiplier <= 20 ? multiplier : draft.multiplier,
      lots: Number.isFinite(lots) && lots >= 1 && lots <= 100000 ? lots : draft.lots,
    });
  }

  function addWindow() {
    commitConfig({ windows: [...draft.windows, { start: "09:15", end: "15:15" }] });
  }
  function updateWindow(i: number, patch: Partial<AutoTradeWindow>) {
    commitConfig({ windows: draft.windows.map((w, idx) => (idx === i ? { ...w, ...patch } : w)) });
  }
  function removeWindow(i: number) {
    commitConfig({ windows: draft.windows.filter((_, idx) => idx !== i) });
  }

  // --- Status: does a live/paused auto-trade Strategy already exist for
  // (segment, symbol)? Also reconstructs the config form from it, so
  // reopening the chart on an already-armed symbol shows what's actually
  // running, not a stale local draft. ---
  const loadingRef = useRef(false);
  async function loadStatus(repopulateDraft: boolean) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [strategies, rules] = await Promise.all([fetchStrategies("in_house"), fetchRules()]);
      const name = autoTradeStrategyName(segment, sym);
      const row = strategies.find((s) => s.name === name) ?? null;
      setStrategyRow(row);
      if (row && repopulateDraft) {
        const rule = row.rule_id ? (rules.find((r) => r.id === row.rule_id) ?? null) : null;
        const next: AutoTradeConfig = {
          instrument: row.instrument_type === "option" ? "option" : "future",
          moneyness: row.option_strike_moneyness,
          period: row.stop_loss_indicator_params?.period ?? DEFAULT_AUTO_TRADE_CONFIG.period,
          multiplier: row.stop_loss_indicator_params?.multiplier ?? DEFAULT_AUTO_TRADE_CONFIG.multiplier,
          interval: (rule?.interval as ChartInterval) ?? DEFAULT_AUTO_TRADE_CONFIG.interval,
          lots: row.fixed_lots ?? DEFAULT_AUTO_TRADE_CONFIG.lots,
          adxGate: (rule?.regime_indicator_ids.length ?? 0) > 0,
          windows: row.active_windows,
        };
        setDraft(next);
        saveAutoTradeConfig(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to read auto-trade status");
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    setStrategyRow(null);
    setError(null);
    setLoadingStatus(true);
    void loadStatus(true).finally(() => setLoadingStatus(false));
    const id = window.setInterval(() => void loadStatus(false), STATUS_POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, sym]);

  // --- Read-only trend preview (not decision-driving - the server-side
  // Rule fetches and evaluates its own candles independently). ---
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const resolved = await resolveUnderlyingCached(segment, sym);
        const to = new Date();
        const from = new Date(to.getTime() - previewLookbackDays(draft.interval) * 86_400_000);
        const candles = await fetchCandleHistory(resolved.chart_exchange, resolved.chart_symbol, draft.interval, ymdLocal(from), ymdLocal(to));
        if (cancelled || candles.length < draft.period + 2) return;
        const st = computeSupertrend(candles, draft.period, draft.multiplier);
        const last = st[st.length - 1];
        if (last) setTrend({ dir: last.dir, line: last.line });
      } catch {
        /* keep last preview on a transient failure */
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [segment, sym, draft.interval, draft.period, draft.multiplier]);

  // --- Provisioning: find-or-create the Indicator(s)/Rule/Strategy trio,
  // then flip the Strategy live. Idempotent by name (autoTrade.ts's own
  // naming scheme) - re-arming after a config change updates the SAME
  // rows rather than leaving orphaned old ones behind. ---
  async function findOrCreateIndicator(
    existing: Indicator[],
    name: string,
    type: Indicator["type"],
    params: Indicator["params"],
  ): Promise<string> {
    const found = existing.find((i) => i.name === name && i.type === type);
    if (found) {
      await updateIndicator(found.id, { params });
      return found.id;
    }
    return (await createIndicator({ name, type, params })).id;
  }

  async function armAutoTrade() {
    if (draft.windows.some((w) => !isValidHhmm(w.start) || !isValidHhmm(w.end) || w.end <= w.start)) {
      setError("every window needs a valid start time strictly before its end time");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [indicators, rules, strategies] = await Promise.all([fetchIndicators(), fetchRules(), fetchStrategies("in_house")]);

      const stIndicatorId = await findOrCreateIndicator(indicators, autoTradeIndicatorName(segment, sym), "supertrend", {
        period: draft.period,
        multiplier: draft.multiplier,
      });

      let regimeIndicatorIds: string[] = [];
      if (draft.adxGate) {
        const adxId = await findOrCreateIndicator(indicators, autoTradeAdxIndicatorName(segment, sym), "adx", ADX_GATE_PARAMS);
        const dmiId = await findOrCreateIndicator(indicators, autoTradeDmiIndicatorName(segment, sym), "dmi_direction", DMI_GATE_PARAMS);
        regimeIndicatorIds = [adxId, dmiId];
      }

      const ruleName = autoTradeStrategyName(segment, sym);
      const existingRule: Rule | undefined = rules.find((r) => r.name === ruleName);
      const ruleFields = {
        name: ruleName,
        segment,
        underlying: sym,
        underlying_type: "symbol" as const,
        interval: draft.interval,
        rule_config: { type: "crossover" as const, indicator_id: stIndicatorId },
        regime_indicator_ids: regimeIndicatorIds,
      };
      const ruleId = existingRule ? (await updateRule(existingRule.id, ruleFields)).id : (await createRule(ruleFields)).id;

      const stratName = autoTradeStrategyName(segment, sym);
      const existingStrategy: Strategy | undefined = strategies.find((s) => s.name === stratName);
      const stratFields = {
        instrument_type: instrument,
        rule_id: ruleId,
        stop_loss_method: "indicator" as const,
        stop_loss_interval: draft.interval,
        stop_loss_indicator_type: "supertrend" as const,
        stop_loss_indicator_params: { period: draft.period, multiplier: draft.multiplier },
        trailing_stop_enabled: true,
        option_position_style: instrument === "option" ? ("naked" as const) : undefined,
        option_strike_moneyness: instrument === "option" ? draft.moneyness : undefined,
        fixed_lots: draft.lots,
        segment,
        duplicate_signal_policy: "skip" as const,
        counter_signal_policy: "close_and_flip" as const,
        active_windows: draft.windows,
        seed_on_activation: true,
      };
      const strategyId = existingStrategy
        ? existingStrategy.id
        : (
            await createStrategy({
              name: stratName,
              source_type: "in_house",
              horizon: "intraday",
              ...stratFields,
            })
          ).id;
      if (existingStrategy) await updateStrategy(strategyId, stratFields);
      // reset_engine_run: true - every arm re-seeds the CURRENT trend, not
      // just a brand new Strategy's first-ever activation (its
      // last_signal_candle_ts otherwise stays set forever once any signal
      // has posted, so a plain status='live' PATCH alone wouldn't re-seed
      // a strategy that was paused and is now being re-armed).
      const finalRow = await updateStrategy(strategyId, { status: "live", reset_engine_run: true });
      setStrategyRow(finalRow);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to arm auto-trade");
    } finally {
      setBusy(false);
    }
  }

  async function disarmAutoTrade() {
    if (!strategyRow) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateStrategy(strategyRow.id, { status: "paused" });
      setStrategyRow(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to pause auto-trade");
    } finally {
      setBusy(false);
    }
  }

  function onToggle() {
    if (busy) return;
    if (armed) void disarmAutoTrade();
    else void armAutoTrade();
  }

  // Deletes the provisioned Strategy (hard delete - fine to run while
  // still 'live', same as deleting any other Strategy) and its backing
  // Rule + Indicator(s) - so a symbol you're done experimenting with
  // doesn't linger as a paused Strategy forever in signal-engine's own
  // Strategies/Rules/Indicators screens - then resets the local draft
  // form back to defaults. Best-effort on the Rule/Indicator cleanup: a
  // partial failure there still resets the local form and clears
  // strategyRow, since the Strategy itself (the thing that actually ran
  // trades) is already gone either way.
  async function clearConfig() {
    setBusy(true);
    setError(null);
    try {
      if (strategyRow) {
        await deleteStrategy(strategyRow.id);
        const [rules, indicators] = await Promise.all([fetchRules(), fetchIndicators()]);
        const ruleName = autoTradeStrategyName(segment, sym);
        const rule = rules.find((r) => r.name === ruleName);
        if (rule) await deleteRule(rule.id).catch(() => {});
        const indicatorNames = [autoTradeIndicatorName(segment, sym), autoTradeAdxIndicatorName(segment, sym), autoTradeDmiIndicatorName(segment, sym)];
        for (const ind of indicators.filter((i) => indicatorNames.includes(i.name))) {
          await deleteIndicator(ind.id).catch(() => {});
        }
      }
      setStrategyRow(null);
      setDraft(DEFAULT_AUTO_TRADE_CONFIG);
      saveAutoTradeConfig(DEFAULT_AUTO_TRADE_CONFIG);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to clear auto-trade config");
    } finally {
      setConfirmClear(false);
      setBusy(false);
    }
  }

  const dirClass = trend?.dir === "up" ? "at-up" : trend?.dir === "down" ? "at-down" : "";

  return (
    <div className={`auto-trade-panel ${armed ? "armed" : ""} ${dirClass}`}>
      <div className="auto-trade-head">
        <label
          className="auto-trade-toggle"
          title="Server-side: places a market future or naked-option order on every SuperTrend flip, with a server-trailed stop - keeps running (and keeps trailing/flipping) with every browser tab closed. Enters the current trend immediately on arming. One Strategy per symbol - arming a different chart symbol does NOT disarm this one."
        >
          <input type="checkbox" checked={armed} disabled={busy || loadingStatus} onChange={onToggle} />
          <span>Auto-trade{busy ? " (working…)" : ""}</span>
          <span className="auto-trade-sub">
            {sym} · {draft.interval} ST({draft.period}, {draft.multiplier}) ·{" "}
            {instrument === "option" ? `naked ${draft.moneyness}` : "future"} · {draft.lots} lot
            {draft.lots === 1 ? "" : "s"}
            {draft.adxGate && " · ADX gate"}
            {draft.windows.length > 0 && ` · ${draft.windows.length} window${draft.windows.length === 1 ? "" : "s"}`}
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
              disabled={busy}
              onChange={(e) => commitConfig({ instrument: e.target.value as AutoTradeConfig["instrument"] })}
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
              <select value={draft.moneyness} disabled={busy} onChange={(e) => commitConfig({ moneyness: e.target.value as OptionStrikeMoneyness })}>
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
            <select value={draft.interval} disabled={busy} onChange={(e) => commitConfig({ interval: e.target.value as ChartInterval })}>
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
              disabled={busy}
              value={numDraft.period}
              onChange={(e) => setNumDraft((d) => ({ ...d, period: e.target.value }))}
              onBlur={commitNumDraft}
            />
          </label>
          <label className="auto-trade-field">
            <span>Multiplier</span>
            <input
              inputMode="decimal"
              disabled={busy}
              value={numDraft.multiplier}
              onChange={(e) => setNumDraft((d) => ({ ...d, multiplier: e.target.value }))}
              onBlur={commitNumDraft}
            />
          </label>
          <label className="auto-trade-field">
            <span>Lots</span>
            <input
              inputMode="numeric"
              disabled={busy}
              value={numDraft.lots}
              onChange={(e) => setNumDraft((d) => ({ ...d, lots: e.target.value }))}
              onBlur={commitNumDraft}
            />
          </label>

          <div className="auto-trade-gates">
            <label
              className="auto-trade-gate-toggle"
              title="Only act on a flip when server-side ADX + DMI-direction indicators (auto-provisioned) confirm trend strength AND direction agree with the flip."
            >
              <input type="checkbox" checked={draft.adxGate} disabled={busy} onChange={(e) => commitConfig({ adxGate: e.target.checked })} />
              <span>ADX gate — trend must agree</span>
            </label>

            <div className="auto-trade-windows">
              <span>Entry windows (local)</span>
              {draft.windows.length === 0 && <p className="muted tiny">None set — acts on a flip any time.</p>}
              {draft.windows.map((w, i) => (
                <div key={i} className="auto-trade-window-row">
                  <input type="time" value={w.start} disabled={busy} onChange={(e) => updateWindow(i, { start: e.target.value })} />
                  <span>–</span>
                  <input type="time" value={w.end} disabled={busy} onChange={(e) => updateWindow(i, { end: e.target.value })} />
                  <button type="button" className="tiny" disabled={busy} onClick={() => removeWindow(i)}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="tiny" disabled={busy} onClick={addWindow}>
                + Add window
              </button>
            </div>
          </div>

          <p className="auto-trade-config-note">
            Runs server-side in signal-engine's in-house engine (Strategy "{autoTradeStrategyName(segment, sym)}") - arming enters the current
            SuperTrend direction immediately, then places a market order on every flip after (a server-trailed stop; execution closes any opposite
            position and flips). Keeps running with this tab closed. A flip outside every configured window, or against the ADX gate, is skipped,
            not queued. Editable directly in signal-engine's own Strategies/Rules screens too.
          </p>

          <div className="auto-trade-clear-row">
            {confirmClear ? (
              <span className="auto-trade-confirm-clear">
                <span className="muted">
                  {strategyRow ? "Delete the provisioned Strategy/Rule/Indicator and reset this form?" : "Reset this form to defaults?"}
                </span>
                <button type="button" className="tiny btn-exit" disabled={busy} onClick={() => void clearConfig()}>
                  Yes
                </button>
                <button type="button" className="tiny secondary" disabled={busy} onClick={() => setConfirmClear(false)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className="tiny secondary" disabled={busy} onClick={() => setConfirmClear(true)}>
                Clear config
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="auto-trade-status is-error">⚠ {error}</p>}
      {!error && loadingStatus && <p className="auto-trade-status muted">Checking auto-trade status…</p>}
      {!error && !loadingStatus && strategyRow && (
        <p className={`auto-trade-status ${armed ? "is-watching" : "is-paused"}`}>
          {armed ? "Armed server-side" : "Paused"} — last scanned {formatCompact(strategyRow.last_scan_at)}
          {trend && ` · trend ${trend.dir === "up" ? "up" : "down"} · line ${fmt(trend.line)}`}
        </p>
      )}
      {!error && !loadingStatus && !strategyRow && trend && (
        <p className="auto-trade-status muted">
          Not armed · current {draft.interval} trend {trend.dir === "up" ? "up" : "down"} · line {fmt(trend.line)}
        </p>
      )}
    </div>
  );
}

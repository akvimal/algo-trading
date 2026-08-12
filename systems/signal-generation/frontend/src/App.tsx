import { useEffect, useState } from "react";

import {
  ALL_REGIME_CHECKS,
  REGIME_CHECK_LABELS,
  type BacktestResult,
  type CounterSignalPolicy,
  type DuplicateSignalPolicy,
  type GridBacktestResult,
  type Horizon,
  type Indicator,
  type InstrumentType,
  type Interval,
  type ProviderSignal,
  type RegimeCheckName,
  type Segment,
  type SourceType,
  type StopLossInterval,
  type StopLossMethod,
  type Strategy,
  type StrategyStatus,
  type UnderlyingType,
  type UniverseBacktestResult,
  backtestStrategy,
  backtestStrategyGrid,
  createIndicator,
  createStrategy,
  defaultSquareOffTime,
  deleteIndicator,
  deleteStrategy,
  fetchIndicators,
  fetchSignalsForStrategy,
  fetchStrategies,
  fetchUniverses,
  updateStrategy,
} from "./api";
import { chartinkWebhookUrls, executionUrl, n8nUrl, processingUrl } from "./links";

const POLL_INTERVAL_MS = 5000;

type TabId = "strategies" | "indicators";

const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop-loss",
  target: "Target",
  square_off: "Square-off",
  opposite_signal: "Opposite signal",
  end_of_data: "Still open (end of range)",
  initial_stop_loss: "Initial stop-loss",
  reversal_exit: "Reversal exit",
};

function toggleRegimeCheck(checks: RegimeCheckName[], name: RegimeCheckName): RegimeCheckName[] {
  return checks.includes(name) ? checks.filter((c) => c !== name) : [...checks, name];
}

function exitReasonLabel(reason: string): string {
  return EXIT_REASON_LABELS[reason] ?? reason;
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

// Collapsed by default - a permanently-open explainer panel took up space
// every time you just wanted to manage strategies.
function InfoDisclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="info-disclosure">
      <summary>
        <InfoIcon />
        {summary}
      </summary>
      <div className="info-disclosure-body">{children}</div>
    </details>
  );
}

// navigator.clipboard.writeText can fail silently - blocked in a non-secure
// context, or in an iframe without a clipboard-write permission grant (see
// shell/index.html). Fall back to the older execCommand approach so the
// button does *something* observable either way.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback below
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function WebhookLine({ label, url }: { label: string; url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function handleClick() {
    const ok = await copyText(url);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1500);
  }

  const title =
    state === "copied" ? "Copied!" : state === "failed" ? "Copy failed - select and copy the URL manually" : `Copy ${label} webhook URL`;

  return (
    <div className="webhook-line">
      <span className="webhook-label">{label}</span>
      <button type="button" className="icon-btn" onClick={handleClick} title={title} aria-label={title}>
        {state === "copied" ? <CheckIcon /> : <ClipboardIcon />}
      </button>
    </div>
  );
}

function formatStopLoss(s: Strategy): string {
  if (!s.stop_loss_method) return "-";
  const base = s.stop_loss_method === "previous_candle" ? `Prev candle (${s.stop_loss_interval})` : `${s.stop_loss_percent}%`;
  return s.trailing_stop_enabled ? `${base}, trailing` : base;
}

function formatTarget(s: Strategy): string {
  return s.target_percent != null ? `${s.target_percent}%` : "-";
}

function WebhookLinks({ strategyId, sourceType }: { strategyId: string; sourceType: SourceType }) {
  // In-house strategies never get a webhook - they run off this system's
  // own scheduled engine, not an inbound provider payload - so this isn't
  // "not wired up yet" like an unconfigured external provider, it's N/A.
  if (sourceType === "in_house") {
    return <span className="muted">n/a - runs on the in-house engine</span>;
  }
  // Chartink is the only provider with a real n8n workflow today - any
  // other external source name is valid to record (see the "External
  // source name" field), but has nothing to actually copy yet.
  if (sourceType.toLowerCase() !== "chartink") {
    return <span className="muted">no webhook wired up for "{sourceType}" yet</span>;
  }
  const { buy, sell } = chartinkWebhookUrls(strategyId);
  return (
    <div className="webhook-links">
      <WebhookLine label="BUY" url={buy} />
      <WebhookLine label="SELL" url={sell} />
    </div>
  );
}

function IndicatorsTab() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newIndicatorName, setNewIndicatorName] = useState("");
  const [newIndicatorPeriod, setNewIndicatorPeriod] = useState("14");
  const [newIndicatorSmaPeriod, setNewIndicatorSmaPeriod] = useState("9");
  const [creatingIndicator, setCreatingIndicator] = useState(false);
  const [deletingIndicatorId, setDeletingIndicatorId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchIndicators();
        if (!cancelled) setIndicators(data);
      } catch {
        // keep showing the last known indicators rather than clearing on a blip
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleCreateIndicator(e: React.FormEvent) {
    e.preventDefault();
    setCreatingIndicator(true);
    try {
      const created = await createIndicator({
        name: newIndicatorName,
        type: "rsi",
        params: { period: Number(newIndicatorPeriod), sma_period: Number(newIndicatorSmaPeriod) },
      });
      setIndicators((prev) => [created, ...prev]);
      setNewIndicatorName("");
      setNewIndicatorPeriod("14");
      setNewIndicatorSmaPeriod("9");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create indicator");
    } finally {
      setCreatingIndicator(false);
    }
  }

  async function handleDeleteIndicator(indicator: Indicator) {
    const confirmed = window.confirm(
      `Delete indicator "${indicator.name}"? Any strategy still referencing it will skip on its next engine tick instead of crashing, but won't produce signals until fixed.`,
    );
    if (!confirmed) return;
    setDeletingIndicatorId(indicator.id);
    try {
      await deleteIndicator(indicator.id);
      setIndicators((prev) => prev.filter((i) => i.id !== indicator.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete indicator");
    } finally {
      setDeletingIndicatorId(null);
    }
  }

  return (
    <section className="panel">
      <h2>Indicators</h2>
      <p className="hint">
        Reusable indicator definitions - define one (e.g. "RSI 14") once, reference it from any
        number of in-house strategies.
      </p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Params</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {indicators.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No indicators yet - create one below.
              </td>
            </tr>
          )}
          {indicators.map((ind) => (
            <tr key={ind.id}>
              <td className="symbol">{ind.name}</td>
              <td>{ind.type.toUpperCase()}</td>
              <td>{Object.entries(ind.params).map(([k, v]) => `${k}=${v}`).join(", ")}</td>
              <td className="edit-actions">
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => handleDeleteIndicator(ind)}
                  disabled={deletingIndicatorId === ind.id}
                  title={`Delete indicator "${ind.name}"`}
                  aria-label={`Delete indicator "${ind.name}"`}
                >
                  <TrashIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="strategy-form" onSubmit={handleCreateIndicator}>
        <label>
          Name
          <input
            value={newIndicatorName}
            onChange={(e) => setNewIndicatorName(e.target.value)}
            required
            placeholder="e.g. RSI 14"
          />
        </label>
        <label>
          Type
          <select value="rsi" disabled>
            <option value="rsi">RSI</option>
          </select>
        </label>
        <label>
          RSI period
          <input
            type="number"
            min="2"
            step="1"
            value={newIndicatorPeriod}
            onChange={(e) => setNewIndicatorPeriod(e.target.value)}
            required
          />
        </label>
        <label>
          Signal SMA period
          <input
            type="number"
            min="2"
            step="1"
            value={newIndicatorSmaPeriod}
            onChange={(e) => setNewIndicatorSmaPeriod(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={creatingIndicator || !newIndicatorName.trim()}>
          {creatingIndicator ? "Creating..." : "Create indicator"}
        </button>
      </form>
    </section>
  );
}

function StrategyManager() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [signals, setSignals] = useState<ProviderSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  // All/In-house/External filter over the fetched list - there's one
  // unified tab now, so this replaces the old per-tab server-side filter.
  const [sourceFilter, setSourceFilter] = useState<"all" | "in_house" | "external">("all");

  const [name, setName] = useState("");
  // 'in_house' vs 'external' - what used to be a fixed prop per tab is
  // now a field in the create form itself. externalSourceName is only
  // used when sourceKind==='external' - any provider name, not a fixed
  // list (see the backend's SourceType - free-form except 'in_house').
  const [sourceKind, setSourceKind] = useState<"in_house" | "external">("external");
  const [externalSourceName, setExternalSourceName] = useState("");
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const [instrumentType, setInstrumentType] = useState<InstrumentType>("spot");
  // Not named setInterval - that would shadow the global timer function
  // this component already uses for polling below.
  const [signalInterval, setSignalInterval] = useState<Interval | "">("");
  const [slMethod, setSlMethod] = useState<StopLossMethod | "">("");
  const [slInterval, setSlInterval] = useState<StopLossInterval | "">("");
  const [slPercent, setSlPercent] = useState("");
  const [targetPercent, setTargetPercent] = useState("");
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  const [segment, setSegment] = useState<Segment>("NSE");
  const [squareOffTime, setSquareOffTime] = useState(() => defaultSquareOffTime("intraday", "NSE") ?? "");
  // Tracks whether the user has hand-edited square-off time, so the
  // horizon/segment auto-default effect below stops overwriting it.
  const [squareOffTimeTouched, setSquareOffTimeTouched] = useState(false);
  // Optional per-strategy signal-acceptance window (e.g. 09:15-11:00) -
  // both-or-neither, every source_type, not gated behind in-house. See
  // Strategy's own comment in api.ts.
  const [activeFromTime, setActiveFromTime] = useState("");
  const [activeToTime, setActiveToTime] = useState("");
  // in_house only - see validate_in_house_fields on the backend. Which
  // indicator the rule uses - the signal SMA length lives on the
  // indicator itself (RsiParams.sma_period), not here.
  const [underlying, setUnderlying] = useState("");
  // 'symbol' (default): underlying is one traded symbol, as before.
  // 'universe': underlying instead picks an NSE index-constituent group
  // (see universes state below) - only valid for segment='NSE' +
  // instrument_type='spot'.
  const [underlyingType, setUnderlyingType] = useState<UnderlyingType>("symbol");
  const [selectedUniverse, setSelectedUniverse] = useState("");
  const [selectedIndicatorId, setSelectedIndicatorId] = useState("");
  // in_house only - which rule shape this strategy uses. Not editable
  // after creation (same pattern as source_type/exchange) - switching
  // shapes changes what stop_loss_method/interval even mean for the
  // strategy, see the backend's _breakout_stop_loss_fields.
  const [ruleType, setRuleType] = useState<"crossover" | "breakout" | "range_breakout">("crossover");
  // Breakout rule fields (in_house only, ruleType==="breakout") - see the
  // backend's BreakoutRuleConfig / app/domain/breakout.py.
  const [htfInterval, setHtfInterval] = useState<Interval>("15min");
  const [htfBreakoutPeriod, setHtfBreakoutPeriod] = useState("20");
  const [ltfInterval, setLtfInterval] = useState<Interval>("3min");
  const [ltfBreakoutPeriod, setLtfBreakoutPeriod] = useState("10");
  const [emaFilterEnabled, setEmaFilterEnabled] = useState(false);
  const [emaPeriod, setEmaPeriod] = useState("20");
  // Range-breakout rule field (in_house only, ruleType==="range_breakout") -
  // see the backend's RangeBreakoutRuleConfig / app/domain/range_breakout.py.
  const [rangeBreakoutPeriod, setRangeBreakoutPeriod] = useState("5");
  // in_house only - gates a crossover signal on the single-timeframe
  // market regime classifier (see the backend's app/domain/regime.py).
  const [regimeFilterEnabled, setRegimeFilterEnabled] = useState(false);
  // Which of the 5 sub-conditions must agree - defaults to all 5,
  // matching the backend's own default.
  const [regimeFilterChecks, setRegimeFilterChecks] = useState<RegimeCheckName[]>(ALL_REGIME_CHECKS);
  const [dupPolicy, setDupPolicy] = useState<DuplicateSignalPolicy>("add_position");
  const [counterPolicy, setCounterPolicy] = useState<CounterSignalPolicy>("skip");
  const [creating, setCreating] = useState(false);

  // Indicators are their own entity, shared across all in_house
  // strategies - fetched once here (only meaningful on the in_house tab).
  // Read-only here (used by the create form's indicator picker and
  // ruleSummary below) - full CRUD lives in IndicatorsTab now.
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  // NSE index-constituent universe keys (e.g. "NIFTYBANK") - fetched once,
  // shared across all in_house strategies, same lifecycle as indicators.
  const [universes, setUniverses] = useState<string[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editHorizon, setEditHorizon] = useState<Horizon>("intraday");
  const [editInstrumentType, setEditInstrumentType] = useState<InstrumentType>("spot");
  const [editInterval, setEditInterval] = useState<Interval | "">("");
  const [editSlMethod, setEditSlMethod] = useState<StopLossMethod | "">("");
  const [editSlInterval, setEditSlInterval] = useState<StopLossInterval | "">("");
  const [editSlPercent, setEditSlPercent] = useState("");
  const [editTargetPercent, setEditTargetPercent] = useState("");
  const [editTrailingEnabled, setEditTrailingEnabled] = useState(false);
  const [editSegment, setEditSegment] = useState<Segment>("NSE");
  const [editSquareOffTime, setEditSquareOffTime] = useState("");
  const [editActiveFromTime, setEditActiveFromTime] = useState("");
  const [editActiveToTime, setEditActiveToTime] = useState("");
  // in_house only - which indicator the rule references, freely editable
  // (the backend already supports this via PATCH; underlying stays
  // locked - swapping the traded symbol is a bigger change than
  // switching which indicator drives the rule). The signal SMA length
  // itself lives on the indicator (edit the Indicator, not the strategy).
  const [editIndicatorId, setEditIndicatorId] = useState("");
  // Breakout rule fields - editable (unlike the rule TYPE itself, which
  // isn't switchable after creation, same as source_type/exchange).
  const [editHtfInterval, setEditHtfInterval] = useState<Interval>("15min");
  const [editHtfBreakoutPeriod, setEditHtfBreakoutPeriod] = useState("20");
  const [editLtfInterval, setEditLtfInterval] = useState<Interval>("3min");
  const [editLtfBreakoutPeriod, setEditLtfBreakoutPeriod] = useState("10");
  const [editEmaFilterEnabled, setEditEmaFilterEnabled] = useState(false);
  const [editEmaPeriod, setEditEmaPeriod] = useState("20");
  // Range-breakout rule field - editable, same as the breakout fields above.
  const [editRangeBreakoutPeriod, setEditRangeBreakoutPeriod] = useState("5");
  const [editRegimeFilterEnabled, setEditRegimeFilterEnabled] = useState(false);
  const [editRegimeFilterChecks, setEditRegimeFilterChecks] = useState<RegimeCheckName[]>(ALL_REGIME_CHECKS);
  const [editDupPolicy, setEditDupPolicy] = useState<DuplicateSignalPolicy>("add_position");
  const [editCounterPolicy, setEditCounterPolicy] = useState<CounterSignalPolicy>("skip");
  const [saving, setSaving] = useState(false);

  const [backtestFrom, setBacktestFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [backtestTo, setBacktestTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [backtestResult, setBacktestResult] = useState<BacktestResult | UniverseBacktestResult | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // Grid search: sweeps the selected strategy's indicator params over
  // comma-separated candidate lists - a param left blank stays fixed at
  // the indicator's own current value (see handleGridSearch).
  const [gridPeriodValues, setGridPeriodValues] = useState("");
  const [gridSmaPeriodValues, setGridSmaPeriodValues] = useState("");
  const [gridResult, setGridResult] = useState<GridBacktestResult | null>(null);
  const [gridSearching, setGridSearching] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);

  // Suggests a square-off time whenever horizon/segment change in the
  // create form - only while the user hasn't hand-edited the field
  // themselves. Mirrors the backend's own default_square_off_time, which
  // is what actually gets enforced if this is left blank.
  useEffect(() => {
    if (squareOffTimeTouched) return;
    setSquareOffTime(defaultSquareOffTime(horizon, segment) ?? "");
  }, [horizon, segment, squareOffTimeTouched]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchStrategies();
        if (!cancelled) {
          setStrategies(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load strategies");
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    setBacktestResult(null);
    setBacktestError(null);
    setGridResult(null);
    setGridError(null);
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchIndicators();
        if (!cancelled) setIndicators(data);
      } catch {
        // keep showing the last known indicators rather than clearing on a blip
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUniverses()
      .then((data) => {
        if (!cancelled) setUniverses(data);
      })
      .catch(() => {
        // keep the picker empty rather than blocking the tab on a market-data blip
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setSignals([]);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchSignalsForStrategy(selected as string);
        if (!cancelled) setSignals(data);
      } catch {
        // keep showing the last known signals rather than clearing on a blip
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selected]);

  const createIsInHouse = sourceKind === "in_house";
  const selectedStrategy = strategies.find((s) => s.id === selected);
  const selectedIsInHouse = selectedStrategy?.source_type === "in_house";
  const filteredStrategies = strategies.filter((s) => {
    if (sourceFilter === "all") return true;
    const strategyIsInHouse = s.source_type === "in_house";
    return sourceFilter === "in_house" ? strategyIsInHouse : !strategyIsInHouse;
  });
  const selectedRuleConfig = selectedStrategy?.rule_config;
  const selectedIndicator =
    selectedRuleConfig?.type === "crossover" ? indicators.find((i) => i.id === selectedRuleConfig.indicator_id) : undefined;
  const selectedIsBreakout = selectedRuleConfig?.type === "breakout";
  const selectedIsRangeBreakout = selectedRuleConfig?.type === "range_breakout";

  function ruleSummary(s: Strategy): string {
    const ruleConfig = s.rule_config;
    if (!ruleConfig) return "";
    const checkCount = s.regime_filter_checks?.length ?? ALL_REGIME_CHECKS.length;
    const regimeSuffix = s.regime_filter_enabled
      ? `, regime-filtered${checkCount < ALL_REGIME_CHECKS.length ? ` (${checkCount}/${ALL_REGIME_CHECKS.length})` : ""}`
      : "";

    if (ruleConfig.type === "breakout") {
      const emaSuffix = ruleConfig.ema_filter_enabled ? `, EMA${ruleConfig.ema_period} filter` : "";
      return ` - ${ruleConfig.htf_interval}(N=${ruleConfig.htf_breakout_period}) -> ${ruleConfig.ltf_interval}(N=${ruleConfig.ltf_breakout_period})${emaSuffix}${regimeSuffix}`;
    }

    if (ruleConfig.type === "range_breakout") {
      return ` - close beyond last ${ruleConfig.breakout_period} candles' high/low${regimeSuffix}`;
    }

    const indicator = indicators.find((i) => i.id === ruleConfig.indicator_id);
    if (!indicator) return ` - unknown indicator (${ruleConfig.indicator_id.slice(0, 8)}...)${regimeSuffix}`;
    // sma_period lives on the indicator itself now, not the rule.
    const smaPeriod = "sma_period" in indicator.params ? indicator.params.sma_period : "?";
    return ` - ${indicator.name} crosses its own SMA(${smaPeriod})${regimeSuffix}`;
  }

  const isBreakout = createIsInHouse && ruleType === "breakout";
  const isRangeBreakout = createIsInHouse && ruleType === "range_breakout";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (horizon === "intraday" && !squareOffTime) return; // required for intraday - submit is disabled without it, this is just a guard
    setCreating(true);
    try {
      const ruleConfig = createIsInHouse
        ? isBreakout
          ? {
              type: "breakout" as const,
              htf_interval: htfInterval,
              htf_breakout_period: Number(htfBreakoutPeriod),
              ltf_interval: ltfInterval,
              ltf_breakout_period: Number(ltfBreakoutPeriod),
              ema_filter_enabled: emaFilterEnabled,
              ema_period: Number(emaPeriod),
            }
          : isRangeBreakout
            ? { type: "range_breakout" as const, breakout_period: Number(rangeBreakoutPeriod) }
            : { type: "crossover" as const, indicator_id: selectedIndicatorId }
        : undefined;
      const created = await createStrategy({
        name,
        source_type: createIsInHouse ? "in_house" : externalSourceName.trim(),
        horizon,
        instrument_type: instrumentType,
        // Interval is signal-filter criteria - only meaningful (and
        // required, see validate_in_house_fields on the backend) for an
        // in-house rule. A breakout strategy's interval is derived from
        // its own ltf_interval (the backend requires them to match).
        interval: createIsInHouse ? (isBreakout ? ltfInterval : signalInterval || undefined) : undefined,
        stop_loss_method: slMethod || undefined,
        stop_loss_interval: slMethod === "previous_candle" ? slInterval || undefined : undefined,
        stop_loss_percent: slMethod === "percent" && slPercent ? Number(slPercent) : undefined,
        target_percent: targetPercent ? Number(targetPercent) : undefined,
        trailing_stop_enabled: slMethod ? trailingEnabled : undefined,
        segment,
        square_off_time: horizon === "intraday" ? `${squareOffTime}:00` : undefined,
        underlying: createIsInHouse ? (underlyingType === "universe" ? selectedUniverse : underlying) || undefined : undefined,
        underlying_type: createIsInHouse ? underlyingType : undefined,
        rule_config: ruleConfig,
        regime_filter_enabled: createIsInHouse ? regimeFilterEnabled : undefined,
        regime_filter_checks: createIsInHouse ? regimeFilterChecks : undefined,
        duplicate_signal_policy: dupPolicy,
        counter_signal_policy: counterPolicy,
        active_from_time: activeFromTime && activeToTime ? `${activeFromTime}:00` : undefined,
        active_to_time: activeFromTime && activeToTime ? `${activeToTime}:00` : undefined,
      });
      setName("");
      setSourceKind("external");
      setExternalSourceName("");
      setSlMethod("");
      setSlInterval("");
      setSlPercent("");
      setTargetPercent("");
      setTrailingEnabled(false);
      setSegment("NSE");
      setSquareOffTime(defaultSquareOffTime(horizon, "NSE") ?? "");
      setSquareOffTimeTouched(false);
      setActiveFromTime("");
      setActiveToTime("");
      setUnderlying("");
      setUnderlyingType("symbol");
      setSelectedUniverse("");
      setSelectedIndicatorId("");
      setRegimeFilterEnabled(false);
      setRegimeFilterChecks(ALL_REGIME_CHECKS);
      setDupPolicy("add_position");
      setCounterPolicy("skip");
      setStrategies((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create strategy");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleStatus(s: Strategy) {
    const next: StrategyStatus = s.status === "live" ? "paused" : "live";
    try {
      const updated = await updateStrategy(s.id, { status: next });
      setStrategies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update strategy");
    }
  }

  function handleStartEdit(s: Strategy) {
    setEditingId(s.id);
    setEditName(s.name);
    setEditHorizon(s.horizon);
    setEditInstrumentType(s.instrument_type);
    setEditInterval(s.interval ?? "");
    setEditSlMethod(s.stop_loss_method ?? "");
    setEditSlInterval(s.stop_loss_interval ?? "");
    setEditSlPercent(s.stop_loss_percent != null ? String(s.stop_loss_percent) : "");
    setEditTargetPercent(s.target_percent != null ? String(s.target_percent) : "");
    setEditTrailingEnabled(s.trailing_stop_enabled);
    setEditSegment(s.segment);
    setEditSquareOffTime(s.square_off_time ? s.square_off_time.slice(0, 5) : "");
    setEditActiveFromTime(s.active_from_time ? s.active_from_time.slice(0, 5) : "");
    setEditActiveToTime(s.active_to_time ? s.active_to_time.slice(0, 5) : "");
    if (s.rule_config?.type === "breakout") {
      setEditHtfInterval(s.rule_config.htf_interval);
      setEditHtfBreakoutPeriod(String(s.rule_config.htf_breakout_period));
      setEditLtfInterval(s.rule_config.ltf_interval);
      setEditLtfBreakoutPeriod(String(s.rule_config.ltf_breakout_period));
      setEditEmaFilterEnabled(s.rule_config.ema_filter_enabled);
      setEditEmaPeriod(String(s.rule_config.ema_period));
    } else if (s.rule_config?.type === "range_breakout") {
      setEditRangeBreakoutPeriod(String(s.rule_config.breakout_period));
    } else {
      setEditIndicatorId(s.rule_config?.indicator_id ?? "");
    }
    setEditRegimeFilterEnabled(s.regime_filter_enabled);
    setEditRegimeFilterChecks(s.regime_filter_checks);
    setEditDupPolicy(s.duplicate_signal_policy);
    setEditCounterPolicy(s.counter_signal_policy);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      const editingStrategy = strategies.find((s) => s.id === id);
      const editingIsInHouse = editingStrategy?.source_type === "in_house";
      const editingIsBreakout = editingStrategy?.rule_config?.type === "breakout";
      const editingIsRangeBreakout = editingStrategy?.rule_config?.type === "range_breakout";
      const ruleConfig = editingIsBreakout
        ? {
            type: "breakout" as const,
            htf_interval: editHtfInterval,
            htf_breakout_period: Number(editHtfBreakoutPeriod),
            ltf_interval: editLtfInterval,
            ltf_breakout_period: Number(editLtfBreakoutPeriod),
            ema_filter_enabled: editEmaFilterEnabled,
            ema_period: Number(editEmaPeriod),
          }
        : editingIsRangeBreakout
          ? { type: "range_breakout" as const, breakout_period: Number(editRangeBreakoutPeriod) }
          : editingIsInHouse && editIndicatorId
            ? { type: "crossover" as const, indicator_id: editIndicatorId }
            : undefined;
      const updated = await updateStrategy(id, {
        name: editName,
        horizon: editHorizon,
        instrument_type: editInstrumentType,
        // A breakout strategy's `interval` is derived from its own
        // ltf_interval (see the backend's _breakout_stop_loss_fields,
        // which requires them to match) rather than edited directly.
        interval: editingIsBreakout ? editLtfInterval : editInterval || null,
        stop_loss_method: editSlMethod || undefined,
        stop_loss_interval: editSlMethod === "previous_candle" ? editSlInterval || undefined : undefined,
        stop_loss_percent: editSlMethod === "percent" && editSlPercent ? Number(editSlPercent) : undefined,
        target_percent: editTargetPercent ? Number(editTargetPercent) : undefined,
        trailing_stop_enabled: editSlMethod ? editTrailingEnabled : undefined,
        segment: editSegment,
        square_off_time: editHorizon === "intraday" && editSquareOffTime ? `${editSquareOffTime}:00` : undefined,
        rule_config: ruleConfig,
        regime_filter_enabled: editingIsInHouse ? editRegimeFilterEnabled : undefined,
        regime_filter_checks: editingIsInHouse ? editRegimeFilterChecks : undefined,
        duplicate_signal_policy: editDupPolicy,
        counter_signal_policy: editCounterPolicy,
        active_from_time: editActiveFromTime && editActiveToTime ? `${editActiveFromTime}:00` : undefined,
        active_to_time: editActiveFromTime && editActiveToTime ? `${editActiveToTime}:00` : undefined,
      });
      setStrategies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update strategy");
    } finally {
      setSaving(false);
    }
  }

  async function handleBacktest() {
    if (!selected) return;
    setBacktesting(true);
    setBacktestError(null);
    setBacktestResult(null);
    try {
      const result = await backtestStrategy(selected, backtestFrom, backtestTo);
      setBacktestResult(result);
    } catch (err) {
      setBacktestError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setBacktesting(false);
    }
  }

  function parseGridValues(raw: string): number[] {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }

  async function handleGridSearch() {
    if (!selected) return;
    const paramGrid: Record<string, number[]> = {};
    const periodValues = parseGridValues(gridPeriodValues);
    if (periodValues.length > 0) paramGrid.period = periodValues;
    const smaPeriodValues = parseGridValues(gridSmaPeriodValues);
    if (smaPeriodValues.length > 0) paramGrid.sma_period = smaPeriodValues;

    if (Object.keys(paramGrid).length === 0) {
      setGridError("Enter candidate values for at least one param (Period and/or SMA period)");
      return;
    }

    setGridSearching(true);
    setGridError(null);
    setGridResult(null);
    try {
      const result = await backtestStrategyGrid(selected, backtestFrom, backtestTo, paramGrid);
      setGridResult(result);
    } catch (err) {
      setGridError(err instanceof Error ? err.message : "Grid search failed");
    } finally {
      setGridSearching(false);
    }
  }

  async function handleDelete(s: Strategy) {
    const confirmed = window.confirm(
      `Delete strategy "${s.name}"? Its webhook URLs will stop working immediately. Past signals/positions keep their history.`,
    );
    if (!confirmed) return;
    try {
      await deleteStrategy(s.id);
      setStrategies((prev) => prev.filter((x) => x.id !== s.id));
      setSelected((prev) => (prev === s.id ? null : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete strategy");
    }
  }

  const nonDefaultConfig = horizon !== "intraday" || instrumentType !== "spot";
  // Name, Status, Source, Horizon, Instrument, Interval, Stop-loss,
  // Target, Segment, Underlying/Rule, Square-off, Active window,
  // Webhooks, actions - matches the <thead> below exactly (all columns
  // always present now, one unified table for every source type).
  const colCount = 14;

  return (
    <>
      <section className="panel">
        <h2>New strategy</h2>
        <form className="strategy-form" onSubmit={handleCreate}>
          <label>
            Source
            <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as "in_house" | "external")}>
              <option value="external">External (webhook)</option>
              <option value="in_house">In-house</option>
            </select>
          </label>
          {sourceKind === "external" && (
            <label>
              External source name
              <input
                value={externalSourceName}
                onChange={(e) => setExternalSourceName(e.target.value)}
                required
                placeholder="e.g. chartink, tradingview"
              />
            </label>
          )}
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Bullish Breakout v1" />
          </label>
          <label>
            Horizon
            <select value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
              <option value="intraday">Intraday</option>
              <option value="swing">Swing</option>
              <option value="positional">Positional</option>
            </select>
          </label>
          <label>
            Instrument
            <select value={instrumentType} onChange={(e) => setInstrumentType(e.target.value as InstrumentType)}>
              <option value="spot">Spot</option>
              <option value="future">Future</option>
              <option value="option">Option</option>
            </select>
          </label>
          <label>
            Stop-loss <span className="optional">(optional)</span>
            <select value={slMethod} onChange={(e) => setSlMethod(e.target.value as StopLossMethod | "")}>
              <option value="">&mdash;</option>
              <option value="previous_candle">Previous candle low/high</option>
              <option value="percent">% from entry</option>
            </select>
          </label>
          {slMethod === "previous_candle" && (
            <label>
              SL candle interval
              <select value={slInterval} onChange={(e) => setSlInterval(e.target.value as StopLossInterval | "")}>
                <option value="">&mdash;</option>
                <option value="1min">1 min</option>
                <option value="5min">5 min</option>
                <option value="15min">15 min</option>
                <option value="25min">25 min</option>
                <option value="60min">60 min</option>
              </select>
            </label>
          )}
          {slMethod === "percent" && (
            <label>
              SL %
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={slPercent}
                onChange={(e) => setSlPercent(e.target.value)}
                placeholder="e.g. 2"
              />
            </label>
          )}
          <label>
            Target % <span className="optional">(optional)</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={targetPercent}
              onChange={(e) => setTargetPercent(e.target.value)}
              placeholder="e.g. 4"
            />
          </label>
          {slMethod && (
            <label className="checkbox-label">
              <input type="checkbox" checked={trailingEnabled} onChange={(e) => setTrailingEnabled(e.target.checked)} />
              Trailing stop-loss
            </label>
          )}
          <label>
            Segment
            <select value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
              <option value="NSE">NSE</option>
              <option value="MCX">MCX</option>
              <option value="CRYPTO">Crypto</option>
            </select>
          </label>
          <label>
            Same-direction signal
            <select value={dupPolicy} onChange={(e) => setDupPolicy(e.target.value as DuplicateSignalPolicy)}>
              <option value="add_position">Add position (pyramid)</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <label>
            Counter-signal
            <select value={counterPolicy} onChange={(e) => setCounterPolicy(e.target.value as CounterSignalPolicy)}>
              <option value="skip">Skip (leave existing position open)</option>
              <option value="close_and_flip">Close and flip</option>
            </select>
          </label>
          {createIsInHouse && (
            <>
              {ruleType !== "breakout" && (
                <label>
                  Interval
                  <select value={signalInterval} onChange={(e) => setSignalInterval(e.target.value as Interval | "")} required>
                    <option value="">&mdash;</option>
                    <option value="1min">1 min</option>
                    <option value="3min">3 min</option>
                    <option value="5min">5 min</option>
                    <option value="15min">15 min</option>
                    <option value="30min">30 min</option>
                    <option value="60min">60 min</option>
                    <option value="daily">Daily</option>
                  </select>
                </label>
              )}
              <label>
                Underlying type
                <select value={underlyingType} onChange={(e) => setUnderlyingType(e.target.value as UnderlyingType)}>
                  <option value="symbol">Single symbol</option>
                  <option value="universe">Universe (NSE index constituents)</option>
                </select>
              </label>
              {underlyingType === "universe" ? (
                <label>
                  Universe
                  <select value={selectedUniverse} onChange={(e) => setSelectedUniverse(e.target.value)} required>
                    <option value="">&mdash;</option>
                    {universes.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  Underlying
                  <input
                    value={underlying}
                    onChange={(e) => setUnderlying(e.target.value.toUpperCase())}
                    required
                    placeholder="e.g. GOLDM, NIFTY"
                  />
                </label>
              )}
              <label>
                Rule type
                <select
                  value={ruleType}
                  onChange={(e) => setRuleType(e.target.value as "crossover" | "breakout" | "range_breakout")}
                >
                  <option value="crossover">Crossover (indicator)</option>
                  <option value="breakout">Breakout (multi-timeframe)</option>
                  <option value="range_breakout">Range breakout (single timeframe)</option>
                </select>
              </label>
              {isBreakout ? (
                <>
                  <label>
                    HTF interval
                    <select value={htfInterval} onChange={(e) => setHtfInterval(e.target.value as Interval)}>
                      <option value="1min">1 min</option>
                      <option value="3min">3 min</option>
                      <option value="5min">5 min</option>
                      <option value="15min">15 min</option>
                      <option value="30min">30 min</option>
                      <option value="60min">60 min</option>
                    </select>
                  </label>
                  <label>
                    HTF breakout N
                    <input
                      type="number"
                      min="2"
                      value={htfBreakoutPeriod}
                      onChange={(e) => setHtfBreakoutPeriod(e.target.value)}
                    />
                  </label>
                  <label>
                    LTF interval
                    <select value={ltfInterval} onChange={(e) => setLtfInterval(e.target.value as Interval)}>
                      <option value="1min">1 min</option>
                      <option value="3min">3 min</option>
                      <option value="5min">5 min</option>
                      <option value="15min">15 min</option>
                      <option value="30min">30 min</option>
                      <option value="60min">60 min</option>
                    </select>
                  </label>
                  <label>
                    LTF breakout N
                    <input
                      type="number"
                      min="2"
                      value={ltfBreakoutPeriod}
                      onChange={(e) => setLtfBreakoutPeriod(e.target.value)}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={emaFilterEnabled}
                      onChange={(e) => setEmaFilterEnabled(e.target.checked)}
                    />
                    HTF EMA filter
                  </label>
                  {emaFilterEnabled && (
                    <label>
                      EMA period
                      <input type="number" min="2" value={emaPeriod} onChange={(e) => setEmaPeriod(e.target.value)} />
                    </label>
                  )}
                </>
              ) : isRangeBreakout ? (
                <label>
                  Breakout N (candles)
                  <input
                    type="number"
                    min="2"
                    value={rangeBreakoutPeriod}
                    onChange={(e) => setRangeBreakoutPeriod(e.target.value)}
                  />
                </label>
              ) : (
                <label>
                  Indicator
                  <select value={selectedIndicatorId} onChange={(e) => setSelectedIndicatorId(e.target.value)} required>
                    <option value="">&mdash;</option>
                    {indicators.map((ind) => (
                      <option key={ind.id} value={ind.id}>
                        {ind.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={regimeFilterEnabled}
                  onChange={(e) => setRegimeFilterEnabled(e.target.checked)}
                />
                Regime filter (only trade with the trend)
              </label>
              {regimeFilterEnabled && (
                <div className="regime-checks">
                  {ALL_REGIME_CHECKS.map((check) => (
                    <label key={check} className="checkbox-label tiny">
                      <input
                        type="checkbox"
                        checked={regimeFilterChecks.includes(check)}
                        onChange={() => setRegimeFilterChecks((prev) => toggleRegimeCheck(prev, check))}
                      />
                      {REGIME_CHECK_LABELS[check]}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          {horizon === "intraday" && (
            <label>
              Square-off time
              <input
                type="time"
                value={squareOffTime}
                onChange={(e) => {
                  setSquareOffTime(e.target.value);
                  setSquareOffTimeTouched(true);
                }}
                required
              />
            </label>
          )}
          <label>
            Active from <span className="optional">(optional)</span>
            <input type="time" value={activeFromTime} onChange={(e) => setActiveFromTime(e.target.value)} />
          </label>
          <label>
            Active to <span className="optional">(optional)</span>
            <input type="time" value={activeToTime} onChange={(e) => setActiveToTime(e.target.value)} />
          </label>
          <button
            type="submit"
            disabled={
              creating ||
              !name.trim() ||
              (horizon === "intraday" && !squareOffTime) ||
              (!createIsInHouse && !externalSourceName.trim()) ||
              (createIsInHouse && ruleType !== "breakout" && !signalInterval) ||
              (createIsInHouse && underlyingType === "symbol" && !underlying.trim()) ||
              (createIsInHouse && underlyingType === "universe" && !selectedUniverse) ||
              (createIsInHouse && !isBreakout && !isRangeBreakout && !selectedIndicatorId) ||
              (!!activeFromTime !== !!activeToTime) ||
              (activeFromTime !== "" && activeToTime !== "" && activeToTime <= activeFromTime)
            }
          >
            {creating ? "Creating..." : "Create strategy"}
          </button>
        </form>
        {nonDefaultConfig && (
          <p className="hint">
            Only intraday + spot/future is handled end-to-end by execution today - this will still resolve and
            publish, but execution will reject anything else with "unsupported horizon/instrument_type".
          </p>
        )}
        <p className="hint">
          New strategies start as <strong>draft</strong> - webhook URLs work immediately, but signal-processing
          rejects signals from a non-live strategy. Activate it once you've verified the URL is wired up
          correctly.
        </p>
        <p className="hint">
          No capital/quantity setting here - execution still sizes every position from its own capital_per_trade
          and risk_per_trade_pct settings. Stop-loss/target here just supply the stop distance; configure the
          capital and risk % in execution's frontend, not here.
        </p>
        <p className="hint">
          Once a stop-loss method is set it can be switched (e.g. previous-candle to %) but not cleared back to
          &mdash; same limitation as Interval. Delete and recreate the strategy if you need to remove it entirely.
        </p>
        <p className="hint">
          Square-off time only applies to intraday strategies - it appears (and is required) once Horizon is
          Intraday, auto-filled from Segment (15:00 NSE, 22:00 MCX, 17:25 Crypto) but still overridable. Swing/
          positional strategies don't square off same-day, so there's nothing to set.
        </p>
      </section>

      {error && <p className="error">{error}</p>}

      <label className="inline-filter">
        Show
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as "all" | "in_house" | "external")}>
          <option value="all">All</option>
          <option value="in_house">In-house</option>
          <option value="external">External</option>
        </select>
      </label>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Source</th>
            <th>Horizon</th>
            <th>Instrument</th>
            <th>Interval</th>
            <th>Stop-loss</th>
            <th>Target</th>
            <th>Segment</th>
            <th>Underlying / Rule</th>
            <th>Square-off</th>
            <th>Active window</th>
            <th>Webhooks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredStrategies.length === 0 && (
            <tr>
              <td colSpan={colCount} className="empty">
                {strategies.length === 0 ? "No strategies yet - create one above." : "No strategies match this filter."}
              </td>
            </tr>
          )}
          {filteredStrategies.map((s) =>
            editingId === s.id ? (
              <tr key={s.id} className="editing-row" onClick={(e) => e.stopPropagation()}>
                <td>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="cell-input" />
                </td>
                <td>
                  <span className={`status-pill status-${s.status}`}>{s.status}</span>
                </td>
                <td className="muted">{s.source_type === "in_house" ? "In-house" : s.source_type}</td>
                <td>
                  <select value={editHorizon} onChange={(e) => setEditHorizon(e.target.value as Horizon)} className="cell-input">
                    <option value="intraday">Intraday</option>
                    <option value="swing">Swing</option>
                    <option value="positional">Positional</option>
                  </select>
                </td>
                <td>
                  <select
                    value={editInstrumentType}
                    onChange={(e) => setEditInstrumentType(e.target.value as InstrumentType)}
                    className="cell-input"
                  >
                    <option value="spot">Spot</option>
                    <option value="future">Future</option>
                    <option value="option">Option</option>
                  </select>
                </td>
                <td>
                  <select
                    value={editInterval}
                    onChange={(e) => setEditInterval(e.target.value as Interval | "")}
                    className="cell-input"
                  >
                    <option value="">&mdash;</option>
                    <option value="1min">1 min</option>
                    <option value="3min">3 min</option>
                    <option value="5min">5 min</option>
                    <option value="15min">15 min</option>
                    <option value="30min">30 min</option>
                    <option value="60min">60 min</option>
                    <option value="daily">Daily</option>
                  </select>
                </td>
                <td>
                  <div className="stack-cell">
                    <select
                      value={editSlMethod}
                      onChange={(e) => setEditSlMethod(e.target.value as StopLossMethod | "")}
                      className="cell-input"
                    >
                      <option value="">&mdash;</option>
                      <option value="previous_candle">Prev candle</option>
                      <option value="percent">%</option>
                    </select>
                    {editSlMethod === "previous_candle" && (
                      <select
                        value={editSlInterval}
                        onChange={(e) => setEditSlInterval(e.target.value as StopLossInterval | "")}
                        className="cell-input"
                      >
                        <option value="">&mdash;</option>
                        <option value="1min">1 min</option>
                        <option value="5min">5 min</option>
                        <option value="15min">15 min</option>
                        <option value="25min">25 min</option>
                        <option value="60min">60 min</option>
                      </select>
                    )}
                    {editSlMethod === "percent" && (
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={editSlPercent}
                        onChange={(e) => setEditSlPercent(e.target.value)}
                        className="cell-input"
                        placeholder="%"
                      />
                    )}
                    {editSlMethod && (
                      <label className="checkbox-label tiny">
                        <input
                          type="checkbox"
                          checked={editTrailingEnabled}
                          onChange={(e) => setEditTrailingEnabled(e.target.checked)}
                        />
                        Trailing
                      </label>
                    )}
                  </div>
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={editTargetPercent}
                    onChange={(e) => setEditTargetPercent(e.target.value)}
                    className="cell-input"
                    placeholder="%"
                  />
                </td>
                <td>
                  <div className="stack-cell">
                    <select
                      value={editSegment}
                      onChange={(e) => setEditSegment(e.target.value as Segment)}
                      className="cell-input"
                    >
                      <option value="NSE">NSE</option>
                      <option value="MCX">MCX</option>
                      <option value="CRYPTO">Crypto</option>
                    </select>
                    <select
                      value={editDupPolicy}
                      onChange={(e) => setEditDupPolicy(e.target.value as DuplicateSignalPolicy)}
                      className="cell-input"
                      title="Same-direction signal"
                    >
                      <option value="add_position">Add position</option>
                      <option value="skip">Skip</option>
                    </select>
                    <select
                      value={editCounterPolicy}
                      onChange={(e) => setEditCounterPolicy(e.target.value as CounterSignalPolicy)}
                      className="cell-input"
                      title="Counter-signal"
                    >
                      <option value="skip">Counter: skip</option>
                      <option value="close_and_flip">Counter: close &amp; flip</option>
                    </select>
                  </div>
                </td>
                <td>
                  {s.source_type !== "in_house" ? (
                    <span className="muted">-</span>
                  ) : (
                    <div className="stack-cell">
                      <span className="muted">{s.underlying}</span>
                      {s.rule_config?.type === "breakout" ? (
                        <>
                          <div className="regime-checks" style={{ marginLeft: 0 }}>
                            <select
                              value={editHtfInterval}
                              onChange={(e) => setEditHtfInterval(e.target.value as Interval)}
                              className="cell-input"
                            >
                              <option value="1min">1m</option>
                              <option value="3min">3m</option>
                              <option value="5min">5m</option>
                              <option value="15min">15m</option>
                              <option value="30min">30m</option>
                              <option value="60min">60m</option>
                            </select>
                            <input
                              type="number"
                              min="2"
                              value={editHtfBreakoutPeriod}
                              onChange={(e) => setEditHtfBreakoutPeriod(e.target.value)}
                              className="cell-input"
                              style={{ width: "3.5rem" }}
                              title="HTF breakout N"
                            />
                          </div>
                          <div className="regime-checks" style={{ marginLeft: 0 }}>
                            <select
                              value={editLtfInterval}
                              onChange={(e) => setEditLtfInterval(e.target.value as Interval)}
                              className="cell-input"
                            >
                              <option value="1min">1m</option>
                              <option value="3min">3m</option>
                              <option value="5min">5m</option>
                              <option value="15min">15m</option>
                              <option value="30min">30m</option>
                              <option value="60min">60m</option>
                            </select>
                            <input
                              type="number"
                              min="2"
                              value={editLtfBreakoutPeriod}
                              onChange={(e) => setEditLtfBreakoutPeriod(e.target.value)}
                              className="cell-input"
                              style={{ width: "3.5rem" }}
                              title="LTF breakout N"
                            />
                          </div>
                          <label className="checkbox-label tiny">
                            <input
                              type="checkbox"
                              checked={editEmaFilterEnabled}
                              onChange={(e) => setEditEmaFilterEnabled(e.target.checked)}
                            />
                            EMA filter
                          </label>
                          {editEmaFilterEnabled && (
                            <input
                              type="number"
                              min="2"
                              value={editEmaPeriod}
                              onChange={(e) => setEditEmaPeriod(e.target.value)}
                              className="cell-input"
                              style={{ width: "3.5rem" }}
                              title="EMA period"
                            />
                          )}
                        </>
                      ) : s.rule_config?.type === "range_breakout" ? (
                        <input
                          type="number"
                          min="2"
                          value={editRangeBreakoutPeriod}
                          onChange={(e) => setEditRangeBreakoutPeriod(e.target.value)}
                          className="cell-input"
                          style={{ width: "3.5rem" }}
                          title="Breakout N (candles)"
                        />
                      ) : (
                        <select
                          value={editIndicatorId}
                          onChange={(e) => setEditIndicatorId(e.target.value)}
                          className="cell-input"
                        >
                          <option value="">&mdash;</option>
                          {indicators.map((ind) => (
                            <option key={ind.id} value={ind.id}>
                              {ind.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={editRegimeFilterEnabled}
                          onChange={(e) => setEditRegimeFilterEnabled(e.target.checked)}
                        />
                        Regime filter
                      </label>
                      {editRegimeFilterEnabled && (
                        <div className="regime-checks">
                          {ALL_REGIME_CHECKS.map((check) => (
                            <label key={check} className="checkbox-label tiny">
                              <input
                                type="checkbox"
                                checked={editRegimeFilterChecks.includes(check)}
                                onChange={() => setEditRegimeFilterChecks((prev) => toggleRegimeCheck(prev, check))}
                              />
                              {REGIME_CHECK_LABELS[check]}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  {editHorizon === "intraday" ? (
                    <input
                      type="time"
                      value={editSquareOffTime}
                      onChange={(e) => setEditSquareOffTime(e.target.value)}
                      className="cell-input"
                    />
                  ) : (
                    <span className="muted">n/a</span>
                  )}
                </td>
                <td className="stack-cell">
                  <input
                    type="time"
                    value={editActiveFromTime}
                    onChange={(e) => setEditActiveFromTime(e.target.value)}
                    className="cell-input"
                  />
                  <input
                    type="time"
                    value={editActiveToTime}
                    onChange={(e) => setEditActiveToTime(e.target.value)}
                    className="cell-input"
                  />
                </td>
                <td />
                <td className="edit-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleSaveEdit(s.id)}
                    disabled={
                      saving ||
                      !editName.trim() ||
                      !!editActiveFromTime !== !!editActiveToTime ||
                      (editActiveFromTime !== "" && editActiveToTime !== "" && editActiveToTime <= editActiveFromTime)
                    }
                    title="Save changes"
                    aria-label="Save changes"
                  >
                    <CheckIcon />
                  </button>
                  <button type="button" className="icon-btn" onClick={handleCancelEdit} title="Cancel" aria-label="Cancel edit">
                    <XIcon />
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={s.id} className={s.id === selected ? "selected-row" : ""} onClick={() => setSelected(s.id)}>
                <td className="symbol">{s.name}</td>
                <td>
                  <span className={`status-pill status-${s.status}`}>{s.status}</span>{" "}
                  <button
                    type="button"
                    className="tiny secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleStatus(s);
                    }}
                  >
                    {s.status === "live" ? "Pause" : "Activate"}
                  </button>
                </td>
                <td className="muted">{s.source_type === "in_house" ? "In-house" : s.source_type}</td>
                <td>{s.horizon}</td>
                <td>{s.instrument_type}</td>
                <td>{s.interval ?? "-"}</td>
                <td>{formatStopLoss(s)}</td>
                <td>{formatTarget(s)}</td>
                <td>{s.segment}</td>
                <td className="muted">
                  {s.source_type === "in_house" ? (
                    <>
                      {s.underlying}
                      {ruleSummary(s)}
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td>{s.square_off_time ? s.square_off_time.slice(0, 5) : "-"}</td>
                <td className="muted">
                  {s.active_from_time && s.active_to_time
                    ? `${s.active_from_time.slice(0, 5)}–${s.active_to_time.slice(0, 5)}`
                    : "-"}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <WebhookLinks strategyId={s.id} sourceType={s.source_type} />
                </td>
                <td className="edit-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleStartEdit(s)}
                    title={`Edit strategy "${s.name}"`}
                    aria-label={`Edit strategy "${s.name}"`}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => handleDelete(s)}
                    title={`Delete strategy "${s.name}"`}
                    aria-label={`Delete strategy "${s.name}"`}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      {selected && selectedIsInHouse && (
        <section className="panel">
          <h2>Backtest</h2>
          <p className="hint">
            Simulates a paper trade per signal using the same RSI/SMA(RSI) crossover rule the live engine uses -
            each trade closes the way execution's real position would: a stop-loss/target hit, square-off time, or
            (with nothing more specific configured or triggered) the next opposite signal. Still not a full
            sizing/account simulation against execution's real order logic (no position sizing, no lot sizes, no
            account balance).
          </p>
          <div className="strategy-form">
            <label>
              From
              <input type="date" value={backtestFrom} onChange={(e) => setBacktestFrom(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={backtestTo} onChange={(e) => setBacktestTo(e.target.value)} />
            </label>
            <button type="button" onClick={handleBacktest} disabled={backtesting}>
              {backtesting ? "Running..." : "Run backtest"}
            </button>
          </div>
          {backtestError && <p className="error">{backtestError}</p>}
          {backtestResult && (
            <>
              <p>
                <strong>{backtestResult.trade_count}</strong> trade(s) -{" "}
                <span className={backtestResult.hypothetical_pnl >= 0 ? "pnl-positive" : "pnl-negative"}>
                  hypothetical P&amp;L {backtestResult.hypothetical_pnl >= 0 ? "+" : ""}
                  {backtestResult.hypothetical_pnl.toFixed(2)}
                </span>
                {"pooled" in backtestResult && (
                  <span className="muted">
                    {" "}
                    - pooled across {backtestResult.constituents_tested} constituent(s)
                    {backtestResult.constituents_skipped > 0 &&
                      `, ${backtestResult.constituents_skipped} skipped (unresolvable)`}
                  </span>
                )}
              </p>
              {"pooled" in backtestResult ? (
                Object.keys(backtestResult.by_symbol).length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Trades</th>
                          <th>Hypothetical P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(backtestResult.by_symbol)
                          .sort(([, a], [, b]) => b.hypothetical_pnl - a.hypothetical_pnl)
                          .map(([symbol, r]) => (
                            <tr key={symbol}>
                              <td className="symbol">{symbol}</td>
                              <td className="num">{r.trade_count}</td>
                              <td className={`num ${r.hypothetical_pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                                {r.hypothetical_pnl >= 0 ? "+" : ""}
                                {r.hypothetical_pnl.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : (
                backtestResult.trades.length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Entry</th>
                          <th>Dir</th>
                          <th>Entry px</th>
                          <th>Exit</th>
                          <th>Exit px</th>
                          <th>Reason</th>
                          <th>P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.trades.map((trade, i) => (
                          <tr key={i}>
                            <td>{new Date(trade.entry_time).toLocaleString()}</td>
                            <td>
                              <span className={`badge ${trade.direction === "bullish" ? "badge-buy" : "badge-sell"}`}>
                                {trade.direction}
                              </span>
                            </td>
                            <td className="num">{trade.entry_price.toFixed(2)}</td>
                            <td>{new Date(trade.exit_time).toLocaleString()}</td>
                            <td className="num">{trade.exit_price.toFixed(2)}</td>
                            <td>{exitReasonLabel(trade.exit_reason)}</td>
                            <td className={`num ${trade.pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                              {trade.pnl >= 0 ? "+" : ""}
                              {trade.pnl.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </>
          )}

          {selectedIsBreakout || selectedIsRangeBreakout ? (
            <p className="hint">Grid search isn't supported for breakout/range-breakout-rule strategies yet.</p>
          ) : (
            <>
              <h3>Grid search indicator params</h3>
              <p className="hint">
                Sweeps the strategy's indicator over candidate values (comma-separated) using the same From/To range
                above - a param left blank stays fixed at the indicator's own current value
                {selectedIndicator ? ` (currently period=${selectedIndicator.params.period}, sma_period=${selectedIndicator.params.sma_period})` : ""}
                . Doesn't change the indicator itself - PATCH it once you've picked a winner from the report below.
              </p>
              <div className="strategy-form">
                <label>
                  Period values
                  <input
                    type="text"
                    placeholder={selectedIndicator ? `e.g. 7,14,21 (current ${selectedIndicator.params.period})` : "e.g. 7,14,21"}
                    value={gridPeriodValues}
                    onChange={(e) => setGridPeriodValues(e.target.value)}
                  />
                </label>
                <label>
                  SMA period values
                  <input
                    type="text"
                    placeholder={selectedIndicator ? `e.g. 5,9,14 (current ${selectedIndicator.params.sma_period})` : "e.g. 5,9,14"}
                    value={gridSmaPeriodValues}
                    onChange={(e) => setGridSmaPeriodValues(e.target.value)}
                  />
                </label>
                <button type="button" onClick={handleGridSearch} disabled={gridSearching}>
                  {gridSearching ? "Running..." : "Run grid search"}
                </button>
              </div>
              {gridError && <p className="error">{gridError}</p>}
              {gridResult && (
                <div className="table-scroll">
                  <p className="hint">{gridResult.combinations_tested} combination(s) tested - sorted best P&amp;L first.</p>
                  <table>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th>SMA period</th>
                        <th>Trades</th>
                        <th>Hypothetical P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gridResult.results.map((row, i) => (
                        <tr key={i} className={i === 0 && !row.error ? "grid-best-row" : undefined}>
                          <td className="num">{row.params.period}</td>
                          <td className="num">{row.params.sma_period}</td>
                          {row.error ? (
                            <td colSpan={2} className="error">
                              {row.error}
                            </td>
                          ) : (
                            <>
                              <td className="num">{row.trade_count}</td>
                              <td className={`num ${(row.hypothetical_pnl ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                                {(row.hypothetical_pnl ?? 0) >= 0 ? "+" : ""}
                                {(row.hypothetical_pnl ?? 0).toFixed(2)}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {selected && (
        <>
          <h2 className="section-title">Recent signals for selected strategy</h2>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Price</th>
                <th>Status</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No signals yet for this strategy.
                  </td>
                </tr>
              )}
              {signals.map((sig) => (
                <tr key={sig.signal_id}>
                  <td>{new Date(sig.received_at).toLocaleString()}</td>
                  <td className="symbol">{sig.symbol}</td>
                  <td>
                    <span className={`badge ${sig.action === "BUY" ? "badge-buy" : "badge-sell"}`}>
                      {sig.action}
                    </span>
                  </td>
                  <td className="num">{sig.price.toFixed(2)}</td>
                  <td title={sig.rejection_reason ?? undefined}>{sig.status ?? "-"}</td>
                  <td>
                    <a href={processingUrl(sig.signal_id)} target="_blank" rel="noreferrer" className="crosslink">
                      Processing &rarr;
                    </a>
                  </td>
                  <td>
                    <a href={executionUrl(sig.signal_id)} target="_blank" rel="noreferrer" className="crosslink">
                      Execution &rarr;
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function StrategiesTab() {
  return (
    <>
      <InfoDisclosure summary="How strategy webhooks work here">
        <p>
          Every strategy - in-house or external - gets its own <code>?strategy_id=</code> query param.
          For an <strong>external</strong> source, name the provider (e.g. "chartink", "tradingview", or
          anything else) below; today only Chartink has a real n8n workflow wired up (one workflow per
          direction handles <em>every</em> Chartink strategy via that query param) - copy its buy/sell
          webhook URLs into a Chartink scan alert once created. Any other provider name is recorded but
          has no webhook wired up yet - adding one follows the same pattern (a new n8n workflow
          normalizing that provider's alert payload into the canonical signal shape, see the{" "}
          <code>add-signal-provider</code> Claude Code skill or <code>infra/n8n/workflows/README.md</code>).
        </p>
        <p>
          An <strong>in-house</strong> strategy instead runs off this system's own indicator/price-action
          engine - a periodic job checks every <strong>live</strong> in-house strategy for a fresh signal on
          its underlying and posts it into the same pipeline external providers use. Select a strategy below
          and use its Backtest panel to replay the rule against history before promoting it to live.
        </p>
        <p>
          <a href={n8nUrl} target="_blank" rel="noreferrer">
            Open n8n &rarr;
          </a>{" "}
          if you need to edit the intake workflows themselves.
        </p>
      </InfoDisclosure>
      <StrategyManager />
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>("strategies");

  return (
    <main>
      <header>
        <h1>signal-generation</h1>
        <p className="subtitle">Strategies - external providers and in-house rules - that produce BUY/SELL ideas.</p>
      </header>

      <nav className="tabs">
        <button className={tab === "strategies" ? "active" : ""} onClick={() => setTab("strategies")}>
          Strategies
        </button>
        <button className={tab === "indicators" ? "active" : ""} onClick={() => setTab("indicators")}>
          Indicators
        </button>
      </nav>

      {tab === "strategies" && <StrategiesTab />}
      {tab === "indicators" && <IndicatorsTab />}
    </main>
  );
}

import { Fragment, useEffect, useRef, useState } from "react";

import {
  INDICATOR_TYPE_LABELS,
  REGIME_INDICATOR_TYPES,
  type BacktestResult,
  type ContractDayFilter,
  type CounterSignalPolicy,
  type DuplicateSignalPolicy,
  type GridBacktestResult,
  type GridBacktestRow,
  type Horizon,
  type Indicator,
  type IndicatorType,
  type InstrumentType,
  type Interval,
  type OptionPositionStyle,
  type OptionSlScope,
  type OptionStrikeMoneyness,
  type ProviderSignal,
  type Rule,
  type RuleConfig,
  type RsiParams,
  type Segment,
  type SourceType,
  type StopLossIndicatorType,
  type StopLossInterval,
  type StopLossMethod,
  type Strategy,
  type StrategyStatus,
  type UnderlyingType,
  type UniverseBacktestResult,
  backtestRule,
  backtestRuleGrid,
  createIndicator,
  createRule,
  createStrategy,
  deleteIndicator,
  deleteRule,
  deleteStrategy,
  fetchIndicators,
  fetchLtp,
  fetchRules,
  fetchSignalsForStrategy,
  fetchStrategies,
  sendManualSignal,
  fetchUniverses,
  updateIndicator,
  updateRule,
  updateStrategy,
} from "./api";
import { chartinkWebhookUrls, executionUrl, processingUrl } from "./links";
import ManualTab from "./ManualTab";

const POLL_INTERVAL_MS = 5000;

type TabId = "strategies" | "rules" | "manual";

const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop-loss",
  target: "Target",
  square_off: "Square-off",
  opposite_signal: "Opposite signal",
  end_of_data: "Still open (end of range)",
  initial_stop_loss: "Initial stop-loss",
  reversal_exit: "Reversal exit",
  combined_stop_loss: "Combined stop-loss",
  combined_target: "Combined target",
};

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

// Per-IndicatorType params shape - drives IndicatorsTab's create form (a
// generic {key: value} form instead of one hardcoded RSI field pair).
// ALL_INDICATOR_TYPES also drives the type <select> itself, in the same
// order regime types are listed elsewhere (REGIME_INDICATOR_TYPES) plus
// "rsi" first (the crossover-only one, most commonly created).
const ALL_INDICATOR_TYPES: IndicatorType[] = ["rsi", ...REGIME_INDICATOR_TYPES];

type IndicatorParamField = { key: string; label: string; min: string; step?: string };

const INDICATOR_PARAM_FIELDS: Record<IndicatorType, IndicatorParamField[]> = {
  rsi: [
    { key: "period", label: "RSI period", min: "2" },
    { key: "sma_period", label: "Signal SMA period", min: "2" },
  ],
  structure: [{ key: "swing_lookback", label: "Swing lookback", min: "2" }],
  efficiency_ratio: [
    { key: "period", label: "Period", min: "2" },
    { key: "trend_threshold", label: "Trend threshold (0-1)", min: "0", step: "0.01" },
  ],
  adx: [
    { key: "period", label: "Period", min: "2" },
    { key: "trend_threshold", label: "Trend threshold", min: "0", step: "0.1" },
  ],
  dmi_direction: [{ key: "period", label: "Period", min: "2" }],
  ema_slope: [
    { key: "ema_period", label: "EMA period", min: "2" },
    { key: "slope_lookback", label: "Slope lookback", min: "1" },
    { key: "slope_threshold", label: "Slope threshold", min: "0", step: "0.01" },
    { key: "atr_period", label: "ATR period (normalizing)", min: "2" },
  ],
};

const INDICATOR_PARAM_DEFAULTS: Record<IndicatorType, Record<string, string>> = {
  rsi: { period: "14", sma_period: "9" },
  structure: { swing_lookback: "3" },
  efficiency_ratio: { period: "14", trend_threshold: "0.35" },
  adx: { period: "14", trend_threshold: "20" },
  dmi_direction: { period: "14" },
  ema_slope: { ema_period: "20", slope_lookback: "5", slope_threshold: "0.15", atr_period: "14" },
};

function exitReasonLabel(reason: string): string {
  return EXIT_REASON_LABELS[reason] ?? reason;
}

// toLocaleString()'s default time style includes seconds (e.g.
// "8/7/2026, 8:50:00 AM") - noise for a backtest trades grid where every
// entry/exit lands on a whole-minute candle boundary anyway.
function formatDateTimeNoSeconds(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
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
  const base =
    s.stop_loss_method === "previous_candle"
      ? `Prev candle (${s.stop_loss_interval})`
      : s.stop_loss_method === "indicator"
        ? `${(s.stop_loss_indicator_type ?? "indicator").toUpperCase()}(${s.stop_loss_indicator_params?.period ?? "?"})`
        : `${s.stop_loss_percent}%`;
  return s.trailing_stop_enabled ? `${base}, trailing` : base;
}

function formatTarget(s: Strategy): string {
  return s.target_percent != null ? `${s.target_percent}%` : "-";
}

function formatActiveWindows(s: Strategy): string {
  if (s.active_windows.length === 0) return "-";
  return s.active_windows.map((w) => `${w.start.slice(0, 5)}–${w.end.slice(0, 5)}`).join(", ");
}

// A repeatable list of {start, end} time-of-day pairs - shared by the
// create form and the edit-row form below. `windows` uses bare "HH:MM"
// (native <input type="time"> values); the caller converts to "HH:MM:SS"
// only when building the actual API payload.
function ActiveWindowsEditor({
  windows,
  onChange,
}: {
  windows: { start: string; end: string }[];
  onChange: (windows: { start: string; end: string }[]) => void;
}) {
  return (
    <div className="active-windows-editor">
      {windows.map((w, i) => (
        <div key={i} className="active-window-row">
          <input
            type="time"
            value={w.start}
            onChange={(e) => onChange(windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
          />
          <span className="muted">&ndash;</span>
          <input
            type="time"
            value={w.end}
            onChange={(e) => onChange(windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
          />
          <button type="button" className="secondary" onClick={() => onChange(windows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...windows, { start: "", end: "" }])}>
        + Add window
      </button>
    </div>
  );
}

function WebhookLinks({ strategyId, sourceType }: { strategyId: string; sourceType: SourceType }) {
  // In-house strategies never get a webhook - they run off this system's
  // own scheduled engine, not an inbound provider payload - so this isn't
  // "not wired up yet" like an unconfigured external provider, it's N/A.
  if (sourceType === "in_house") {
    return <span className="muted">n/a - runs on the in-house engine</span>;
  }
  // Chartink is the only provider with a real webhook route today - any
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
  const [newIndicatorType, setNewIndicatorType] = useState<IndicatorType>("rsi");
  const [newParams, setNewParams] = useState<Record<string, string>>(INDICATOR_PARAM_DEFAULTS.rsi);
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
      const params: Record<string, number> = {};
      for (const field of INDICATOR_PARAM_FIELDS[newIndicatorType]) {
        params[field.key] = Number(newParams[field.key]);
      }
      const created = await createIndicator({
        name: newIndicatorName,
        type: newIndicatorType,
        params: params as Indicator["params"],
      });
      setIndicators((prev) => [created, ...prev]);
      setNewIndicatorName("");
      setNewIndicatorType("rsi");
      setNewParams(INDICATOR_PARAM_DEFAULTS.rsi);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create indicator");
    } finally {
      setCreatingIndicator(false);
    }
  }

  async function handleDeleteIndicator(indicator: Indicator) {
    const confirmed = window.confirm(
      `Delete indicator "${indicator.name}"? Any rule still referencing it will skip on its next engine tick instead of crashing, but won't produce signals until fixed.`,
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
        number of in-house rules.
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
              <td>{INDICATOR_TYPE_LABELS[ind.type]}</td>
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
          <select
            value={newIndicatorType}
            onChange={(e) => {
              const t = e.target.value as IndicatorType;
              setNewIndicatorType(t);
              setNewParams(INDICATOR_PARAM_DEFAULTS[t]);
            }}
          >
            {ALL_INDICATOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {INDICATOR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        {INDICATOR_PARAM_FIELDS[newIndicatorType].map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              type="number"
              min={field.min}
              step={field.step ?? "1"}
              value={newParams[field.key] ?? ""}
              onChange={(e) => setNewParams((prev) => ({ ...prev, [field.key]: e.target.value }))}
              required
            />
          </label>
        ))}
        <button
          type="submit"
          disabled={
            creatingIndicator ||
            !newIndicatorName.trim() ||
            INDICATOR_PARAM_FIELDS[newIndicatorType].some((field) => !newParams[field.key])
          }
        >
          {creatingIndicator ? "Creating..." : "Create indicator"}
        </button>
      </form>
    </section>
  );
}

function ruleSummary(r: Rule, indicators: Indicator[]): string {
  const ruleConfig = r.rule_config;
  if (!ruleConfig) return "";

  if (ruleConfig.type === "breakout") {
    const emaSuffix = ruleConfig.ema_filter_enabled ? `, EMA${ruleConfig.ema_period} filter` : "";
    return ` - ${ruleConfig.htf_interval}(N=${ruleConfig.htf_breakout_period}) -> ${ruleConfig.ltf_interval}(N=${ruleConfig.ltf_breakout_period})${emaSuffix}`;
  }
  if (ruleConfig.type === "range_breakout") {
    return ` - close beyond last ${ruleConfig.breakout_period} candles' high/low`;
  }
  const indicator = indicators.find((i) => i.id === ruleConfig.indicator_id);
  if (!indicator) return ` - unknown indicator (${ruleConfig.indicator_id.slice(0, 8)}...)`;
  const smaPeriod = "sma_period" in indicator.params ? indicator.params.sma_period : "?";
  return ` - ${indicator.name} crosses its own SMA(${smaPeriod})`;
}

// Rule.interval (Interval) allows "daily" too, which StopLossInterval
// deliberately excludes (see api.ts) - this guards the auto-default
// below from ever proposing a value the SL-interval field can't accept.
const STOP_LOSS_INTERVALS: string[] = ["1min", "3min", "5min", "15min", "25min", "30min", "60min"];

function RuleManager() {
  const [rules, setRules] = useState<Rule[]>([]);
  // rules is polled every POLL_INTERVAL_MS and gets a fresh array
  // reference each tick even when nothing changed - the SL-interval
  // default effect below must read the latest rules without
  // re-subscribing to it (a [selected, rules] dependency array would
  // re-fire, and therefore re-wipe backtestResult/gridResult, on every
  // poll tick, not just on an actual rule switch - reproduced live as
  // grid search results flashing then disappearing after ~5s).
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [universes, setUniverses] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [segment, setSegment] = useState<Segment>("NSE");
  const [underlying, setUnderlying] = useState("");
  const [underlyingType, setUnderlyingType] = useState<UnderlyingType>("symbol");
  const [selectedUniverse, setSelectedUniverse] = useState("");
  const [interval, setInterval_] = useState<Interval | "">("");
  const [ruleType, setRuleType] = useState<"crossover" | "breakout" | "range_breakout">("crossover");
  const [selectedIndicatorId, setSelectedIndicatorId] = useState("");
  const [htfInterval, setHtfInterval] = useState<Interval>("15min");
  const [htfBreakoutPeriod, setHtfBreakoutPeriod] = useState("20");
  const [ltfInterval, setLtfInterval] = useState<Interval>("3min");
  const [ltfBreakoutPeriod, setLtfBreakoutPeriod] = useState("10");
  const [emaFilterEnabled, setEmaFilterEnabled] = useState(false);
  const [emaPeriod, setEmaPeriod] = useState("20");
  const [rangeBreakoutPeriod, setRangeBreakoutPeriod] = useState("5");
  const [regimeIndicatorIds, setRegimeIndicatorIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSegment, setEditSegment] = useState<Segment>("NSE");
  const [editUnderlying, setEditUnderlying] = useState("");
  const [editUnderlyingType, setEditUnderlyingType] = useState<UnderlyingType>("symbol");
  const [editSelectedUniverse, setEditSelectedUniverse] = useState("");
  const [editInterval, setEditInterval] = useState<Interval | "">("");
  const [editIndicatorId, setEditIndicatorId] = useState("");
  const [editHtfInterval, setEditHtfInterval] = useState<Interval>("15min");
  const [editHtfBreakoutPeriod, setEditHtfBreakoutPeriod] = useState("20");
  const [editLtfInterval, setEditLtfInterval] = useState<Interval>("3min");
  const [editLtfBreakoutPeriod, setEditLtfBreakoutPeriod] = useState("10");
  const [editEmaFilterEnabled, setEditEmaFilterEnabled] = useState(false);
  const [editEmaPeriod, setEditEmaPeriod] = useState("20");
  const [editRangeBreakoutPeriod, setEditRangeBreakoutPeriod] = useState("5");
  const [editRegimeIndicatorIds, setEditRegimeIndicatorIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Backtest - Rule-scoped (POST /rules/{id}/backtest), so instrument_type/
  // horizon/exit-config aren't known from the rule alone - supplied here
  // as optional overrides, matching what execution would actually need to
  // know to trade this rule. Defaults reproduce the simplest case (spot,
  // no stop-loss/target, opposite-signal-only exits).
  const [backtestFrom, setBacktestFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [backtestTo, setBacktestTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [backtestInstrumentType, setBacktestInstrumentType] = useState<InstrumentType>("spot");
  const [backtestHorizon, setBacktestHorizon] = useState<Horizon>("intraday");
  const [backtestOptionPositionStyle, setBacktestOptionPositionStyle] = useState<OptionPositionStyle>("spread");
  const [backtestOptionStrikeMoneyness, setBacktestOptionStrikeMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [backtestSlMethod, setBacktestSlMethod] = useState<StopLossMethod | "">("");
  const [backtestSlInterval, setBacktestSlInterval] = useState<StopLossInterval | "">("");
  const [backtestSlPercent, setBacktestSlPercent] = useState("");
  const [backtestSlIndicatorType, setBacktestSlIndicatorType] = useState<StopLossIndicatorType>("ema");
  const [backtestSlIndicatorPeriod, setBacktestSlIndicatorPeriod] = useState("");
  const [backtestTargetPercent, setBacktestTargetPercent] = useState("");
  const [backtestTrailingEnabled, setBacktestTrailingEnabled] = useState(false);
  const [backtestSquareOffTime, setBacktestSquareOffTime] = useState("");
  // Opt-in - adds time_of_day_breakdown to the report (which time of day
  // this rule is most/least profitable), bucketed into this many
  // clock-aligned minutes. Blank omits it entirely, same as before this
  // existed - not every backtest run needs the extra table.
  const [backtestTimeBucketMinutes, setBacktestTimeBucketMinutes] = useState("");
  // Sortable "P&L by time of day" table below - defaults to the same
  // best-P&L-first order the table always used before sorting existed.
  const [todSortColumn, setTodSortColumn] = useState<"start" | "trade_count" | "win_rate" | "hypothetical_pnl">("hypothetical_pnl");
  const [todSortDir, setTodSortDir] = useState<"asc" | "desc">("desc");
  const [backtestResult, setBacktestResult] = useState<BacktestResult | UniverseBacktestResult | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // Backtest and grid search share one rule-detail panel, split into tabs
  // rather than two always-visible stacked sections.
  const [backtestSubTab, setBacktestSubTab] = useState<"backtest" | "grid">("backtest");

  const [gridPeriodValues, setGridPeriodValues] = useState("");
  const [gridSmaPeriodValues, setGridSmaPeriodValues] = useState("");
  // Second sweep dimension - candidate SL EMA periods, same comma-separated
  // shape as Period/SMA period above. Standalone within Grid search - filling
  // this in is what turns the sweep on (forces stop_loss_method='indicator'
  // for the grid run), independent of whatever the Backtest tab's own
  // Stop-loss dropdown happens to be set to.
  const [gridSlIndicatorPeriodValues, setGridSlIndicatorPeriodValues] = useState("");
  const [gridResult, setGridResult] = useState<GridBacktestResult | null>(null);
  const [gridSearching, setGridSearching] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  // Applying a winning (period, sma_period) combo straight to the rule's
  // referenced Indicator - PATCH /indicators/{id}, see handleApplyGridWinner.
  const [applyingGridWinner, setApplyingGridWinner] = useState(false);
  const [applyGridWinnerStatus, setApplyGridWinnerStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchRules();
        if (!cancelled) {
          setRules(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load rules");
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
    setBacktestResult(null);
    setBacktestError(null);
    setGridResult(null);
    setGridError(null);
    // Default the backtest panel's SL candle interval to this rule's own
    // interval - almost always what you want (the SL series lives on the
    // same timeframe the rule itself trades), and one less field to fill
    // in per rule switched to. Only when it's a value the SL-interval
    // field can actually accept (excludes "daily" - see STOP_LOSS_INTERVALS
    // above); falls back to blank otherwise, same as before this default
    // existed. Always overwrites on switch, matching the reset above -
    // switching rules resets the whole backtest form to that rule's own
    // sensible defaults, not a carried-over choice from the last one.
    // Reads rulesRef (not the reactive `rules` state) deliberately - see
    // rulesRef's own comment above: `rules` is polled every 5s and must
    // NOT be a dependency here, or this whole effect (including the two
    // setGridResult(null)/setBacktestResult(null) resets above) would
    // re-fire on every poll tick instead of only on an actual rule switch.
    const rule = rulesRef.current.find((r) => r.id === selected);
    setBacktestSlInterval(rule && STOP_LOSS_INTERVALS.includes(rule.interval) ? (rule.interval as StopLossInterval) : "");
  }, [selected]);

  const selectedRule = rules.find((r) => r.id === selected);
  const selectedRuleConfig = selectedRule?.rule_config;
  const selectedIndicator =
    selectedRuleConfig?.type === "crossover" ? indicators.find((i) => i.id === selectedRuleConfig.indicator_id) : undefined;
  // Grid search only supports RSI's own params (period/sma_period) -
  // narrows the union (a CrossoverRuleConfig can only reference a "rsi"
  // indicator, enforced backend-side - see _check_referenced_indicator_exists).
  const selectedRsiParams: RsiParams | undefined =
    selectedIndicator?.type === "rsi" ? (selectedIndicator.params as RsiParams) : undefined;
  const selectedIsBreakout = selectedRule?.rule_config?.type === "breakout";
  const selectedIsRangeBreakout = selectedRule?.rule_config?.type === "range_breakout";

  const isBreakout = ruleType === "breakout";
  const isRangeBreakout = ruleType === "range_breakout";

  function buildRuleConfig(): RuleConfig {
    if (isBreakout) {
      return {
        type: "breakout",
        htf_interval: htfInterval,
        htf_breakout_period: Number(htfBreakoutPeriod),
        ltf_interval: ltfInterval,
        ltf_breakout_period: Number(ltfBreakoutPeriod),
        ema_filter_enabled: emaFilterEnabled,
        ema_period: Number(emaPeriod),
      };
    }
    if (isRangeBreakout) {
      return { type: "range_breakout", breakout_period: Number(rangeBreakoutPeriod) };
    }
    return { type: "crossover", indicator_id: selectedIndicatorId };
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const created = await createRule({
        name,
        description: description.trim() || undefined,
        segment,
        underlying: (underlyingType === "universe" ? selectedUniverse : underlying) || "",
        underlying_type: underlyingType,
        interval: isBreakout ? ltfInterval : (interval as Interval),
        rule_config: buildRuleConfig(),
        regime_indicator_ids: regimeIndicatorIds,
      });
      setName("");
      setDescription("");
      setSegment("NSE");
      setUnderlying("");
      setUnderlyingType("symbol");
      setSelectedUniverse("");
      setInterval_("");
      setRuleType("crossover");
      setSelectedIndicatorId("");
      setRegimeIndicatorIds([]);
      setRules((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule");
    } finally {
      setCreating(false);
    }
  }

  function handleStartEdit(r: Rule) {
    setEditingId(r.id);
    setEditName(r.name);
    setEditDescription(r.description ?? "");
    setEditSegment(r.segment);
    setEditUnderlyingType(r.underlying_type);
    if (r.underlying_type === "universe") {
      setEditSelectedUniverse(r.underlying ?? "");
      setEditUnderlying("");
    } else {
      setEditUnderlying(r.underlying ?? "");
      setEditSelectedUniverse("");
    }
    setEditInterval(r.interval ?? "");
    if (r.rule_config?.type === "breakout") {
      setEditHtfInterval(r.rule_config.htf_interval);
      setEditHtfBreakoutPeriod(String(r.rule_config.htf_breakout_period));
      setEditLtfInterval(r.rule_config.ltf_interval);
      setEditLtfBreakoutPeriod(String(r.rule_config.ltf_breakout_period));
      setEditEmaFilterEnabled(r.rule_config.ema_filter_enabled);
      setEditEmaPeriod(String(r.rule_config.ema_period));
    } else if (r.rule_config?.type === "range_breakout") {
      setEditRangeBreakoutPeriod(String(r.rule_config.breakout_period));
    } else {
      setEditIndicatorId(r.rule_config?.indicator_id ?? "");
    }
    setEditRegimeIndicatorIds(r.regime_indicator_ids);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      const editingRule = rules.find((r) => r.id === id);
      const editingIsBreakout = editingRule?.rule_config?.type === "breakout";
      const editingIsRangeBreakout = editingRule?.rule_config?.type === "range_breakout";
      const ruleConfig: RuleConfig | undefined = editingIsBreakout
        ? {
            type: "breakout",
            htf_interval: editHtfInterval,
            htf_breakout_period: Number(editHtfBreakoutPeriod),
            ltf_interval: editLtfInterval,
            ltf_breakout_period: Number(editLtfBreakoutPeriod),
            ema_filter_enabled: editEmaFilterEnabled,
            ema_period: Number(editEmaPeriod),
          }
        : editingIsRangeBreakout
          ? { type: "range_breakout", breakout_period: Number(editRangeBreakoutPeriod) }
          : editIndicatorId
            ? { type: "crossover", indicator_id: editIndicatorId }
            : undefined;
      const updated = await updateRule(id, {
        name: editName,
        description: editDescription.trim() || undefined,
        segment: editSegment,
        underlying: (editUnderlyingType === "universe" ? editSelectedUniverse : editUnderlying) || undefined,
        underlying_type: editUnderlyingType,
        interval: editingIsBreakout ? editLtfInterval : editInterval || undefined,
        rule_config: ruleConfig,
        regime_indicator_ids: editRegimeIndicatorIds,
      });
      setRules((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rule");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(r: Rule) {
    const confirmed = window.confirm(
      `Delete rule "${r.name}"? This fails if any strategy still references it - re-point or delete those first.`,
    );
    if (!confirmed) return;
    try {
      await deleteRule(r.id);
      setRules((prev) => prev.filter((x) => x.id !== r.id));
      setSelected((prev) => (prev === r.id ? null : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule - it may still be referenced by a strategy");
    }
  }

  function backtestOverrides() {
    return {
      instrument_type: backtestInstrumentType,
      horizon: backtestHorizon,
      stop_loss_method: backtestSlMethod || undefined,
      stop_loss_interval:
        backtestSlMethod === "previous_candle" || backtestSlMethod === "indicator" ? backtestSlInterval || undefined : undefined,
      stop_loss_percent: backtestSlMethod === "percent" && backtestSlPercent ? Number(backtestSlPercent) : undefined,
      stop_loss_indicator_type: backtestSlMethod === "indicator" ? backtestSlIndicatorType : undefined,
      stop_loss_indicator_params:
        backtestSlMethod === "indicator" && backtestSlIndicatorPeriod ? { period: Number(backtestSlIndicatorPeriod) } : undefined,
      target_percent: backtestTargetPercent ? Number(backtestTargetPercent) : undefined,
      trailing_stop_enabled: backtestSlMethod ? backtestTrailingEnabled : undefined,
      square_off_time: backtestSquareOffTime ? `${backtestSquareOffTime}:00` : undefined,
      option_position_style: backtestInstrumentType === "option" ? backtestOptionPositionStyle : undefined,
      option_strike_moneyness: backtestInstrumentType === "option" ? backtestOptionStrikeMoneyness : undefined,
      time_bucket_minutes: backtestTimeBucketMinutes ? Number(backtestTimeBucketMinutes) : undefined,
    };
  }

  // Clicking the already-active column flips direction; a new column
  // starts descending for the numeric ones (best/most first, matching
  // the table's original hardcoded sort) and ascending for Window
  // (chronological - "20:00" sorting before "21:00" numerically has no
  // other sensible default).
  function handleTodSort(column: typeof todSortColumn) {
    if (column === todSortColumn) {
      setTodSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setTodSortColumn(column);
      setTodSortDir(column === "start" ? "asc" : "desc");
    }
  }

  async function handleBacktest() {
    if (!selected) return;
    setBacktesting(true);
    setBacktestError(null);
    setBacktestResult(null);
    try {
      const result = await backtestRule(selected, backtestFrom, backtestTo, backtestOverrides());
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

    const slPeriodValues = parseGridValues(gridSlIndicatorPeriodValues);
    // Filling in SL EMA period values is what turns the sweep on for this
    // grid run, standalone from the Backtest tab's own Stop-loss dropdown -
    // forces stop_loss_method='indicator' regardless of what that's set to.
    const sweepingSl = slPeriodValues.length > 0;

    setGridSearching(true);
    setGridError(null);
    setGridResult(null);
    setApplyGridWinnerStatus(null);
    try {
      const result = await backtestRuleGrid(selected, backtestFrom, backtestTo, paramGrid, {
        stop_loss_method: sweepingSl ? "indicator" : backtestSlMethod || undefined,
        stop_loss_interval:
          sweepingSl || backtestSlMethod === "previous_candle" || backtestSlMethod === "indicator"
            ? backtestSlInterval || undefined
            : undefined,
        stop_loss_percent: !sweepingSl && backtestSlMethod === "percent" && backtestSlPercent ? Number(backtestSlPercent) : undefined,
        stop_loss_indicator_type: sweepingSl || backtestSlMethod === "indicator" ? backtestSlIndicatorType : undefined,
        stop_loss_indicator_params:
          !sweepingSl && backtestSlMethod === "indicator" && backtestSlIndicatorPeriod
            ? { period: Number(backtestSlIndicatorPeriod) }
            : undefined,
        stop_loss_indicator_param_grid: sweepingSl ? { period: slPeriodValues } : undefined,
        target_percent: backtestTargetPercent ? Number(backtestTargetPercent) : undefined,
        trailing_stop_enabled: sweepingSl ? backtestTrailingEnabled : backtestSlMethod ? backtestTrailingEnabled : undefined,
        square_off_time: backtestSquareOffTime ? `${backtestSquareOffTime}:00` : undefined,
      });
      setGridResult(result);
    } catch (err) {
      setGridError(err instanceof Error ? err.message : "Grid search failed");
    } finally {
      setGridSearching(false);
    }
  }

  // Writes a grid-search row's (period, sma_period) straight to the rule's
  // referenced Indicator (PATCH /indicators/{id}) - previously the report
  // was a dead end, you had to go re-type the winning numbers into the
  // Indicators panel yourself. Only ever period/sma_period (RSI's own two
  // params, the only thing grid search sweeps) - the SL EMA sweep dimension
  // isn't stored on an Indicator row at all, nothing to apply there.
  async function handleApplyGridWinner(row: GridBacktestRow) {
    if (!selectedIndicator) return;
    setApplyingGridWinner(true);
    setApplyGridWinnerStatus(null);
    try {
      const updated = await updateIndicator(selectedIndicator.id, { params: row.params as RsiParams });
      setIndicators((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      setApplyGridWinnerStatus(`Applied period=${row.params.period}, sma_period=${row.params.sma_period} to ${selectedIndicator.name}.`);
    } catch (err) {
      setApplyGridWinnerStatus(err instanceof Error ? `Failed to apply: ${err.message}` : "Failed to apply");
    } finally {
      setApplyingGridWinner(false);
    }
  }

  const colCount = 5; // Name, Segment, Underlying/Rule, Description, actions

  return (
    <>
      <section className="panel">
        <h2>New rule</h2>
        <form className="strategy-form" onSubmit={handleCreate}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. RSI 35-49 crossover" />
          </label>
          <label>
            Description <span className="optional">(optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this rule looks for" />
          </label>
          <label>
            Segment
            <select value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
              <option value="NSE">NSE</option>
              <option value="MCX">MCX</option>
              <option value="CRYPTO">Crypto</option>
            </select>
          </label>
          <>
              {ruleType !== "breakout" && (
                <label>
                  Interval
                  <select value={interval} onChange={(e) => setInterval_(e.target.value as Interval | "")} required>
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
                  <option value="symbol_list">Multiple symbols</option>
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
                  {underlyingType === "symbol_list" ? "Symbols (comma-separated)" : "Underlying"}
                  <input
                    value={underlying}
                    onChange={(e) => setUnderlying(e.target.value.toUpperCase())}
                    required
                    placeholder={underlyingType === "symbol_list" ? "e.g. GOLDM,SILVER,CRUDEOIL" : "e.g. GOLDM, NIFTY"}
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
                    <input type="number" min="2" value={htfBreakoutPeriod} onChange={(e) => setHtfBreakoutPeriod(e.target.value)} />
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
                    <input type="number" min="2" value={ltfBreakoutPeriod} onChange={(e) => setLtfBreakoutPeriod(e.target.value)} />
                  </label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={emaFilterEnabled} onChange={(e) => setEmaFilterEnabled(e.target.checked)} />
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
              <div className="regime-checks">
                <span className="muted">Regime filters (optional)</span>
                {indicators.filter((ind) => REGIME_INDICATOR_TYPES.includes(ind.type)).length === 0 && (
                  <span className="muted">none defined yet - create one on the Indicators tab</span>
                )}
                {indicators
                  .filter((ind) => REGIME_INDICATOR_TYPES.includes(ind.type))
                  .map((ind) => (
                    <label key={ind.id} className="checkbox-label tiny">
                      <input
                        type="checkbox"
                        checked={regimeIndicatorIds.includes(ind.id)}
                        onChange={() => setRegimeIndicatorIds((prev) => toggleId(prev, ind.id))}
                      />
                      {ind.name}
                    </label>
                  ))}
              </div>
            </>
          <button
            type="submit"
            disabled={
              creating ||
              !name.trim() ||
              (ruleType !== "breakout" && !interval) ||
              (underlyingType === "symbol" && !underlying.trim()) ||
              (underlyingType === "universe" && !selectedUniverse) ||
              (!isBreakout && !isRangeBreakout && !selectedIndicatorId)
            }
          >
            {creating ? "Creating..." : "Create rule"}
          </button>
        </form>
        <p className="hint">
          A Strategy picks one of these rules (by name) instead of configuring underlying/indicator/rule-type
          itself - see the Strategies tab.
        </p>
      </section>

      {error && <p className="error">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Segment</th>
            <th>Underlying / Rule</th>
            <th>Description</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr>
              <td colSpan={colCount} className="empty">
                No rules yet - create one above.
              </td>
            </tr>
          )}
          {rules.map((r) =>
            editingId === r.id ? (
              <tr key={r.id} className="editing-row" onClick={(e) => e.stopPropagation()}>
                <td>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="cell-input" />
                </td>
                <td>
                  <select value={editSegment} onChange={(e) => setEditSegment(e.target.value as Segment)} className="cell-input">
                    <option value="NSE">NSE</option>
                    <option value="MCX">MCX</option>
                    <option value="CRYPTO">Crypto</option>
                  </select>
                </td>
                <td>
                    <div className="stack-cell">
                      <select
                        value={editUnderlyingType}
                        onChange={(e) => setEditUnderlyingType(e.target.value as UnderlyingType)}
                        className="cell-input"
                      >
                        <option value="symbol">Symbol</option>
                        <option value="symbol_list">Multiple symbols</option>
                        <option value="universe">Universe</option>
                      </select>
                      {editUnderlyingType === "universe" ? (
                        <select
                          value={editSelectedUniverse}
                          onChange={(e) => setEditSelectedUniverse(e.target.value)}
                          className="cell-input"
                        >
                          <option value="">&mdash;</option>
                          {universes.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={editUnderlying}
                          onChange={(e) => setEditUnderlying(e.target.value.toUpperCase())}
                          className="cell-input"
                          placeholder={editUnderlyingType === "symbol_list" ? "e.g. GOLDM,SILVER,CRUDEOIL" : undefined}
                        />
                      )}
                      {r.rule_config?.type !== "breakout" && (
                        <select
                          value={editInterval}
                          onChange={(e) => setEditInterval(e.target.value as Interval | "")}
                          className="cell-input"
                          title="Interval"
                        >
                          <option value="">&mdash;</option>
                          <option value="1min">1m</option>
                          <option value="3min">3m</option>
                          <option value="5min">5m</option>
                          <option value="15min">15m</option>
                          <option value="30min">30m</option>
                          <option value="60min">60m</option>
                          <option value="daily">1d</option>
                        </select>
                      )}
                      {r.rule_config?.type === "breakout" ? (
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
                      ) : r.rule_config?.type === "range_breakout" ? (
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
                        <select value={editIndicatorId} onChange={(e) => setEditIndicatorId(e.target.value)} className="cell-input">
                          <option value="">&mdash;</option>
                          {indicators.map((ind) => (
                            <option key={ind.id} value={ind.id}>
                              {ind.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="regime-checks" style={{ marginLeft: 0 }}>
                        {indicators
                          .filter((ind) => REGIME_INDICATOR_TYPES.includes(ind.type))
                          .map((ind) => (
                            <label key={ind.id} className="checkbox-label tiny">
                              <input
                                type="checkbox"
                                checked={editRegimeIndicatorIds.includes(ind.id)}
                                onChange={() => setEditRegimeIndicatorIds((prev) => toggleId(prev, ind.id))}
                              />
                              {ind.name}
                            </label>
                          ))}
                      </div>
                    </div>
                </td>
                <td>
                  <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="cell-input" />
                </td>
                <td className="edit-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleSaveEdit(r.id)}
                    disabled={saving || !editName.trim()}
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
              <tr key={r.id} className={r.id === selected ? "selected-row" : ""} onClick={() => setSelected(r.id)}>
                <td className="symbol">{r.name}</td>
                <td>{r.segment}</td>
                <td className="muted">
                  {r.underlying}
                  {ruleSummary(r, indicators)}
                </td>
                <td className="muted">{r.description ?? "-"}</td>
                <td className="edit-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleStartEdit(r)}
                    title={`Edit rule "${r.name}"`}
                    aria-label={`Edit rule "${r.name}"`}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => handleDelete(r)}
                    title={`Delete rule "${r.name}"`}
                    aria-label={`Delete rule "${r.name}"`}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      {selected && (
        <section className="panel">
          <h2>Backtest &amp; grid search</h2>
          <nav className="tabs">
            <button type="button" className={backtestSubTab === "backtest" ? "active" : ""} onClick={() => setBacktestSubTab("backtest")}>
              Backtest
            </button>
            <button type="button" className={backtestSubTab === "grid" ? "active" : ""} onClick={() => setBacktestSubTab("grid")}>
              Grid search
            </button>
          </nav>
          {backtestSubTab === "backtest" && (
            <>
          <p className="hint">
            Simulates a paper trade per signal using this rule's own logic - a Rule alone carries no exit config or
            instrument_type (those are Strategy concerns), so supply them below; leaving stop-loss/target blank
            reproduces the simplest case (opposite-signal/end-of-data exits only). Still not a full sizing/account
            simulation against execution's real order logic.
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
            <label>
              Instrument
              <select value={backtestInstrumentType} onChange={(e) => setBacktestInstrumentType(e.target.value as InstrumentType)}>
                <option value="spot">Spot</option>
                <option value="future">Future</option>
                <option value="option">Option</option>
              </select>
            </label>
            {backtestInstrumentType === "option" && (
              <>
                <label>
                  Horizon <span className="optional">(WEEK vs MONTH expiry)</span>
                  <select value={backtestHorizon} onChange={(e) => setBacktestHorizon(e.target.value as Horizon)}>
                    <option value="intraday">Intraday</option>
                    <option value="swing">Swing</option>
                    <option value="positional">Positional</option>
                  </select>
                </label>
                <label>
                  Option style
                  <select
                    value={backtestOptionPositionStyle}
                    onChange={(e) => setBacktestOptionPositionStyle(e.target.value as OptionPositionStyle)}
                  >
                    <option value="spread">Spread</option>
                    <option value="naked">Naked</option>
                  </select>
                </label>
                <label>
                  Primary leg strike
                  <select
                    value={backtestOptionStrikeMoneyness}
                    onChange={(e) => setBacktestOptionStrikeMoneyness(e.target.value as OptionStrikeMoneyness)}
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
              Stop-loss <span className="optional">(optional)</span>
              <select value={backtestSlMethod} onChange={(e) => setBacktestSlMethod(e.target.value as StopLossMethod | "")}>
                <option value="">&mdash;</option>
                <option value="previous_candle">Previous candle low/high</option>
                <option value="percent">% from entry</option>
                <option value="indicator">Indicator</option>
              </select>
            </label>
            {(backtestSlMethod === "previous_candle" || backtestSlMethod === "indicator") && (
              <label>
                SL candle interval
                <select value={backtestSlInterval} onChange={(e) => setBacktestSlInterval(e.target.value as StopLossInterval | "")}>
                  <option value="">&mdash;</option>
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
            {backtestSlMethod === "percent" && (
              <label>
                SL %
                <input type="number" min="0" max="100" step="0.1" value={backtestSlPercent} onChange={(e) => setBacktestSlPercent(e.target.value)} />
              </label>
            )}
            {backtestSlMethod === "indicator" && (
              <>
                <label>
                  Indicator type
                  <select
                    value={backtestSlIndicatorType}
                    onChange={(e) => setBacktestSlIndicatorType(e.target.value as StopLossIndicatorType)}
                  >
                    <option value="ema">EMA</option>
                  </select>
                </label>
                <label>
                  EMA period
                  <input
                    type="number"
                    min="2"
                    value={backtestSlIndicatorPeriod}
                    onChange={(e) => setBacktestSlIndicatorPeriod(e.target.value)}
                    placeholder="e.g. 20"
                  />
                </label>
              </>
            )}
            <label>
              Target % <span className="optional">(optional)</span>
              <input type="number" min="0" max="100" step="0.1" value={backtestTargetPercent} onChange={(e) => setBacktestTargetPercent(e.target.value)} />
            </label>
            {backtestSlMethod && (
              <label className="checkbox-label">
                <input type="checkbox" checked={backtestTrailingEnabled} onChange={(e) => setBacktestTrailingEnabled(e.target.checked)} />
                Trailing stop-loss
              </label>
            )}
            <label>
              Square-off time <span className="optional">(optional)</span>
              <input type="time" value={backtestSquareOffTime} onChange={(e) => setBacktestSquareOffTime(e.target.value)} />
            </label>
            <label>
              Time-of-day bucket (min) <span className="optional">(optional)</span>
              <input
                type="number"
                min="1"
                max="1440"
                step="1"
                placeholder="e.g. 60 - shows a P&L-by-time-of-day table"
                value={backtestTimeBucketMinutes}
                onChange={(e) => setBacktestTimeBucketMinutes(e.target.value)}
              />
            </label>
            <button type="button" onClick={handleBacktest} disabled={backtesting}>
              {backtesting ? "Running..." : "Run backtest"}
            </button>
          </div>
          {backtestError && <p className="error">{backtestError}</p>}
          {backtestResult && (
            <>
              {selectedRsiParams && (
                <p className="hint">
                  Used the indicator's current saved values: period={selectedRsiParams.period}, sma_period=
                  {selectedRsiParams.sma_period}. To test other values, use the Grid search tab instead.
                </p>
              )}
              <p>
                <strong>{backtestResult.trade_count}</strong> trade(s) -{" "}
                <span className={backtestResult.hypothetical_pnl >= 0 ? "pnl-positive" : "pnl-negative"}>
                  hypothetical P&amp;L {backtestResult.hypothetical_pnl >= 0 ? "+" : ""}
                  {backtestResult.hypothetical_pnl.toFixed(2)}
                </span>
                {!("pooled" in backtestResult) && (
                  <span className="muted">
                    {" "}
                    - {backtestResult.win_rate.toFixed(1)}% win rate, max drawdown {backtestResult.max_drawdown.toFixed(2)}
                  </span>
                )}
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
                          <th>Win %</th>
                          <th>Max drawdown</th>
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
                              <td className="num">{r.win_rate.toFixed(1)}%</td>
                              <td className="num">{r.max_drawdown.toFixed(2)}</td>
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
                            <td>{formatDateTimeNoSeconds(trade.entry_time)}</td>
                            <td>
                              <span className={`badge ${trade.direction === "bullish" ? "badge-buy" : "badge-sell"}`}>
                                {trade.direction}
                              </span>
                            </td>
                            <td className="num">{trade.entry_price.toFixed(2)}</td>
                            <td>{formatDateTimeNoSeconds(trade.exit_time)}</td>
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
              {!("pooled" in backtestResult) && backtestResult.time_of_day_breakdown && backtestResult.time_of_day_breakdown.length > 0 && (
                <>
                  <h3>P&amp;L by time of day</h3>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th className="sortable-th" onClick={() => handleTodSort("start")}>
                            Window{todSortColumn === "start" ? (todSortDir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                          <th className="sortable-th" onClick={() => handleTodSort("trade_count")}>
                            Trades{todSortColumn === "trade_count" ? (todSortDir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                          <th className="sortable-th" onClick={() => handleTodSort("win_rate")}>
                            Win %{todSortColumn === "win_rate" ? (todSortDir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                          <th className="sortable-th" onClick={() => handleTodSort("hypothetical_pnl")}>
                            Hypothetical P&amp;L
                            {todSortColumn === "hypothetical_pnl" ? (todSortDir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...backtestResult.time_of_day_breakdown]
                          .sort((a, b) => {
                            const cmp =
                              todSortColumn === "start"
                                ? a.start.localeCompare(b.start)
                                : a[todSortColumn] - b[todSortColumn];
                            return todSortDir === "asc" ? cmp : -cmp;
                          })
                          .map((bucket) => (
                            <tr key={bucket.start}>
                              <td>
                                {bucket.start}&ndash;{bucket.end}
                              </td>
                              <td className="num">{bucket.trade_count}</td>
                              <td className="num">{bucket.win_rate.toFixed(1)}%</td>
                              <td className={`num ${bucket.hypothetical_pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                                {bucket.hypothetical_pnl >= 0 ? "+" : ""}
                                {bucket.hypothetical_pnl.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
            </>
          )}

          {backtestSubTab === "grid" && (
          <>
          {selectedIsBreakout || selectedIsRangeBreakout ? (
            <p className="hint">Grid search isn't supported for breakout/range-breakout rules yet.</p>
          ) : (
            <>
              <p className="hint">
                Sweeps the rule's indicator over candidate values (comma-separated) using the same From/To range
                above - a param left blank stays fixed at the indicator's own current value
                {selectedRsiParams ? ` (currently period=${selectedRsiParams.period}, sma_period=${selectedRsiParams.sma_period})` : ""}
                . Doesn't change the indicator itself until you hit Apply on a result row below. SL EMA period
                values (optional, independent of the Backtest tab's own Stop-loss dropdown) adds a second sweep
                dimension - every (indicator params, SL period) pair gets its own run.
              </p>
              <div className="strategy-form">
                <label>
                  Period values
                  <input
                    type="text"
                    placeholder={selectedRsiParams ? `e.g. 7,14,21 (current ${selectedRsiParams.period})` : "e.g. 7,14,21"}
                    value={gridPeriodValues}
                    onChange={(e) => setGridPeriodValues(e.target.value)}
                  />
                </label>
                <label>
                  SMA period values
                  <input
                    type="text"
                    placeholder={selectedRsiParams ? `e.g. 5,9,14 (current ${selectedRsiParams.sma_period})` : "e.g. 5,9,14"}
                    value={gridSmaPeriodValues}
                    onChange={(e) => setGridSmaPeriodValues(e.target.value)}
                  />
                </label>
                <label>
                  SL candle interval <span className="optional">(optional, EMA sweep only)</span>
                  <select value={backtestSlInterval} onChange={(e) => setBacktestSlInterval(e.target.value as StopLossInterval | "")}>
                    <option value="">&mdash;</option>
                    <option value="1min">1 min</option>
                    <option value="3min">3 min</option>
                    <option value="5min">5 min</option>
                    <option value="15min">15 min</option>
                    <option value="25min">25 min</option>
                    <option value="30min">30 min</option>
                    <option value="60min">60 min</option>
                  </select>
                </label>
                <label>
                  SL EMA period values <span className="optional">(optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. 10,15,20 - sweeps EMA stop-loss independently of the Backtest tab"
                    value={gridSlIndicatorPeriodValues}
                    onChange={(e) => setGridSlIndicatorPeriodValues(e.target.value)}
                  />
                </label>
                <button type="button" onClick={handleGridSearch} disabled={gridSearching}>
                  {gridSearching ? "Running..." : "Run grid search"}
                </button>
              </div>
              {gridError && <p className="error">{gridError}</p>}
              {applyGridWinnerStatus && <p className="hint">{applyGridWinnerStatus}</p>}
              {gridResult && (
                <div className="table-scroll">
                  <p className="hint">{gridResult.combinations_tested} combination(s) tested - sorted best P&amp;L first.</p>
                  <table>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th>SMA period</th>
                        {gridResult.results.some((row) => row.stop_loss_indicator_params) && <th>SL EMA period</th>}
                        <th>Trades</th>
                        <th>Hypothetical P&amp;L</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {gridResult.results.map((row, i) => (
                        <tr key={i} className={i === 0 && !row.error ? "grid-best-row" : undefined}>
                          <td className="num">{row.params.period}</td>
                          <td className="num">{row.params.sma_period}</td>
                          {gridResult.results.some((r) => r.stop_loss_indicator_params) && (
                            <td className="num">{row.stop_loss_indicator_params?.period ?? "-"}</td>
                          )}
                          {row.error ? (
                            <td colSpan={3} className="error">
                              {row.error}
                            </td>
                          ) : (
                            <>
                              <td className="num">{row.trade_count}</td>
                              <td className={`num ${(row.hypothetical_pnl ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                                {(row.hypothetical_pnl ?? 0) >= 0 ? "+" : ""}
                                {(row.hypothetical_pnl ?? 0).toFixed(2)}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => handleApplyGridWinner(row)}
                                  disabled={applyingGridWinner || !selectedIndicator}
                                  title={selectedIndicator ? `Apply to ${selectedIndicator.name}` : "No indicator resolved for this rule"}
                                >
                                  Apply
                                </button>
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
          </>
          )}
        </section>
      )}
    </>
  );
}

function RulesTab() {
  return (
    <>
      <InfoDisclosure summary="What's a Rule?">
        <p>
          A Rule is a saved, reusable definition of <em>when a signal should fire</em> - the underlying to watch,
          which condition (crossover/breakout/range-breakout) decides it, and (for an external provider) just a
          name/description reference, since that provider evaluates its own scan and we never do. One Rule can back
          any number of Strategies - the Strategies tab picks a Rule by name instead of configuring this itself.
        </p>
        <p>
          Select an in-house rule below to backtest it before pointing a Strategy at it - a Rule alone doesn't know
          what gets traded (spot/future/option) or its exit config, so the Backtest panel asks for those as one-off
          overrides rather than reading them from a Strategy.
        </p>
      </InfoDisclosure>
      <RuleManager />
      <IndicatorsTab />
    </>
  );
}

function StrategyManager() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [signals, setSignals] = useState<ProviderSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  // All/In-house/External filter over the fetched list - there's one
  // unified tab now, so this replaces the old per-tab server-side filter.
  const [sourceFilter, setSourceFilter] = useState<"all" | "in_house" | "external">("all");

  const [name, setName] = useState("");
  // Rule is in-house only now (see api.ts's Rule/Strategy comments) - a
  // Strategy needs its own Source selector again since source_type can no
  // longer be derived from a picked Rule's own source_type.
  const [sourceKind, setSourceKind] = useState<"in_house" | "external">("in_house");
  const [externalSourceName, setExternalSourceName] = useState("");
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const [instrumentType, setInstrumentType] = useState<InstrumentType>("spot");
  const [ruleId, setRuleId] = useState("");
  const [slMethod, setSlMethod] = useState<StopLossMethod | "">("");
  const [slInterval, setSlInterval] = useState<StopLossInterval | "">("");
  const [slPercent, setSlPercent] = useState("");
  // stop_loss_method='indicator' only - one type today ('ema'), see
  // StopLossIndicatorType in api.ts.
  const [slIndicatorType, setSlIndicatorType] = useState<StopLossIndicatorType>("ema");
  const [slIndicatorPeriod, setSlIndicatorPeriod] = useState("");
  const [targetPercent, setTargetPercent] = useState("");
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  // instrument_type='option' only - see OptionPositionStyle in api.ts.
  const [optionPositionStyle, setOptionPositionStyle] = useState<OptionPositionStyle>("spread");
  const [optionStrikeMoneyness, setOptionStrikeMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [optionSlScope, setOptionSlScope] = useState<OptionSlScope>("combined");
  // instrument_type='option' only, optional - see option_fixed_lots in api.ts.
  const [optionFixedLots, setOptionFixedLots] = useState("");
  // instrument_type in ('future', 'option') only - see ContractDayFilter in api.ts.
  const [contractDayFilter, setContractDayFilter] = useState<ContractDayFilter>("any");
  const [segment, setSegment] = useState<Segment>("NSE");
  // Optional per-strategy signal-acceptance window(s) (e.g. 09:15-11:00,
  // or several) - every source_type, not gated behind in-house. See
  // Strategy's own comment in api.ts. Bare "HH:MM" per row (native
  // <input type="time"> shape) - converted to "HH:MM:SS" pairs only when
  // building the create payload; incomplete rows (either side blank) are
  // dropped rather than submitted.
  const [activeWindows, setActiveWindows] = useState<{ start: string; end: string }[]>([]);
  const [dupPolicy, setDupPolicy] = useState<DuplicateSignalPolicy>("skip");
  const [counterPolicy, setCounterPolicy] = useState<CounterSignalPolicy>("close_and_flip");
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editHorizon, setEditHorizon] = useState<Horizon>("intraday");
  const [editInstrumentType, setEditInstrumentType] = useState<InstrumentType>("spot");
  const [editRuleId, setEditRuleId] = useState("");
  const [editSlMethod, setEditSlMethod] = useState<StopLossMethod | "">("");
  const [editSlInterval, setEditSlInterval] = useState<StopLossInterval | "">("");
  const [editSlPercent, setEditSlPercent] = useState("");
  const [editSlIndicatorType, setEditSlIndicatorType] = useState<StopLossIndicatorType>("ema");
  const [editSlIndicatorPeriod, setEditSlIndicatorPeriod] = useState("");
  const [editTargetPercent, setEditTargetPercent] = useState("");
  const [editTrailingEnabled, setEditTrailingEnabled] = useState(false);
  const [editOptionPositionStyle, setEditOptionPositionStyle] = useState<OptionPositionStyle>("spread");
  const [editOptionStrikeMoneyness, setEditOptionStrikeMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [editOptionSlScope, setEditOptionSlScope] = useState<OptionSlScope>("combined");
  const [editOptionFixedLots, setEditOptionFixedLots] = useState("");
  const [editContractDayFilter, setEditContractDayFilter] = useState<ContractDayFilter>("any");
  const [editSegment, setEditSegment] = useState<Segment>("NSE");
  const [editActiveWindows, setEditActiveWindows] = useState<{ start: string; end: string }[]>([]);
  const [editDupPolicy, setEditDupPolicy] = useState<DuplicateSignalPolicy>("skip");
  const [editCounterPolicy, setEditCounterPolicy] = useState<CounterSignalPolicy>("close_and_flip");
  const [saving, setSaving] = useState(false);

  // Manual test-signal mini-form - which strategy row it's open for (null
  // = closed), reusing that strategy's own `segment` as the signal's
  // `exchange` rather than asking for it again. See sendManualSignal in
  // api.ts - a thin wrapper around signal-processing's own generic
  // POST /signals, the exact same ingest path a real signal takes.
  const [sendSignalId, setSendSignalId] = useState<string | null>(null);
  const [signalSymbol, setSignalSymbol] = useState("");
  const [signalAction, setSignalAction] = useState<"BUY" | "SELL">("BUY");
  const [signalPrice, setSignalPrice] = useState("");
  const [sendingSignal, setSendingSignal] = useState(false);
  const [sendSignalError, setSendSignalError] = useState<string | null>(null);
  const [sendSignalNotice, setSendSignalNotice] = useState<string | null>(null);

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

  // Rules - fetched once here, shared by the create form's Rule picker
  // and every strategy row's edit form. Full Rule CRUD lives on its own
  // tab now - see RuleManager.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchRules();
        if (!cancelled) setRules(data);
      } catch {
        // keep showing the last known rules rather than clearing on a blip
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

  const filteredStrategies = strategies.filter((s) => {
    if (sourceFilter === "all") return true;
    const strategyIsInHouse = s.source_type === "in_house";
    return sourceFilter === "in_house" ? strategyIsInHouse : !strategyIsInHouse;
  });
  // Rule is in-house only now - every rule in the list qualifies, sorted
  // alphabetically by name.
  const createIsInHouse = sourceKind === "in_house";
  const createRuleOptions = [...rules].sort((a, b) => a.name.localeCompare(b.name));

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (createIsInHouse && !ruleId) return; // submit is disabled without a picked rule - defensive guard
    if (!createIsInHouse && !externalSourceName.trim()) return; // submit is disabled without a source name - defensive guard
    setCreating(true);
    try {
      const created = await createStrategy({
        name,
        source_type: createIsInHouse ? "in_house" : externalSourceName.trim(),
        horizon,
        instrument_type: instrumentType,
        rule_id: createIsInHouse ? ruleId : undefined,
        stop_loss_method: slMethod || undefined,
        stop_loss_interval:
          slMethod === "previous_candle" || slMethod === "indicator" ? slInterval || undefined : undefined,
        stop_loss_percent: slMethod === "percent" && slPercent ? Number(slPercent) : undefined,
        stop_loss_indicator_type: slMethod === "indicator" ? slIndicatorType : undefined,
        stop_loss_indicator_params:
          slMethod === "indicator" && slIndicatorPeriod ? { period: Number(slIndicatorPeriod) } : undefined,
        target_percent: targetPercent ? Number(targetPercent) : undefined,
        trailing_stop_enabled: slMethod ? trailingEnabled : undefined,
        option_position_style: instrumentType === "option" ? optionPositionStyle : undefined,
        option_strike_moneyness: instrumentType === "option" ? optionStrikeMoneyness : undefined,
        option_sl_scope: instrumentType === "option" ? optionSlScope : undefined,
        option_fixed_lots: instrumentType === "option" && optionFixedLots ? Number(optionFixedLots) : undefined,
        contract_day_filter:
          instrumentType === "future" || instrumentType === "option" ? contractDayFilter : undefined,
        segment,
        duplicate_signal_policy: dupPolicy,
        counter_signal_policy: counterPolicy,
        active_windows: activeWindows
          .filter((w) => w.start && w.end)
          .map((w) => ({ start: `${w.start}:00`, end: `${w.end}:00` })),
      });
      setName("");
      setSourceKind("in_house");
      setExternalSourceName("");
      setRuleId("");
      setSlMethod("");
      setSlInterval("");
      setSlPercent("");
      setSlIndicatorPeriod("");
      setTargetPercent("");
      setTrailingEnabled(false);
      setOptionPositionStyle("spread");
      setOptionStrikeMoneyness("ATM");
      setOptionSlScope("combined");
      setOptionFixedLots("");
      setContractDayFilter("any");
      setSegment("NSE");
      setActiveWindows([]);
      setDupPolicy("skip");
      setCounterPolicy("close_and_flip");
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
    setEditRuleId(s.rule_id ?? "");
    setEditSlMethod(s.stop_loss_method ?? "");
    setEditSlInterval(s.stop_loss_interval ?? "");
    setEditSlPercent(s.stop_loss_percent != null ? String(s.stop_loss_percent) : "");
    setEditSlIndicatorType(s.stop_loss_indicator_type ?? "ema");
    setEditSlIndicatorPeriod(s.stop_loss_indicator_params?.period != null ? String(s.stop_loss_indicator_params.period) : "");
    setEditTargetPercent(s.target_percent != null ? String(s.target_percent) : "");
    setEditTrailingEnabled(s.trailing_stop_enabled);
    setEditOptionPositionStyle(s.option_position_style);
    setEditOptionStrikeMoneyness(s.option_strike_moneyness);
    setEditOptionSlScope(s.option_sl_scope);
    setEditOptionFixedLots(s.option_fixed_lots != null ? String(s.option_fixed_lots) : "");
    setEditContractDayFilter(s.contract_day_filter);
    setEditSegment(s.segment);
    setEditActiveWindows(s.active_windows.map((w) => ({ start: w.start.slice(0, 5), end: w.end.slice(0, 5) })));
    setEditDupPolicy(s.duplicate_signal_policy);
    setEditCounterPolicy(s.counter_signal_policy);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      const updated = await updateStrategy(id, {
        name: editName,
        horizon: editHorizon,
        instrument_type: editInstrumentType,
        rule_id: editRuleId || undefined,
        stop_loss_method: editSlMethod || undefined,
        stop_loss_interval:
          editSlMethod === "previous_candle" || editSlMethod === "indicator" ? editSlInterval || undefined : undefined,
        stop_loss_percent: editSlMethod === "percent" && editSlPercent ? Number(editSlPercent) : undefined,
        stop_loss_indicator_type: editSlMethod === "indicator" ? editSlIndicatorType : undefined,
        stop_loss_indicator_params:
          editSlMethod === "indicator" && editSlIndicatorPeriod ? { period: Number(editSlIndicatorPeriod) } : undefined,
        target_percent: editTargetPercent ? Number(editTargetPercent) : undefined,
        trailing_stop_enabled: editSlMethod ? editTrailingEnabled : undefined,
        option_position_style: editInstrumentType === "option" ? editOptionPositionStyle : undefined,
        option_strike_moneyness: editInstrumentType === "option" ? editOptionStrikeMoneyness : undefined,
        option_sl_scope: editInstrumentType === "option" ? editOptionSlScope : undefined,
        option_fixed_lots:
          editInstrumentType === "option" && editOptionFixedLots ? Number(editOptionFixedLots) : undefined,
        contract_day_filter:
          editInstrumentType === "future" || editInstrumentType === "option" ? editContractDayFilter : undefined,
        segment: editSegment,
        duplicate_signal_policy: editDupPolicy,
        counter_signal_policy: editCounterPolicy,
        active_windows: editActiveWindows
          .filter((w) => w.start && w.end)
          .map((w) => ({ start: `${w.start}:00`, end: `${w.end}:00` })),
      });
      setStrategies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update strategy");
    } finally {
      setSaving(false);
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

  function handleToggleSendSignal(s: Strategy) {
    if (sendSignalId === s.id) {
      setSendSignalId(null);
      return;
    }
    setSendSignalId(s.id);
    setSignalSymbol("");
    setSignalAction("BUY");
    setSignalPrice("");
    setSendSignalError(null);
    setSendSignalNotice(null);
  }

  async function handleSendSignal(s: Strategy) {
    setSendingSignal(true);
    setSendSignalError(null);
    setSendSignalNotice(null);
    const symbol = signalSymbol.trim().toUpperCase();
    try {
      let price = Number(signalPrice);
      if (!signalPrice) {
        try {
          price = await fetchLtp(s.segment, symbol);
        } catch (err) {
          throw new Error(
            `Could not fetch current market price for ${symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      const result = await sendManualSignal({
        strategy_id: s.id,
        symbol,
        exchange: s.segment,
        action: signalAction,
        price,
      });
      setSendSignalNotice(`Sent (${result.status}) at ${price} - see "Recent signals" below once it refreshes.`);
      setSignalSymbol("");
      setSignalPrice("");
    } catch (err) {
      setSendSignalError(err instanceof Error ? err.message : "Failed to send signal");
    } finally {
      setSendingSignal(false);
    }
  }

  const nonDefaultConfig = horizon !== "intraday" || instrumentType !== "spot";
  // Name, Status, Source, Horizon, Instrument, Stop-loss, Target, Segment,
  // Rule, Active window, Webhooks, actions - matches the <thead> below
  // exactly (all columns always present now, one unified table for every
  // source type).
  const colCount = 12;

  return (
    <>
      <details className="panel collapsible-panel">
        <summary>
          <h2>New strategy</h2>
        </summary>
        <form className="strategy-form" onSubmit={handleCreate}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Bullish Breakout v1" />
          </label>
          <label>
            Source
            <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as "in_house" | "external")}>
              <option value="in_house">In-house</option>
              <option value="external">External (webhook provider)</option>
            </select>
          </label>
          {!createIsInHouse && (
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
            Horizon
            <select value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
              <option value="intraday">Intraday</option>
              <option value="swing">Swing</option>
              <option value="positional">Positional</option>
            </select>
          </label>
          <label>
            Instrument
            <select
              value={instrumentType}
              onChange={(e) => {
                const next = e.target.value as InstrumentType;
                setInstrumentType(next);
                if (next === "future" && contractDayFilter === "start") setContractDayFilter("any");
              }}
            >
              <option value="spot">Spot</option>
              <option value="future">Future</option>
              <option value="option">Option</option>
            </select>
          </label>
          {instrumentType === "option" && (
            <label>
              Option style
              <select value={optionPositionStyle} onChange={(e) => setOptionPositionStyle(e.target.value as OptionPositionStyle)}>
                <option value="spread">Spread (bull call / bear put)</option>
                <option value="naked">Naked (single long call/put)</option>
              </select>
            </label>
          )}
          {instrumentType === "option" && (
            <label>
              Primary leg strike
              <select
                value={optionStrikeMoneyness}
                onChange={(e) => setOptionStrikeMoneyness(e.target.value as OptionStrikeMoneyness)}
              >
                <option value="ITM2">ITM2</option>
                <option value="ITM1">ITM1</option>
                <option value="ATM">ATM</option>
                <option value="OTM1">OTM1</option>
                <option value="OTM2">OTM2</option>
              </select>
            </label>
          )}
          {instrumentType === "option" && (
            <label>
              SL/target scope
              <select value={optionSlScope} onChange={(e) => setOptionSlScope(e.target.value as OptionSlScope)}>
                <option value="combined">Combined (net debit)</option>
                <option value="individual">Individual (per leg)</option>
              </select>
            </label>
          )}
          {instrumentType === "option" && (
            <label>
              Fixed lots (optional)
              <input
                type="number"
                min="1"
                step="1"
                placeholder="Auto (capital/risk-based)"
                value={optionFixedLots}
                onChange={(e) => setOptionFixedLots(e.target.value)}
              />
            </label>
          )}
          {(instrumentType === "future" || instrumentType === "option") && (
            <label>
              Contract day
              <select value={contractDayFilter} onChange={(e) => setContractDayFilter(e.target.value as ContractDayFilter)}>
                <option value="any">Any day</option>
                {instrumentType === "option" && <option value="start">Contract start day</option>}
                <option value="expiry">Expiry day</option>
              </select>
            </label>
          )}
          <label>
            Stop-loss <span className="optional">(optional)</span>
            <select value={slMethod} onChange={(e) => setSlMethod(e.target.value as StopLossMethod | "")}>
              <option value="">&mdash;</option>
              <option value="previous_candle">Previous candle low/high</option>
              <option value="percent">% from entry</option>
              <option value="indicator">Indicator</option>
            </select>
          </label>
          {(slMethod === "previous_candle" || slMethod === "indicator") && (
            <label>
              SL candle interval
              <select value={slInterval} onChange={(e) => setSlInterval(e.target.value as StopLossInterval | "")}>
                <option value="">&mdash;</option>
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
          {slMethod === "indicator" && (
            <>
              <label>
                Indicator type
                <select value={slIndicatorType} onChange={(e) => setSlIndicatorType(e.target.value as StopLossIndicatorType)}>
                  <option value="ema">EMA</option>
                </select>
              </label>
              <label>
                EMA period
                <input
                  type="number"
                  min="2"
                  value={slIndicatorPeriod}
                  onChange={(e) => setSlIndicatorPeriod(e.target.value)}
                  placeholder="e.g. 20"
                />
              </label>
            </>
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
            <label>
              Rule
              <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} required>
                <option value="">&mdash;</option>
                {createRuleOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {createIsInHouse && createRuleOptions.length === 0 && (
            <p className="hint">No rules yet - create one on the Rules tab first.</p>
          )}
          {createIsInHouse && (
            <p className="hint">Regime filters (optional) are configured on the Rule itself - see the Rules tab.</p>
          )}
          <div className="active-windows-field">
            <span className="muted">Active window(s) (optional)</span>
            <ActiveWindowsEditor windows={activeWindows} onChange={setActiveWindows} />
          </div>
          <button
            type="submit"
            disabled={
              creating ||
              !name.trim() ||
              (createIsInHouse && !ruleId) ||
              (!createIsInHouse && !externalSourceName.trim()) ||
              activeWindows.some((w) => !!w.start !== !!w.end) ||
              activeWindows.some((w) => w.start && w.end && w.end <= w.start)
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
          &mdash; same limitation as Rule. Delete and recreate the strategy if you need to remove it entirely.
        </p>
        <p className="hint">
          Square-off is configured per-segment now, not per-strategy - see execution's Accounts/Settings page.
          Any intraday position still open past that segment's square-off time gets forcefully closed there.
        </p>
      </details>

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
            <th>Stop-loss</th>
            <th>Target</th>
            <th>Segment</th>
            <th>Rule</th>
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
          {filteredStrategies.map((s) => (
            <Fragment key={s.id}>
            {editingId === s.id ? (
              <tr className="editing-row" onClick={(e) => e.stopPropagation()}>
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
                    onChange={(e) => {
                      const next = e.target.value as InstrumentType;
                      setEditInstrumentType(next);
                      if (next === "future" && editContractDayFilter === "start") setEditContractDayFilter("any");
                    }}
                    className="cell-input"
                  >
                    <option value="spot">Spot</option>
                    <option value="future">Future</option>
                    <option value="option">Option</option>
                  </select>
                  {editInstrumentType === "option" && (
                    <select
                      value={editOptionPositionStyle}
                      onChange={(e) => setEditOptionPositionStyle(e.target.value as OptionPositionStyle)}
                      className="cell-input"
                    >
                      <option value="spread">Spread</option>
                      <option value="naked">Naked</option>
                    </select>
                  )}
                  {editInstrumentType === "option" && (
                    <select
                      value={editOptionStrikeMoneyness}
                      onChange={(e) => setEditOptionStrikeMoneyness(e.target.value as OptionStrikeMoneyness)}
                      className="cell-input"
                    >
                      <option value="ITM2">ITM2</option>
                      <option value="ITM1">ITM1</option>
                      <option value="ATM">ATM</option>
                      <option value="OTM1">OTM1</option>
                      <option value="OTM2">OTM2</option>
                    </select>
                  )}
                  {editInstrumentType === "option" && (
                    <select
                      value={editOptionSlScope}
                      onChange={(e) => setEditOptionSlScope(e.target.value as OptionSlScope)}
                      className="cell-input"
                    >
                      <option value="combined">Combined</option>
                      <option value="individual">Individual</option>
                    </select>
                  )}
                  {editInstrumentType === "option" && (
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="Fixed lots (auto)"
                      value={editOptionFixedLots}
                      onChange={(e) => setEditOptionFixedLots(e.target.value)}
                      className="cell-input"
                    />
                  )}
                  {(editInstrumentType === "future" || editInstrumentType === "option") && (
                    <select
                      value={editContractDayFilter}
                      onChange={(e) => setEditContractDayFilter(e.target.value as ContractDayFilter)}
                      className="cell-input"
                    >
                      <option value="any">Any day</option>
                      {editInstrumentType === "option" && <option value="start">Start day</option>}
                      <option value="expiry">Expiry day</option>
                    </select>
                  )}
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
                      <option value="indicator">Indicator</option>
                    </select>
                    {(editSlMethod === "previous_candle" || editSlMethod === "indicator") && (
                      <select
                        value={editSlInterval}
                        onChange={(e) => setEditSlInterval(e.target.value as StopLossInterval | "")}
                        className="cell-input"
                      >
                        <option value="">&mdash;</option>
                        <option value="1min">1 min</option>
                        <option value="3min">3 min</option>
                        <option value="5min">5 min</option>
                        <option value="15min">15 min</option>
                        <option value="25min">25 min</option>
                        <option value="30min">30 min</option>
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
                    {editSlMethod === "indicator" && (
                      <>
                        <select
                          value={editSlIndicatorType}
                          onChange={(e) => setEditSlIndicatorType(e.target.value as StopLossIndicatorType)}
                          className="cell-input"
                        >
                          <option value="ema">EMA</option>
                        </select>
                        <input
                          type="number"
                          min="2"
                          value={editSlIndicatorPeriod}
                          onChange={(e) => setEditSlIndicatorPeriod(e.target.value)}
                          className="cell-input"
                          placeholder="period"
                        />
                      </>
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
                  {s.source_type === "in_house" ? (
                    <select value={editRuleId} onChange={(e) => setEditRuleId(e.target.value)} className="cell-input">
                      <option value="">&mdash;</option>
                      {rules.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td className="stack-cell">
                  <ActiveWindowsEditor windows={editActiveWindows} onChange={setEditActiveWindows} />
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
                      editActiveWindows.some((w) => !!w.start !== !!w.end) ||
                      editActiveWindows.some((w) => w.start && w.end && w.end <= w.start)
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
              <tr className={s.id === selected ? "selected-row" : ""} onClick={() => setSelected(s.id)}>
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
                <td>
                  {s.instrument_type}
                  {s.instrument_type === "option" && (
                    <span className="muted">
                      {" "}
                      ({s.option_position_style}
                      {s.option_strike_moneyness !== "ATM" ? `, ${s.option_strike_moneyness}` : ""}
                      {s.option_sl_scope !== "combined" ? `, ${s.option_sl_scope} SL` : ""}
                      {s.option_fixed_lots != null ? `, ${s.option_fixed_lots} lots fixed` : ""}
                      {s.contract_day_filter !== "any" ? `, ${s.contract_day_filter} day` : ""})
                    </span>
                  )}
                  {s.instrument_type === "future" && s.contract_day_filter !== "any" && (
                    <span className="muted"> ({s.contract_day_filter} day)</span>
                  )}
                </td>
                <td>{formatStopLoss(s)}</td>
                <td>{formatTarget(s)}</td>
                <td>{s.segment}</td>
                <td className="muted">{s.rule?.name ?? "-"}</td>
                <td className="muted">{formatActiveWindows(s)}</td>
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
                  {s.status !== "live" && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleToggleSendSignal(s)}
                      title={`Send a manual test signal for "${s.name}"`}
                      aria-label={`Send a manual test signal for "${s.name}"`}
                    >
                      <SendIcon />
                    </button>
                  )}
                </td>
              </tr>
            )}
            {sendSignalId === s.id && s.status !== "live" && (
              <tr className="editing-row" onClick={(e) => e.stopPropagation()}>
                <td colSpan={colCount}>
                  <div className="strategy-form">
                    <label>
                      Symbol
                      <input
                        value={signalSymbol}
                        onChange={(e) => setSignalSymbol(e.target.value.toUpperCase())}
                        placeholder="e.g. BTCUSD, TCS, GOLDM-04Sep2026-FUT"
                        autoFocus
                      />
                    </label>
                    <label>
                      Action
                      <select value={signalAction} onChange={(e) => setSignalAction(e.target.value as "BUY" | "SELL")}>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </label>
                    <label>
                      Price (optional)
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={signalPrice}
                        onChange={(e) => setSignalPrice(e.target.value)}
                        placeholder="Blank = current market price"
                      />
                    </label>
                    <span className="muted">Exchange: {s.segment} (from this strategy's own segment)</span>
                    <button
                      type="button"
                      onClick={() => handleSendSignal(s)}
                      disabled={sendingSignal || !signalSymbol.trim()}
                    >
                      {sendingSignal ? "Sending..." : "Send test signal"}
                    </button>
                    <button type="button" className="secondary" onClick={() => setSendSignalId(null)}>
                      Close
                    </button>
                  </div>
                  {sendSignalError && <p className="error">{sendSignalError}</p>}
                  {sendSignalNotice && <p className="hint">{sendSignalNotice}</p>}
                  <p className="hint">
                    Posts a real signal via signal-processing's own POST /signals (source="manual") - runs through
                    the exact same resolution/conflict-policy pipeline a webhook or in-house signal would, except
                    it's exempt from the "strategy must be live" check (draft/backtesting/paused all work) so you
                    can test before activating - every other rejection reason (active window, duplicate/counter
                    signal policy, unresolvable symbol, ...) still applies exactly as it would for a real signal.
                    Type the exact tradable symbol (for futures, the full contract symbol, not the bare underlying)
                    - nothing here resolves it for you. Leave price blank to fetch the current market price
                    (market-data's GET /quotes/ltp) at send time.
                  </p>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>

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
          Every strategy - in-house or external - gets its own <code>?strategy_id=</code> query param. There's no
          separate Source field here anymore: a strategy just picks a saved <strong>Rule</strong> (see the Rules
          tab), and inherits that Rule's own source directly - an external Rule already names its provider (e.g.
          "chartink", "tradingview", or anything else) when it's created, so a strategy pointed at it is external
          too, with no need to retype the name. Today only Chartink has a real webhook route wired up on
          signal-processing (one route per direction handles <em>every</em> Chartink strategy via that query
          param) - copy its buy/sell webhook URLs (the clipboard icons in the Webhooks column below) into a
          Chartink scan alert once created. Any other provider name is recorded but has no webhook wired up yet -
          adding one follows the same pattern (a new parse function normalizing that provider's alert payload
          into the canonical signal shape, see the <code>add-signal-provider</code> Claude Code skill).
        </p>
        <p>
          An in-house strategy's rule runs off this system's own indicator/price-action engine - a periodic job
          checks every <strong>live</strong> in-house strategy for a fresh signal on its rule's underlying and
          posts it into the same pipeline external providers use. Backtest a rule from the Rules tab before
          pointing a strategy at it.
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
        <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>
          Rules
        </button>
        <button className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>
          Manual
        </button>
      </nav>

      {tab === "strategies" && <StrategiesTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "manual" && <ManualTab />}
    </main>
  );
}

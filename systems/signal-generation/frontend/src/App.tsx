import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ALL_WEEKDAYS,
  DEFAULT_ACTIVE_WEEKDAYS,
  INDICATOR_TYPE_LABELS,
  REGIME_INDICATOR_TYPES,
  type ActiveWindow,
  type BacktestResult,
  type ContractDayFilter,
  type CounterSignalPolicy,
  type CandleCacheStatus,
  type DataAvailability,
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
  type RuleBacktestRequest,
  type SavedBacktestSummary,
  type Segment,
  type SourceType,
  type StopLossConfirmation,
  type StopLossIndicatorParams,
  type StopLossIndicatorType,
  type StopLossInterval,
  type StopLossMethod,
  type Strategy,
  type StrategyStatus,
  type UnderlyingType,
  type UniverseBacktestResult,
  type Weekday,
  backtestRule,
  backtestRuleGrid,
  createIndicator,
  createRule,
  clearCandleCache,
  createSavedBacktest,
  createStrategy,
  deleteIndicator,
  deleteRule,
  deleteSavedBacktest,
  deleteStrategy,
  fetchCandleCacheStatus,
  fetchDataAvailability,
  fetchIndicators,
  fetchLtp,
  fetchRules,
  fetchSignalsForStrategy,
  fetchStrategies,
  getSavedBacktest,
  listSavedBacktests,
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

// A performance advisory (not a real data-availability limit) for the
// Backtest tab's From/To range - finer intervals mean far more bars to
// fetch/simulate for the same date span, so this scales the "reasonable"
// range down as the interval gets finer. "daily" is deliberately absent
// (unlimited - far too few bars/day for this to ever matter). See
// backtestRangeExceedsIntervalThreshold's own comment for why this only
// warns rather than blocking Run backtest.
const INTERVAL_MAX_BACKTEST_DAYS: Partial<Record<Interval, number>> = {
  "1min": 7,
  "3min": 14,
  "5min": 30,
  "15min": 90,
  "30min": 180,
  "60min": 365,
};

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
  supertrend: [
    { key: "period", label: "ATR period", min: "2" },
    { key: "multiplier", label: "Band multiplier", min: "0", step: "0.1" },
  ],
};

const INDICATOR_PARAM_DEFAULTS: Record<IndicatorType, Record<string, string>> = {
  rsi: { period: "14", sma_period: "9" },
  structure: { swing_lookback: "3" },
  efficiency_ratio: { period: "14", trend_threshold: "0.35" },
  adx: { period: "14", trend_threshold: "20" },
  dmi_direction: { period: "14" },
  ema_slope: { ema_period: "20", slope_lookback: "5", slope_threshold: "0.15", atr_period: "14" },
  supertrend: { period: "10", multiplier: "3" },
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

// Inclusive day count between two "YYYY-MM-DD" dates - backs the backtest
// form's DataAvailability warning (does the picked range exceed Dhan's
// max_days_per_request, or start before Delta's earliest_available_date).
function daysBetweenDates(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

// "15min" -> 15, "60min" -> 60 - null for "daily" (no sensible time-of-day
// bucket size for it). Used to default the Backtest tab's time-of-day
// bucket to whatever the selected rule's own interval is.
function intervalToMinutes(interval: Interval): number | null {
  const match = /^(\d+)min$/.exec(interval);
  return match ? Number(match[1]) : null;
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
        ? `${(s.stop_loss_indicator_type ?? "indicator").toUpperCase()}(${
            s.stop_loss_indicator_type === "supertrend"
              ? `${s.stop_loss_indicator_params?.period ?? "?"}, ${s.stop_loss_indicator_params?.multiplier ?? "?"}`
              : s.stop_loss_indicator_params?.period ?? "?"
          })`
        : `${s.stop_loss_percent}%`;
  return s.trailing_stop_enabled ? `${base}, trailing` : base;
}

// Builds the stop_loss_indicator_params object for whichever
// StopLossIndicatorType is selected - 'ema' uses only period, 'supertrend'
// needs multiplier too. Shared by the Backtest tab, Grid search tab (single,
// non-swept value), the create-strategy form, and the edit-row form below,
// so the type->shape mapping only lives in one place. Returns undefined if
// the required field(s) for the given type aren't filled in yet.
function buildStopLossIndicatorParams(
  type: StopLossIndicatorType,
  period: string,
  multiplier: string,
): StopLossIndicatorParams | undefined {
  if (!period) return undefined;
  if (type === "supertrend") {
    if (!multiplier) return undefined;
    return { period: Number(period), multiplier: Number(multiplier) };
  }
  return { period: Number(period) };
}

function formatTarget(s: Strategy): string {
  return s.target_percent != null ? `${s.target_percent}%` : "-";
}

function formatActiveWindows(s: Strategy): string {
  if (s.active_windows.length === 0) return "-";
  return s.active_windows.map((w) => `${w.start.slice(0, 5)}–${w.end.slice(0, 5)}`).join(", ");
}

function formatActiveWeekdays(s: Strategy): string {
  // Empty AND all-7-present are semantically identical (unrestricted -
  // every day accepted) - collapse both to the same "-" display, since a
  // freshly created strategy now stores all 7 explicitly by default (see
  // activeWeekdays' own comment) rather than an empty array.
  if (s.active_weekdays.length === 0 || s.active_weekdays.length === ALL_WEEKDAYS.length) return "-";
  // Preserve Mon-Sun order regardless of how they were selected/stored.
  return ALL_WEEKDAYS.filter((d) => s.active_weekdays.includes(d)).join(", ");
}

// A repeatable list of {start, end} time-of-day pairs - shared by the
// create form and the edit-row form below. `windows` uses bare "HH:MM"
// (native <input type="time"> values); the caller converts to "HH:MM:SS"
// only when building the actual API payload.
// One pending {start, end} pair (own local state, not part of `windows`
// until "Add" is clicked) plus a compact list of already-added windows,
// each removable via its own [X] - replaces the old always-editable-row-
// per-window design, which left a lot of empty input pairs on screen and
// let malformed (partial/backwards) entries sit in `windows` until
// submit-time validation caught them. Now `windows` only ever holds
// complete, valid pairs - "Add" is disabled otherwise - so callers no
// longer need their own start/end validation before submitting.
function ActiveWindowsEditor({
  windows,
  onChange,
}: {
  windows: { start: string; end: string }[];
  onChange: (windows: { start: string; end: string }[]) => void;
}) {
  const [pendingStart, setPendingStart] = useState("");
  const [pendingEnd, setPendingEnd] = useState("");
  const canAdd = !!pendingStart && !!pendingEnd && pendingEnd > pendingStart;

  function handleAdd() {
    if (!canAdd) return;
    onChange([...windows, { start: pendingStart, end: pendingEnd }]);
    setPendingStart("");
    setPendingEnd("");
  }

  return (
    <div className="active-windows-editor">
      <div className="active-window-row">
        <input type="time" value={pendingStart} onChange={(e) => setPendingStart(e.target.value)} />
        <span className="muted">&ndash;</span>
        <input type="time" value={pendingEnd} onChange={(e) => setPendingEnd(e.target.value)} />
        <button type="button" className="secondary" onClick={handleAdd} disabled={!canAdd}>
          Add
        </button>
      </div>
      {windows.length > 0 && (
        <ul className="active-windows-list">
          {windows.map((w, i) => (
            <li key={i}>
              <span>
                {w.start} &ndash; {w.end}
              </span>
              <button
                type="button"
                className="icon-btn tiny"
                onClick={() => onChange(windows.filter((_, j) => j !== i))}
                aria-label={`Remove window ${w.start}-${w.end}`}
              >
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 2-letter labels, display-only - the underlying Weekday value stays the
// full 3-letter abbreviation ("Mon" etc.) everywhere else (state, API
// payload, table display) - this is purely to keep the checkbox row
// compact enough to stay on one line.
const WEEKDAY_SHORT_LABELS: Record<Weekday, string> = {
  Mon: "Mo", Tue: "Tu", Wed: "We", Thu: "Th", Fri: "Fr", Sat: "Sa", Sun: "Su",
};

// A Mon-Sun checkbox row - shared by the create form and the edit-row form
// below, same reuse shape as ActiveWindowsEditor above. Deliberately
// single-row/compact (flex-wrap: nowrap in CSS) - see .weekdays-editor.
function WeekdaysEditor({ selected, onChange }: { selected: Weekday[]; onChange: (days: Weekday[]) => void }) {
  return (
    <div className="weekdays-editor">
      {ALL_WEEKDAYS.map((day) => (
        <label key={day} className="checkbox-label tiny weekday-checkbox">
          <input
            type="checkbox"
            checked={selected.includes(day)}
            onChange={(e) => onChange(e.target.checked ? [...selected, day] : selected.filter((d) => d !== day))}
          />
          {WEEKDAY_SHORT_LABELS[day]}
        </label>
      ))}
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

// Consolidates the strategy table's Stop-loss/Target/Active window/Active
// weekdays/Webhooks columns into one hover tooltip behind an info icon -
// these 5 don't need to be visible at a glance for every row, and each
// having its own column made the table very wide. Webhooks still needs
// real click-to-copy buttons (WebhookLinks), not just plain text, so this
// is a real floating panel (CSS :hover/:focus-within, see
// .info-tooltip-wrap in index.css), not a native `title` attribute -
// moving the pointer from the icon down into the panel keeps it open
// since :hover applies to the whole wrapper, not just the icon itself.
function StrategyInfoCell({ s }: { s: Strategy }) {
  // Portaled to document.body with JS-computed `position: fixed`
  // coordinates, NOT a plain CSS `:hover`-shown absolute child - the
  // strategy table has `overflow: hidden` (for its own rounded corners),
  // which silently clips any absolutely-positioned descendant that
  // extends past the table's box, tooltip included. Escaping the table
  // via a portal sidesteps that entirely. A short close delay (not an
  // instant hide-on-mouseleave) covers the small dead gap between the
  // icon and the portaled panel below it, so the pointer can cross into
  // the panel - needed since Webhooks' copy buttons must stay clickable,
  // not just readable.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);

  function open() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }
  function scheduleClose() {
    closeTimer.current = window.setTimeout(() => setPos(null), 150);
  }

  return (
    <span className="info-tooltip-wrap">
      <button
        ref={btnRef}
        type="button"
        className="icon-btn"
        aria-label={`Details for "${s.name}"`}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={scheduleClose}
      >
        <InfoIcon />
      </button>
      {pos &&
        createPortal(
          <div
            className="info-tooltip"
            style={{ top: pos.top, right: pos.right }}
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
          >
            <dl>
              <dt>Source</dt>
              <dd>{s.source_type === "in_house" ? "In-house" : s.source_type}</dd>
              <dt>Horizon</dt>
              <dd>{s.horizon}</dd>
              <dt>Stop-loss</dt>
              <dd>{formatStopLoss(s)}</dd>
              <dt>Target</dt>
              <dd>{formatTarget(s)}</dd>
              <dt>Active window</dt>
              <dd>{formatActiveWindows(s)}</dd>
              <dt>Active weekdays</dt>
              <dd>{formatActiveWeekdays(s)}</dd>
              <dt>Webhooks</dt>
              <dd>
                <WebhookLinks strategyId={s.id} sourceType={s.source_type} />
              </dd>
            </dl>
          </div>,
          document.body,
        )}
    </span>
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
  // error: the rules-list poll's own connectivity status only - cleared
  // on every successful tick. actionError: create/edit/delete's own
  // result, a SEPARATE slot so it isn't silently wiped by the next
  // successful poll tick (5s later, per POLL_INTERVAL_MS) before the user
  // has even had a chance to read it - reproduced live, a delete-rejected
  // 409 message was disappearing within seconds of appearing.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
  const [saving, setSaving] = useState(false);

  // null = the panel is in "create" mode; a rule id = it's editing that
  // rule (pre-filled from it, PATCH instead of POST on submit) - one
  // shared form for both, no separate inline-table-row editing UI.
  // panelOpen is the <details> element's own open state, lifted up so
  // handleStartEdit can force it open (a plain `open` attribute only sets
  // the INITIAL state, not later opens) - closed by default, same
  // collapsible pattern the Strategy form's own panel already uses.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

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
  // stop_loss_indicator_type='supertrend' only - band multiplier, alongside
  // the (type-agnostic) period field above.
  const [backtestSlIndicatorMultiplier, setBacktestSlIndicatorMultiplier] = useState("");
  const [backtestTargetPercent, setBacktestTargetPercent] = useState("");
  const [backtestTrailingEnabled, setBacktestTrailingEnabled] = useState(false);
  // "touch" (default, matches live) vs "close" - a backtest-only what-if,
  // see StopLossConfirmation's own comment in api.ts.
  const [backtestSlConfirmation, setBacktestSlConfirmation] = useState<StopLossConfirmation>("touch");
  const [backtestSquareOffTime, setBacktestSquareOffTime] = useState("");
  // Both-or-neither time-of-day window (blank = no restriction) a fresh
  // signal must fall in to open a trade at all - date range stays the
  // From/To fields above, this is time-of-day only.
  const [backtestEntryWindowStart, setBacktestEntryWindowStart] = useState("");
  const [backtestEntryWindowEnd, setBacktestEntryWindowEnd] = useState("");
  // Which weekdays a fresh signal is allowed to open a trade on - empty
  // means unrestricted, same convention Strategy's own active_weekdays
  // uses (WeekdaysEditor below is the exact same component that field's
  // own create/edit forms use).
  const [backtestEntryWeekdays, setBacktestEntryWeekdays] = useState<Weekday[]>([]);
  // Opt-in - adds time_of_day_breakdown to the report (which time of day
  // this rule is most/least profitable), bucketed into this many
  // clock-aligned minutes. Blank omits it entirely, same as before this
  // existed - not every backtest run needs the extra table.
  const [backtestTimeBucketMinutes, setBacktestTimeBucketMinutes] = useState("");
  // Sortable "P&L by time of day" table below - defaults to the same
  // best-P&L-first order the table always used before sorting existed.
  const [todSortColumn, setTodSortColumn] = useState<"start" | "trade_count" | "win_rate" | "hypothetical_pnl">("hypothetical_pnl");
  const [todSortDir, setTodSortDir] = useState<"asc" | "desc">("desc");
  // Results are split into a "Trades" tab (the raw trade list) and an
  // "Interval breakdown" tab (time-of-day + weekday tables) - only
  // meaningful for a plain (non-pooled) result, which is the only shape
  // with trades/time_of_day_breakdown/weekday_breakdown at the top level.
  const [backtestResultTab, setBacktestResultTab] = useState<"trades" | "interval">("trades");
  const [backtestResult, setBacktestResult] = useState<BacktestResult | UniverseBacktestResult | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // Saved backtests (POST /rules/{id}/saved-backtests) - a frozen
  // request+result snapshot for later reference. "Load" prefills the form
  // above from a saved row's own request (a frontend-only duplicate - the
  // saved row itself is untouched); running + saving again always creates
  // a NEW row, there's no update/overwrite. See api.ts's SavedBacktest*
  // types.
  const [savedBacktests, setSavedBacktests] = useState<SavedBacktestSummary[]>([]);
  const [saveBacktestName, setSaveBacktestName] = useState("");
  const [savingBacktest, setSavingBacktest] = useState(false);
  const [savedBacktestError, setSavedBacktestError] = useState<string | null>(null);
  const [loadingSavedBacktestId, setLoadingSavedBacktestId] = useState<string | null>(null);

  // "Generate Strategy" from a saved backtest row - a compact inline form
  // (just a name) rather than the Strategies tab's own full create form,
  // since RuleManager/StrategyManager are separate components with no
  // shared state to prefill across. Everything else copies straight from
  // the saved row's own request: instrument_type/horizon/stop-loss/
  // target/trailing/option fields map 1:1 onto StrategyCreate,
  // entry_window_start/end (backtest-only) becomes a single active_windows
  // entry, and entry_weekdays maps directly onto active_weekdays (both
  // already the same shape/semantics, just named differently) - same
  // "gates acceptance only" scope both pairs already share. Policy fields
  // StrategyCreate has but a backtest request
  // doesn't (duplicate_signal_policy, counter_signal_policy, fixed_lots,
  // contract_day_filter) are left at their normal defaults, editable
  // after in the Strategies tab like any other Strategy.
  const [generateStrategyRowId, setGenerateStrategyRowId] = useState<string | null>(null);
  const [generateStrategyName, setGenerateStrategyName] = useState("");
  const [generateStrategyRequest, setGenerateStrategyRequest] = useState<RuleBacktestRequest | null>(null);
  const [generatingStrategy, setGeneratingStrategy] = useState(false);
  const [generateStrategyError, setGenerateStrategyError] = useState<string | null>(null);
  const [generateStrategySuccess, setGenerateStrategySuccess] = useState<string | null>(null);

  // What date range is actually usable for the selected rule's symbol -
  // see api.ts's DataAvailability for why NSE/MCX and CRYPTO report
  // genuinely different things here. Re-fetched whenever the rule (or its
  // segment/underlying) changes; null while loading or for underlying_type
  // in ('universe', 'symbol_list') - no single symbol to check for those.
  const [dataAvailability, setDataAvailability] = useState<DataAvailability | null>(null);
  // Whether market-data's own candle-history cache currently holds data
  // for the exact symbol/interval/date-range this form would fetch -
  // re-fetched whenever any of those change (unlike dataAvailability
  // above, this also depends on the date range, not just the symbol/
  // interval), same underlying_type==='symbol'-only restriction.
  const [candleCacheStatus, setCandleCacheStatus] = useState<CandleCacheStatus | null>(null);
  const [resettingCandleCache, setResettingCandleCache] = useState(false);

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
  // stop_loss_indicator_type='supertrend' only - candidate multiplier
  // values, same comma-separated shape. expand_stop_loss_grid has no
  // "current value" fallback (see its own docstring) - both this and the
  // period field above must be filled in together for a supertrend sweep,
  // not just one.
  const [gridSlIndicatorMultiplierValues, setGridSlIndicatorMultiplierValues] = useState("");
  // The alternative sweep dimension for stop_loss_method='percent' instead
  // of 'indicator' - same "filling this in turns the sweep on" standalone
  // behavior as gridSlIndicatorPeriodValues above, just for a candidate
  // list of SL percentages (e.g. "1, 1.5, 2, 2.5") rather than indicator
  // params. Mutually exclusive with the indicator sweep fields above in
  // practice - only one stop_loss_method applies to a given grid run.
  const [gridSlPercentValues, setGridSlPercentValues] = useState("");
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
    setBacktestResultTab("trades");
    setBacktestError(null);
    setGridResult(null);
    setGridError(null);
    setSaveBacktestName("");
    setSavedBacktestError(null);
    setGenerateStrategyRowId(null);
    setGenerateStrategyError(null);
    setGenerateStrategySuccess(null);
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
    // Default the time-of-day bucket to the rule's own interval - almost
    // always the most useful grouping size, same "one less field to fill
    // in" reasoning as the SL interval default above. Blank for "daily"
    // (intervalToMinutes returns null - no sensible bucket size for it).
    const ruleIntervalMinutes = rule ? intervalToMinutes(rule.interval) : null;
    setBacktestTimeBucketMinutes(ruleIntervalMinutes != null ? String(ruleIntervalMinutes) : "");
  }, [selected]);

  const selectedRule = rules.find((r) => r.id === selected);

  useEffect(() => {
    if (!selectedRule || selectedRule.underlying_type !== "symbol") {
      setDataAvailability(null);
      return;
    }
    let cancelled = false;
    fetchDataAvailability(selectedRule.segment, selectedRule.underlying, selectedRule.interval)
      .then((result) => {
        if (!cancelled) setDataAvailability(result);
      })
      .catch(() => {
        if (!cancelled) setDataAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRule?.id, selectedRule?.segment, selectedRule?.underlying, selectedRule?.underlying_type, selectedRule?.interval]);

  function refreshCandleCacheStatus() {
    if (!selectedRule || selectedRule.underlying_type !== "symbol") {
      setCandleCacheStatus(null);
      return;
    }
    fetchCandleCacheStatus(selectedRule.segment, selectedRule.underlying, selectedRule.interval, backtestFrom, backtestTo)
      .then(setCandleCacheStatus)
      .catch(() => setCandleCacheStatus(null));
  }

  useEffect(() => {
    refreshCandleCacheStatus();
  }, [selectedRule?.id, selectedRule?.segment, selectedRule?.underlying, selectedRule?.underlying_type, selectedRule?.interval, backtestFrom, backtestTo]);

  async function handleResetCandleCache() {
    if (!selectedRule || selectedRule.underlying_type !== "symbol") return;
    setResettingCandleCache(true);
    try {
      await clearCandleCache(selectedRule.segment, selectedRule.underlying, selectedRule.interval, backtestFrom, backtestTo);
      refreshCandleCacheStatus();
    } catch {
      // keep whatever status was last known rather than blocking on a reset failure
    } finally {
      setResettingCandleCache(false);
    }
  }

  function refreshSavedBacktests(ruleId: string) {
    listSavedBacktests(ruleId)
      .then(setSavedBacktests)
      .catch(() => setSavedBacktests([])); // keep the panel empty rather than blocking the tab on a blip
  }

  useEffect(() => {
    if (!selected) {
      setSavedBacktests([]);
      return;
    }
    refreshSavedBacktests(selected);
  }, [selected]);

  async function handleSaveBacktest() {
    if (!selected || !backtestResult) return;
    setSavingBacktest(true);
    setSavedBacktestError(null);
    try {
      await createSavedBacktest(selected, {
        name: saveBacktestName,
        from_date: backtestFrom,
        to_date: backtestTo,
        request: backtestOverrides(),
        result: backtestResult,
      });
      setSaveBacktestName("");
      refreshSavedBacktests(selected);
    } catch (err) {
      setSavedBacktestError(err instanceof Error ? err.message : "Failed to save backtest");
    } finally {
      setSavingBacktest(false);
    }
  }

  // "Load" only prefills the form's criteria fields from a saved row's own
  // request - it deliberately does NOT restore backtestResult itself, so
  // the user re-runs it (fresh market data may have arrived since it was
  // saved) rather than silently looking at a stale result under an
  // now-edited form. That re-run is what "duplicate, change, save again"
  // actually means here - see SavedBacktestCreate's own comment.
  async function handleLoadSavedBacktest(id: string) {
    setLoadingSavedBacktestId(id);
    setSavedBacktestError(null);
    try {
      const saved = await getSavedBacktest(id);
      const req = saved.request;
      setBacktestFrom(saved.from_date);
      setBacktestTo(saved.to_date);
      setBacktestInstrumentType(req.instrument_type ?? "spot");
      setBacktestHorizon(req.horizon ?? "intraday");
      setBacktestOptionPositionStyle(req.option_position_style ?? "spread");
      setBacktestOptionStrikeMoneyness(req.option_strike_moneyness ?? "ATM");
      setBacktestSlMethod(req.stop_loss_method ?? "");
      setBacktestSlInterval(req.stop_loss_interval ?? "");
      setBacktestSlPercent(req.stop_loss_percent != null ? String(req.stop_loss_percent) : "");
      setBacktestSlIndicatorType(req.stop_loss_indicator_type ?? "ema");
      setBacktestSlIndicatorPeriod(req.stop_loss_indicator_params?.period != null ? String(req.stop_loss_indicator_params.period) : "");
      setBacktestSlIndicatorMultiplier(
        req.stop_loss_indicator_params?.multiplier != null ? String(req.stop_loss_indicator_params.multiplier) : "",
      );
      setBacktestTargetPercent(req.target_percent != null ? String(req.target_percent) : "");
      setBacktestTrailingEnabled(req.trailing_stop_enabled ?? false);
      setBacktestSlConfirmation(req.stop_loss_confirmation ?? "touch");
      setBacktestSquareOffTime(req.square_off_time ? req.square_off_time.slice(0, 5) : "");
      setBacktestEntryWindowStart(req.entry_window_start ? req.entry_window_start.slice(0, 5) : "");
      setBacktestEntryWindowEnd(req.entry_window_end ? req.entry_window_end.slice(0, 5) : "");
      setBacktestEntryWeekdays(req.entry_weekdays ?? []);
      setBacktestTimeBucketMinutes(req.time_bucket_minutes != null ? String(req.time_bucket_minutes) : "");
      setBacktestResult(null);
      setBacktestResultTab("trades");
      setBacktestError(null);
      setSaveBacktestName(`${saved.name} (copy)`);
    } catch (err) {
      setSavedBacktestError(err instanceof Error ? err.message : "Failed to load saved backtest");
    } finally {
      setLoadingSavedBacktestId(null);
    }
  }

  async function handleDeleteSavedBacktest(id: string) {
    if (!selected) return;
    try {
      await deleteSavedBacktest(id);
      refreshSavedBacktests(selected);
    } catch (err) {
      setSavedBacktestError(err instanceof Error ? err.message : "Failed to delete saved backtest");
    }
  }

  async function handleOpenGenerateStrategy(sb: SavedBacktestSummary) {
    setGenerateStrategyRowId(sb.id);
    setGenerateStrategyName(sb.name);
    setGenerateStrategyRequest(null);
    setGenerateStrategyError(null);
    setGenerateStrategySuccess(null);
    try {
      const detail = await getSavedBacktest(sb.id);
      setGenerateStrategyRequest(detail.request);
    } catch (err) {
      setGenerateStrategyError(err instanceof Error ? err.message : "Failed to load saved backtest");
    }
  }

  async function handleGenerateStrategy() {
    if (!selectedRule || !generateStrategyRequest || !generateStrategyName.trim()) return;
    setGeneratingStrategy(true);
    setGenerateStrategyError(null);
    try {
      const req = generateStrategyRequest;
      const activeWindows: ActiveWindow[] =
        req.entry_window_start && req.entry_window_end
          ? [{ start: req.entry_window_start, end: req.entry_window_end }]
          : [];
      const created = await createStrategy({
        name: generateStrategyName.trim(),
        source_type: "in_house",
        segment: selectedRule.segment,
        horizon: req.horizon ?? "intraday",
        instrument_type: req.instrument_type ?? "spot",
        rule_id: selectedRule.id,
        stop_loss_method: req.stop_loss_method,
        stop_loss_interval: req.stop_loss_interval,
        stop_loss_percent: req.stop_loss_percent,
        stop_loss_indicator_type: req.stop_loss_indicator_type,
        stop_loss_indicator_params: req.stop_loss_indicator_params,
        target_percent: req.target_percent,
        trailing_stop_enabled: req.trailing_stop_enabled,
        option_position_style: req.option_position_style,
        option_strike_moneyness: req.option_strike_moneyness,
        active_windows: activeWindows,
        active_weekdays: req.entry_weekdays ?? [],
      });
      setGenerateStrategySuccess(`Created strategy "${created.name}" - see the Strategies tab.`);
      setGenerateStrategyRowId(null);
      setGenerateStrategyRequest(null);
    } catch (err) {
      setGenerateStrategyError(err instanceof Error ? err.message : "Failed to create strategy");
    } finally {
      setGeneratingStrategy(false);
    }
  }

  // NSE/MCX only (max_days_per_request) - a hard Dhan-side rejection, not
  // just a heads-up, since get_candle_history doesn't chunk around it.
  const backtestRangeExceedsCap =
    dataAvailability?.max_days_per_request != null &&
    daysBetweenDates(backtestFrom, backtestTo) > dataAvailability.max_days_per_request;
  // CRYPTO only (earliest_available_date) - informational, not a hard
  // block: a too-wide range just returns less data than asked for (Delta
  // has no data before this point at all - unlike the old silent
  // per-request truncation, market-data now chunks around that, see
  // DELTA_MAX_CANDLES_PER_REQUEST).
  const backtestStartsBeforeEarliestData =
    !!dataAvailability?.earliest_available_date && backtestFrom < dataAvailability.earliest_available_date;
  // Both-or-neither - mirrors the backend's own validate_entry_window.
  const backtestEntryWindowIncomplete = !!backtestEntryWindowStart !== !!backtestEntryWindowEnd;
  // A performance advisory, not a real data-availability limit like
  // backtestRangeExceedsCap above (which reflects an actual provider-side
  // request cap) - finer intervals mean far more bars to fetch/simulate
  // for the same date range, so a 1min backtest gets slow far sooner than
  // a 60min one. Deliberately doesn't disable Run backtest (unlike
  // backtestRangeExceedsCap, which guards a request that would actually
  // fail) - just warns, since a slow-but-correct wide backtest is
  // sometimes exactly what's wanted.
  const backtestIntervalThresholdDays = selectedRule ? INTERVAL_MAX_BACKTEST_DAYS[selectedRule.interval] : undefined;
  const backtestRangeExceedsIntervalThreshold =
    backtestIntervalThresholdDays != null && daysBetweenDates(backtestFrom, backtestTo) > backtestIntervalThresholdDays;

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

  // Shared by both fresh-create and cancel-edit - returns the form to its
  // blank/default state.
  function resetForm() {
    setName("");
    setDescription("");
    setSegment("NSE");
    setUnderlying("");
    setUnderlyingType("symbol");
    setSelectedUniverse("");
    setInterval_("");
    setRuleType("crossover");
    setSelectedIndicatorId("");
    setHtfInterval("15min");
    setHtfBreakoutPeriod("20");
    setLtfInterval("3min");
    setLtfBreakoutPeriod("10");
    setEmaFilterEnabled(false);
    setEmaPeriod("20");
    setRangeBreakoutPeriod("5");
    setRegimeIndicatorIds([]);
  }

  // One shared panel for both create and edit (editingId null = create) -
  // builds the same payload shape either way and dispatches to POST or
  // PATCH. Editing no longer happens inline in the table.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    const payload = {
      name,
      description: description.trim() || undefined,
      segment,
      underlying: (underlyingType === "universe" ? selectedUniverse : underlying) || "",
      underlying_type: underlyingType,
      interval: isBreakout ? ltfInterval : (interval as Interval),
      rule_config: buildRuleConfig(),
      regime_indicator_ids: regimeIndicatorIds,
    };
    try {
      if (editingId) {
        const updated = await updateRule(editingId, payload);
        setRules((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setEditingId(null);
        setPanelOpen(false);
      } else {
        const created = await createRule(payload);
        setRules((prev) => [created, ...prev]);
      }
      resetForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : editingId ? "Failed to update rule" : "Failed to create rule");
    } finally {
      setSaving(false);
    }
  }

  // Opens the shared panel pre-filled with `r` - PATCHes on submit instead
  // of POSTing. Replaces the old inline-table-row editing UI entirely.
  function handleStartEdit(r: Rule) {
    setEditingId(r.id);
    setPanelOpen(true);
    setName(r.name);
    setDescription(r.description ?? "");
    setSegment(r.segment);
    setUnderlyingType(r.underlying_type);
    if (r.underlying_type === "universe") {
      setSelectedUniverse(r.underlying ?? "");
      setUnderlying("");
    } else {
      setUnderlying(r.underlying ?? "");
      setSelectedUniverse("");
    }
    setInterval_(r.interval ?? "");
    if (r.rule_config?.type === "breakout") {
      setRuleType("breakout");
      setHtfInterval(r.rule_config.htf_interval);
      setHtfBreakoutPeriod(String(r.rule_config.htf_breakout_period));
      setLtfInterval(r.rule_config.ltf_interval);
      setLtfBreakoutPeriod(String(r.rule_config.ltf_breakout_period));
      setEmaFilterEnabled(r.rule_config.ema_filter_enabled);
      setEmaPeriod(String(r.rule_config.ema_period));
    } else if (r.rule_config?.type === "range_breakout") {
      setRuleType("range_breakout");
      setRangeBreakoutPeriod(String(r.rule_config.breakout_period));
    } else {
      setRuleType("crossover");
      setSelectedIndicatorId(r.rule_config?.indicator_id ?? "");
    }
    setRegimeIndicatorIds(r.regime_indicator_ids);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setPanelOpen(false);
    resetForm();
  }

  async function handleDelete(r: Rule) {
    const confirmed = window.confirm(
      `Delete rule "${r.name}"? This fails if any strategy still references it - re-point or delete those first.`,
    );
    if (!confirmed) return;
    setActionError(null);
    try {
      await deleteRule(r.id);
      setRules((prev) => prev.filter((x) => x.id !== r.id));
      setSelected((prev) => (prev === r.id ? null : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete rule - it may still be referenced by a strategy");
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
        backtestSlMethod === "indicator"
          ? buildStopLossIndicatorParams(backtestSlIndicatorType, backtestSlIndicatorPeriod, backtestSlIndicatorMultiplier)
          : undefined,
      target_percent: backtestTargetPercent ? Number(backtestTargetPercent) : undefined,
      trailing_stop_enabled: backtestSlMethod ? backtestTrailingEnabled : undefined,
      stop_loss_confirmation: backtestSlMethod ? backtestSlConfirmation : undefined,
      square_off_time: backtestSquareOffTime ? `${backtestSquareOffTime}:00` : undefined,
      option_position_style: backtestInstrumentType === "option" ? backtestOptionPositionStyle : undefined,
      option_strike_moneyness: backtestInstrumentType === "option" ? backtestOptionStrikeMoneyness : undefined,
      time_bucket_minutes: backtestTimeBucketMinutes ? Number(backtestTimeBucketMinutes) : undefined,
      entry_window_start: backtestEntryWindowStart ? `${backtestEntryWindowStart}:00` : undefined,
      entry_window_end: backtestEntryWindowEnd ? `${backtestEntryWindowEnd}:00` : undefined,
      entry_weekdays: backtestEntryWeekdays.length > 0 ? backtestEntryWeekdays : undefined,
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
    setBacktestResultTab("trades");
    try {
      const result = await backtestRule(selected, backtestFrom, backtestTo, backtestOverrides());
      setBacktestResult(result);
      refreshCandleCacheStatus(); // the run above just populated (or reused) the cache - reflect that
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
    const slMultiplierValues = parseGridValues(gridSlIndicatorMultiplierValues);
    // Filling in SL indicator period values (and, for SuperTrend, multiplier
    // values too - expand_stop_loss_grid has no "current value" fallback,
    // both are required together) is what turns the sweep on for this grid
    // run, standalone from the Backtest tab's own Stop-loss dropdown -
    // forces stop_loss_method='indicator' regardless of what that's set to.
    const sweepingSl =
      backtestSlIndicatorType === "supertrend"
        ? slPeriodValues.length > 0 && slMultiplierValues.length > 0
        : slPeriodValues.length > 0;
    // Same idea, for stop_loss_method='percent' instead - filling in
    // candidate SL percent values turns THIS sweep on, mutually exclusive
    // with sweepingSl above (only one stop_loss_method applies per run).
    const slPercentValues = parseGridValues(gridSlPercentValues);
    const sweepingSlPercent = !sweepingSl && slPercentValues.length > 0;

    setGridSearching(true);
    setGridError(null);
    setGridResult(null);
    setApplyGridWinnerStatus(null);
    try {
      const result = await backtestRuleGrid(selected, backtestFrom, backtestTo, paramGrid, {
        stop_loss_method: sweepingSl ? "indicator" : sweepingSlPercent ? "percent" : backtestSlMethod || undefined,
        stop_loss_interval:
          sweepingSl || backtestSlMethod === "previous_candle" || backtestSlMethod === "indicator"
            ? backtestSlInterval || undefined
            : undefined,
        stop_loss_percent:
          !sweepingSl && !sweepingSlPercent && backtestSlMethod === "percent" && backtestSlPercent
            ? Number(backtestSlPercent)
            : undefined,
        stop_loss_indicator_type: sweepingSl || backtestSlMethod === "indicator" ? backtestSlIndicatorType : undefined,
        stop_loss_indicator_params:
          !sweepingSl && backtestSlMethod === "indicator"
            ? buildStopLossIndicatorParams(backtestSlIndicatorType, backtestSlIndicatorPeriod, backtestSlIndicatorMultiplier)
            : undefined,
        stop_loss_indicator_param_grid: sweepingSl
          ? backtestSlIndicatorType === "supertrend"
            ? { period: slPeriodValues, multiplier: slMultiplierValues }
            : { period: slPeriodValues }
          : undefined,
        stop_loss_percent_grid: sweepingSlPercent ? slPercentValues : undefined,
        target_percent: backtestTargetPercent ? Number(backtestTargetPercent) : undefined,
        trailing_stop_enabled:
          sweepingSl || sweepingSlPercent ? backtestTrailingEnabled : backtestSlMethod ? backtestTrailingEnabled : undefined,
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
      <details className="panel collapsible-panel" open={panelOpen} onToggle={(e) => setPanelOpen(e.currentTarget.open)}>
        <summary>
          <h2>{editingId ? "Edit rule" : "New rule"}</h2>
        </summary>
        <form className="strategy-form strategy-form-v2" onSubmit={handleSubmit}>
          <div className="form-main">
            <div className="form-row">
              <label>
                Segment
                <select value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
                  <option value="NSE">NSE</option>
                  <option value="MCX">MCX</option>
                  <option value="CRYPTO">Crypto</option>
                </select>
              </label>
              <label>
                Underlying Type
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
            </div>
            <div className="form-row">
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
                Rule Type
                <select
                  value={ruleType}
                  onChange={(e) => setRuleType(e.target.value as "crossover" | "breakout" | "range_breakout")}
                >
                  <option value="crossover">Crossover (indicator)</option>
                  <option value="breakout">Breakout (multi-timeframe)</option>
                  <option value="range_breakout">Range breakout (single timeframe)</option>
                </select>
              </label>
            </div>
            <div className="sl-fields-box">
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
                    {/* Crossover-eligible only - a regime type (SuperTrend, ADX, ...) is valid
                        as a Regime filter (below) but not here, same distinction the backend's
                        own _check_referenced_indicator_exists enforces; filtering it out here
                        avoids a 422 after the fact for a choice that could never succeed. */}
                    {indicators
                      .filter((ind) => !REGIME_INDICATOR_TYPES.includes(ind.type))
                      .map((ind) => (
                        <option key={ind.id} value={ind.id}>
                          {ind.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
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
          </div>

          <label className="title-field">
            Title
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. RSI 35-49 crossover" />
          </label>
          <label className="title-field">
            Description <span className="optional">(optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this rule looks for" />
          </label>

          <div className="form-actions">
            <button
              type="submit"
              disabled={
                saving ||
                !name.trim() ||
                (ruleType !== "breakout" && !interval) ||
                (underlyingType === "symbol" && !underlying.trim()) ||
                (underlyingType === "universe" && !selectedUniverse) ||
                (!isBreakout && !isRangeBreakout && !selectedIndicatorId)
              }
            >
              {saving ? "Saving..." : editingId ? "Save changes" : "Create rule"}
            </button>
            {editingId && (
              <button type="button" className="secondary" onClick={handleCancelEdit}>
                Cancel
              </button>
            )}
          </div>
        </form>
        <p className="hint">
          A Strategy picks one of these rules (by name) instead of configuring underlying/indicator/rule-type
          itself - see the Strategies tab.
        </p>
      </details>

      {error && <p className="error">{error}</p>}
      {actionError && <p className="error">{actionError}</p>}

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
          {selectedRule && selectedRule.underlying_type !== "symbol" && (
            <p className="hint">
              Data availability isn't shown for a {selectedRule.underlying_type === "universe" ? "universe" : "symbol list"} rule -
              it covers multiple symbols, not one to check.
            </p>
          )}
          {dataAvailability && (
            <p className={`hint ${backtestRangeExceedsCap ? "error" : ""}`}>
              {dataAvailability.note}
              {backtestRangeExceedsCap &&
                ` Your picked range is ${daysBetweenDates(backtestFrom, backtestTo)} days - narrow it to ${dataAvailability.max_days_per_request} or fewer, or the backtest will fail.`}
              {backtestStartsBeforeEarliestData &&
                ` Your "From" date is before that - the backtest will only really cover data from ~${dataAvailability.earliest_available_date} onward.`}
            </p>
          )}
          {backtestRangeExceedsIntervalThreshold && (
            <p className="hint">
              Your picked range is {daysBetweenDates(backtestFrom, backtestTo)} days at {selectedRule?.interval} - that's a lot of
              bars to fetch and simulate, so this backtest may take a while. Narrow the range for a faster result, or just wait it
              out.
            </p>
          )}
          {selectedRule && selectedRule.underlying_type === "symbol" && candleCacheStatus && (
            <p className="hint">
              {candleCacheStatus.cached
                ? `Data cached at ${new Date(candleCacheStatus.fetched_at!).toLocaleTimeString()} - a re-run with the same From/To reuses it instead of re-fetching.`
                : "Data not cached for this range yet - the next run fetches fresh from the provider."}{" "}
              <button type="button" onClick={handleResetCandleCache} disabled={resettingCandleCache || !candleCacheStatus.cached}>
                {resettingCandleCache ? "Resetting..." : "Reset cache"}
              </button>
            </p>
          )}
          {backtestSubTab === "backtest" && (
            <>
          <p className="hint">
            Simulates a paper trade per signal using this rule's own logic - a Rule alone carries no exit config or
            instrument_type (those are Strategy concerns), so supply them below; leaving stop-loss/target blank
            reproduces the simplest case (opposite-signal/end-of-data exits only). Still not a full sizing/account
            simulation against execution's real order logic.
          </p>
          {savedBacktestError && <p className="error">{savedBacktestError}</p>}
          {savedBacktests.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Saved backtest</th>
                    <th>Range</th>
                    <th>Trades</th>
                    <th>Hypothetical P&amp;L</th>
                    <th>Win %</th>
                    <th>Max drawdown</th>
                    <th>Saved</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {savedBacktests.map((sb) => (
                    <tr key={sb.id}>
                      <td>{sb.name}</td>
                      <td>
                        {sb.from_date} to {sb.to_date}
                      </td>
                      <td className="num">{sb.trade_count ?? "—"}</td>
                      <td className={`num ${(sb.hypothetical_pnl ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                        {sb.hypothetical_pnl != null ? `${sb.hypothetical_pnl >= 0 ? "+" : ""}${sb.hypothetical_pnl.toFixed(2)}` : "—"}
                      </td>
                      <td className="num">{sb.win_rate != null ? `${sb.win_rate.toFixed(1)}%` : "—"}</td>
                      <td className="num">{sb.max_drawdown != null ? sb.max_drawdown.toFixed(2) : "—"}</td>
                      <td className="muted">{new Date(sb.created_at).toLocaleString()}</td>
                      <td className="edit-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => handleLoadSavedBacktest(sb.id)}
                          disabled={loadingSavedBacktestId === sb.id}
                          title={`Load "${sb.name}" into the form`}
                          aria-label={`Load "${sb.name}" into the form`}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => handleOpenGenerateStrategy(sb)}
                          title={`Generate a strategy from "${sb.name}"`}
                          aria-label={`Generate a strategy from "${sb.name}"`}
                        >
                          <SendIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          onClick={() => handleDeleteSavedBacktest(sb.id)}
                          title={`Delete "${sb.name}"`}
                          aria-label={`Delete "${sb.name}"`}
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {generateStrategyRowId && (
            <div className="save-backtest-row">
              <input
                type="text"
                placeholder="New strategy name"
                value={generateStrategyName}
                onChange={(e) => setGenerateStrategyName(e.target.value)}
              />
              <button
                type="button"
                onClick={handleGenerateStrategy}
                disabled={generatingStrategy || !generateStrategyRequest || !generateStrategyName.trim()}
              >
                {generatingStrategy ? "Creating..." : !generateStrategyRequest ? "Loading..." : "Create strategy"}
              </button>
              <button type="button" onClick={() => setGenerateStrategyRowId(null)}>
                Cancel
              </button>
            </div>
          )}
          {generateStrategyError && <p className="error">{generateStrategyError}</p>}
          {generateStrategySuccess && <p className="hint">{generateStrategySuccess}</p>}
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
            {backtestSlMethod && (
              <label>
                SL confirmation
                <select
                  value={backtestSlConfirmation}
                  onChange={(e) => setBacktestSlConfirmation(e.target.value as StopLossConfirmation)}
                >
                  <option value="touch">Touch (matches live)</option>
                  <option value="close">Candle close</option>
                </select>
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
                    <option value="supertrend">SuperTrend</option>
                  </select>
                </label>
                <label>
                  {backtestSlIndicatorType === "supertrend" ? "ATR period" : "EMA period"}
                  <input
                    type="number"
                    min="2"
                    value={backtestSlIndicatorPeriod}
                    onChange={(e) => setBacktestSlIndicatorPeriod(e.target.value)}
                    placeholder="e.g. 20"
                  />
                </label>
                {backtestSlIndicatorType === "supertrend" && (
                  <label>
                    Multiplier
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={backtestSlIndicatorMultiplier}
                      onChange={(e) => setBacktestSlIndicatorMultiplier(e.target.value)}
                      placeholder="e.g. 3"
                    />
                  </label>
                )}
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
              Entry window start <span className="optional">(optional)</span>
              <input type="time" value={backtestEntryWindowStart} onChange={(e) => setBacktestEntryWindowStart(e.target.value)} />
            </label>
            <label>
              Entry window end <span className="optional">(optional)</span>
              <input type="time" value={backtestEntryWindowEnd} onChange={(e) => setBacktestEntryWindowEnd(e.target.value)} />
            </label>
            {backtestEntryWindowIncomplete && <p className="hint error">Set both entry window start and end, or clear both.</p>}
            <div className="active-windows-field">
              <span className="muted">Entry weekdays (optional)</span>
              <WeekdaysEditor selected={backtestEntryWeekdays} onChange={setBacktestEntryWeekdays} />
            </div>
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
            <button type="button" onClick={handleBacktest} disabled={backtesting || backtestRangeExceedsCap || backtestEntryWindowIncomplete}>
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
              <div className="save-backtest-row">
                <input
                  type="text"
                  placeholder="Name this backtest to save it"
                  value={saveBacktestName}
                  onChange={(e) => setSaveBacktestName(e.target.value)}
                />
                <button type="button" onClick={handleSaveBacktest} disabled={savingBacktest || !saveBacktestName.trim()}>
                  {savingBacktest ? "Saving..." : "Save"}
                </button>
              </div>
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
                <>
                  <nav className="tabs">
                    <button
                      type="button"
                      className={backtestResultTab === "trades" ? "active" : ""}
                      onClick={() => setBacktestResultTab("trades")}
                    >
                      Trades
                    </button>
                    <button
                      type="button"
                      className={backtestResultTab === "interval" ? "active" : ""}
                      onClick={() => setBacktestResultTab("interval")}
                    >
                      Interval breakdown
                    </button>
                  </nav>
                  {backtestResultTab === "trades" &&
                    (backtestResult.trades.length > 0 && (
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
                    ))}
                  {backtestResultTab === "interval" && (
                    <>
                      {backtestResult.time_of_day_breakdown && backtestResult.time_of_day_breakdown.length > 0 ? (
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
                      ) : (
                        <p className="hint">
                          Set a time-of-day bucket (min) above and re-run the backtest to see interval/weekday breakdowns.
                        </p>
                      )}
                      {backtestResult.weekday_breakdown && backtestResult.weekday_breakdown.length > 0 && (
                        <>
                          <h3>P&amp;L by weekday</h3>
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>Weekday</th>
                                  <th>Trades</th>
                                  <th>Win %</th>
                                  <th>Hypothetical P&amp;L</th>
                                </tr>
                              </thead>
                              <tbody>
                                {backtestResult.weekday_breakdown.map((row) => (
                                  <tr key={row.weekday}>
                                    <td>{row.weekday}</td>
                                    <td className="num">{row.trade_count}</td>
                                    <td className="num">{row.win_rate.toFixed(1)}%</td>
                                    <td className={`num ${row.hypothetical_pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                                      {row.hypothetical_pnl >= 0 ? "+" : ""}
                                      {row.hypothetical_pnl.toFixed(2)}
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
                . Doesn't change the indicator itself until you hit Apply on a result row below. SL indicator
                period values (and, for SuperTrend, multiplier values too - both required together) adds a
                second sweep dimension, independent of the Backtest tab's own Stop-loss dropdown - every
                (indicator params, SL params) pair gets its own run.
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
                  SL candle interval <span className="optional">(optional, indicator sweep only)</span>
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
                  SL indicator type <span className="optional">(optional, indicator sweep only)</span>
                  <select
                    value={backtestSlIndicatorType}
                    onChange={(e) => setBacktestSlIndicatorType(e.target.value as StopLossIndicatorType)}
                  >
                    <option value="ema">EMA</option>
                    <option value="supertrend">SuperTrend</option>
                  </select>
                </label>
                <label>
                  SL indicator period values <span className="optional">(optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. 10,15,20 - sweeps the SL indicator independently of the Backtest tab"
                    value={gridSlIndicatorPeriodValues}
                    onChange={(e) => setGridSlIndicatorPeriodValues(e.target.value)}
                  />
                </label>
                {backtestSlIndicatorType === "supertrend" && (
                  <label>
                    SL multiplier values <span className="optional">(required together with period values above)</span>
                    <input
                      type="text"
                      placeholder="e.g. 2,3,4"
                      value={gridSlIndicatorMultiplierValues}
                      onChange={(e) => setGridSlIndicatorMultiplierValues(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  SL percent values <span className="optional">(optional - alternative to the indicator sweep above)</span>
                  <input
                    type="text"
                    placeholder="e.g. 1,1.5,2,2.5 - sweeps stop_loss_method='percent' independently of the Backtest tab"
                    value={gridSlPercentValues}
                    onChange={(e) => setGridSlPercentValues(e.target.value)}
                  />
                </label>
                <button type="button" onClick={handleGridSearch} disabled={gridSearching || backtestRangeExceedsCap}>
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
                        {gridResult.results.some((row) => row.stop_loss_indicator_params) && <th>SL period</th>}
                        {gridResult.results.some((row) => row.stop_loss_indicator_params?.multiplier != null) && <th>SL multiplier</th>}
                        {gridResult.results.some((row) => row.stop_loss_percent != null) && <th>SL %</th>}
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
                          {gridResult.results.some((r) => r.stop_loss_indicator_params?.multiplier != null) && (
                            <td className="num">{row.stop_loss_indicator_params?.multiplier ?? "-"}</td>
                          )}
                          {gridResult.results.some((r) => r.stop_loss_percent != null) && (
                            <td className="num">{row.stop_loss_percent ?? "-"}</td>
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
  // The grid's primary split - a strategy is either intraday or
  // positional (Horizon's only two values now, "swing" merged away
  // 2026-08-17 since it never had distinct behavior anywhere - see
  // docs/architecture.md). Segment/instrument are secondary filters
  // layered on top, not further tabs - both dimensions have more than
  // two values (3 segments, 3 instrument types), which reads better as
  // dropdowns than a wall of tabs.
  const [horizonTab, setHorizonTab] = useState<"intraday" | "positional">("intraday");
  const [segmentFilter, setSegmentFilter] = useState<"all" | Segment>("all");
  const [instrumentFilter, setInstrumentFilter] = useState<"all" | InstrumentType>("all");

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
  // stop_loss_method='indicator' only - see StopLossIndicatorType in api.ts.
  const [slIndicatorType, setSlIndicatorType] = useState<StopLossIndicatorType>("ema");
  const [slIndicatorPeriod, setSlIndicatorPeriod] = useState("");
  const [slIndicatorMultiplier, setSlIndicatorMultiplier] = useState("");
  const [targetPercent, setTargetPercent] = useState("");
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  // instrument_type='option' only - see OptionPositionStyle in api.ts.
  const [optionPositionStyle, setOptionPositionStyle] = useState<OptionPositionStyle>("spread");
  const [optionStrikeMoneyness, setOptionStrikeMoneyness] = useState<OptionStrikeMoneyness>("ATM");
  const [optionSlScope, setOptionSlScope] = useState<OptionSlScope>("combined");
  // Every instrument_type, optional (renamed from option_fixed_lots,
  // which used to be options-only) - see fixed_lots in api.ts. Labeled
  // "Qty" for spot, "Lots" for future/option (see fixedLotsLabel below).
  const [fixedLots, setFixedLots] = useState("");
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
  // Optional day-of-week filter, independent of activeWindows above -
  // Mon-Fri checked by default (most strategies target NSE/MCX, which
  // don't trade weekends) - a real restriction, not a stand-in for
  // "unrestricted" the way all 7 checked would be. A CRYPTO strategy
  // meant to trade every day needs Sat/Sun checked explicitly.
  const [activeWeekdays, setActiveWeekdays] = useState<Weekday[]>(DEFAULT_ACTIVE_WEEKDAYS);
  const [dupPolicy, setDupPolicy] = useState<DuplicateSignalPolicy>("skip");
  const [counterPolicy, setCounterPolicy] = useState<CounterSignalPolicy>("close_and_flip");
  const [saving, setSaving] = useState(false);

  // null = the panel is in "create" mode; a strategy id = it's editing
  // that strategy (pre-filled from it, PATCH instead of POST on submit) -
  // one shared form/panel for both, no separate inline-table-row editing
  // UI anymore. panelOpen is the <details> element's own open state,
  // lifted up so handleStartEdit can force it open (a plain `open`
  // attribute only sets the INITIAL state, not later opens).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

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
    if (s.horizon !== horizonTab) return false;
    if (segmentFilter !== "all" && s.segment !== segmentFilter) return false;
    if (instrumentFilter !== "all" && s.instrument_type !== instrumentFilter) return false;
    return true;
  });
  // Rule is in-house only now - every rule in the list qualifies, sorted
  // alphabetically by name.
  const createIsInHouse = sourceKind === "in_house";
  const createRuleOptions = [...rules].sort((a, b) => a.name.localeCompare(b.name));

  // Shared by both fresh-create and cancel-edit - returns the form to its
  // blank/default state.
  function resetForm() {
    setName("");
    setSourceKind("in_house");
    setExternalSourceName("");
    setRuleId("");
    setSlMethod("");
    setSlInterval("");
    setSlPercent("");
    setSlIndicatorPeriod("");
    setSlIndicatorMultiplier("");
    setTargetPercent("");
    setTrailingEnabled(false);
    setOptionPositionStyle("spread");
    setOptionStrikeMoneyness("ATM");
    setOptionSlScope("combined");
    setFixedLots("");
    setContractDayFilter("any");
    setSegment("NSE");
    setActiveWindows([]);
    setActiveWeekdays(DEFAULT_ACTIVE_WEEKDAYS);
    setDupPolicy("skip");
    setCounterPolicy("close_and_flip");
  }

  // One shared panel for both create and edit (editingId null = create) -
  // builds the same payload shape either way and dispatches to POST or
  // PATCH. Editing no longer happens inline in the table.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (createIsInHouse && !ruleId) return; // submit is disabled without a picked rule - defensive guard
    if (!createIsInHouse && !externalSourceName.trim()) return; // submit is disabled without a source name - defensive guard
    setSaving(true);
    const payload = {
      name,
      horizon,
      instrument_type: instrumentType,
      rule_id: createIsInHouse ? ruleId : undefined,
      stop_loss_method: slMethod || undefined,
      stop_loss_interval:
        slMethod === "previous_candle" || slMethod === "indicator" ? slInterval || undefined : undefined,
      stop_loss_percent: slMethod === "percent" && slPercent ? Number(slPercent) : undefined,
      stop_loss_indicator_type: slMethod === "indicator" ? slIndicatorType : undefined,
      stop_loss_indicator_params:
        slMethod === "indicator" ? buildStopLossIndicatorParams(slIndicatorType, slIndicatorPeriod, slIndicatorMultiplier) : undefined,
      target_percent: targetPercent ? Number(targetPercent) : undefined,
      trailing_stop_enabled: slMethod ? trailingEnabled : undefined,
      option_position_style: instrumentType === "option" ? optionPositionStyle : undefined,
      option_strike_moneyness: instrumentType === "option" ? optionStrikeMoneyness : undefined,
      option_sl_scope: instrumentType === "option" ? optionSlScope : undefined,
      fixed_lots: fixedLots ? Number(fixedLots) : undefined,
      contract_day_filter:
        instrumentType === "future" || instrumentType === "option" ? contractDayFilter : undefined,
      segment,
      duplicate_signal_policy: dupPolicy,
      counter_signal_policy: counterPolicy,
      active_windows: activeWindows
        .filter((w) => w.start && w.end)
        .map((w) => ({ start: `${w.start}:00`, end: `${w.end}:00` })),
      active_weekdays: activeWeekdays,
    };
    try {
      if (editingId) {
        const updated = await updateStrategy(editingId, payload);
        setStrategies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setEditingId(null);
        setPanelOpen(false);
      } else {
        const created = await createStrategy({ ...payload, source_type: createIsInHouse ? "in_house" : externalSourceName.trim() });
        setStrategies((prev) => [created, ...prev]);
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : editingId ? "Failed to update strategy" : "Failed to create strategy");
    } finally {
      setSaving(false);
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

  // Opens the shared panel pre-filled with `s` - PATCHes on submit instead
  // of POSTing. Replaces the old inline-table-row editing UI entirely.
  function handleStartEdit(s: Strategy) {
    setEditingId(s.id);
    setPanelOpen(true);
    setName(s.name);
    setSourceKind(s.source_type === "in_house" ? "in_house" : "external");
    setExternalSourceName(s.source_type === "in_house" ? "" : s.source_type);
    setHorizon(s.horizon);
    setInstrumentType(s.instrument_type);
    setRuleId(s.rule_id ?? "");
    setSlMethod(s.stop_loss_method ?? "");
    setSlInterval(s.stop_loss_interval ?? "");
    setSlPercent(s.stop_loss_percent != null ? String(s.stop_loss_percent) : "");
    setSlIndicatorType(s.stop_loss_indicator_type ?? "ema");
    setSlIndicatorPeriod(s.stop_loss_indicator_params?.period != null ? String(s.stop_loss_indicator_params.period) : "");
    setSlIndicatorMultiplier(
      s.stop_loss_indicator_params?.multiplier != null ? String(s.stop_loss_indicator_params.multiplier) : "",
    );
    setTargetPercent(s.target_percent != null ? String(s.target_percent) : "");
    setTrailingEnabled(s.trailing_stop_enabled);
    setOptionPositionStyle(s.option_position_style);
    setOptionStrikeMoneyness(s.option_strike_moneyness);
    setOptionSlScope(s.option_sl_scope);
    setFixedLots(s.fixed_lots != null ? String(s.fixed_lots) : "");
    setContractDayFilter(s.contract_day_filter);
    setSegment(s.segment);
    setActiveWindows(s.active_windows.map((w) => ({ start: w.start.slice(0, 5), end: w.end.slice(0, 5) })));
    // Empty (unrestricted) must display as all 7 checked here, NOT the
    // create form's own Mon-Fri default (DEFAULT_ACTIVE_WEEKDAYS) - this is
    // an EXISTING strategy's real saved state, and showing anything less
    // than all 7 would misrepresent it as already weekday-restricted, and
    // silently narrow it to that if saved back without the user ever
    // touching this field.
    setActiveWeekdays(s.active_weekdays.length === 0 ? ALL_WEEKDAYS : s.active_weekdays);
    setDupPolicy(s.duplicate_signal_policy);
    setCounterPolicy(s.counter_signal_policy);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setPanelOpen(false);
    resetForm();
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
  // Name, Status, Source, Horizon, Instrument, Segment, Rule, Info, actions
  // - matches the <thead> below exactly. Stop-loss/Target/Active window/
  // Active weekdays/Webhooks moved into the single Info column's hover
  // tooltip (StrategyInfoCell) rather than each getting their own column.
  const colCount = 9;

  return (
    <>
      <details className="panel collapsible-panel" open={panelOpen} onToggle={(e) => setPanelOpen(e.currentTarget.open)}>
        <summary>
          <h2>{editingId ? "Edit strategy" : "New strategy"}</h2>
        </summary>
        <form className="strategy-form strategy-form-v2" onSubmit={handleSubmit}>
          <div className="form-main">
              <section className="form-section">
                <h3 className="section-heading">Signal</h3>
                <div className="form-row">
                  <div className="radio-field">
                    <span className="field-label">Source</span>
                    <div className="radio-row">
                      <label className="radio-label">
                        <input
                          type="radio"
                          name="sourceKind"
                          checked={sourceKind === "in_house"}
                          onChange={() => setSourceKind("in_house")}
                        />
                        Platform
                      </label>
                      <label className="radio-label">
                        <input
                          type="radio"
                          name="sourceKind"
                          checked={sourceKind === "external"}
                          onChange={() => setSourceKind("external")}
                        />
                        External
                      </label>
                    </div>
                  </div>
                  {!createIsInHouse && (
                    <>
                      <label>
                        External Provider
                        <select
                          value={externalSourceName.toLowerCase() === "chartink" ? "chartink" : "other"}
                          onChange={(e) => setExternalSourceName(e.target.value === "chartink" ? "chartink" : "")}
                        >
                          <option value="chartink">Chartink</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                      <label>
                        Rule (Provider&apos;s)
                        <input
                          value={externalSourceName}
                          onChange={(e) => setExternalSourceName(e.target.value)}
                          required
                          placeholder="e.g. chartink, tradingview"
                        />
                      </label>
                    </>
                  )}
                  {createIsInHouse && (
                    <label>
                      Rule (Platform&apos;s)
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
                </div>
                {createIsInHouse && createRuleOptions.length === 0 && (
                  <p className="hint">No rules yet - create one on the Rules tab first.</p>
                )}
                {createIsInHouse && (
                  <p className="hint">Regime filters (optional) are configured on the Rule itself - see the Rules tab.</p>
                )}
                <div className="form-row">
                  <label>
                    Segment
                    <select value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
                      <option value="NSE">NSE</option>
                      <option value="MCX">MCX</option>
                      <option value="CRYPTO">Crypto</option>
                    </select>
                  </label>
                  <label>
                    Horizon
                    <select value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
                      <option value="intraday">Intraday</option>
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
                </div>
                {instrumentType === "option" && (
                  <div className="form-row">
                    <label>
                      Option style
                      <select value={optionPositionStyle} onChange={(e) => setOptionPositionStyle(e.target.value as OptionPositionStyle)}>
                        <option value="spread">Spread (bull call / bear put)</option>
                        <option value="naked">Naked (single long call/put)</option>
                      </select>
                    </label>
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
                    <label>
                      SL/target scope
                      <select value={optionSlScope} onChange={(e) => setOptionSlScope(e.target.value as OptionSlScope)}>
                        <option value="combined">Combined (net debit)</option>
                        <option value="individual">Individual (per leg)</option>
                      </select>
                    </label>
                  </div>
                )}
                {(instrumentType === "future" || instrumentType === "option") && (
                  <div className="form-row">
                    <label>
                      Contract day
                      <select value={contractDayFilter} onChange={(e) => setContractDayFilter(e.target.value as ContractDayFilter)}>
                        <option value="any">Any day</option>
                        {instrumentType === "option" && <option value="start">Contract start day</option>}
                        <option value="expiry">Expiry day</option>
                      </select>
                    </label>
                  </div>
                )}
              </section>

              <section className="form-section">
                <h3 className="section-heading">Entry</h3>
                <div className="form-row">
                  <label>
                    Same Direction Signal
                    <select value={dupPolicy} onChange={(e) => setDupPolicy(e.target.value as DuplicateSignalPolicy)}>
                      <option value="add_position">Add position (pyramid)</option>
                      <option value="skip">Skip</option>
                    </select>
                  </label>
                  <label>
                    Counter Signal
                    <select value={counterPolicy} onChange={(e) => setCounterPolicy(e.target.value as CounterSignalPolicy)}>
                      <option value="skip">Skip (leave existing position open)</option>
                      <option value="close_and_flip">Close and flip</option>
                    </select>
                  </label>
                  <label>
                    {instrumentType === "spot" ? "Qty" : "Lots"} <span className="optional">(optional)</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="Auto (capital/risk-based)"
                      value={fixedLots}
                      onChange={(e) => setFixedLots(e.target.value)}
                    />
                  </label>
                </div>
              </section>

              <section className="form-section">
                <h3 className="section-heading">Exit</h3>
                <div className="form-row">
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
                  <label>
                    SL Type <span className="optional">(optional)</span>
                    <select
                      value={slMethod}
                      onChange={(e) => {
                        const next = e.target.value as StopLossMethod | "";
                        setSlMethod(next);
                        // Trailing only applies to a %-from-entry stop (see
                        // the checkbox's own conditional render below) -
                        // clear a stale checked value from before switching
                        // away, so it can't silently submit for a method
                        // whose UI no longer shows the checkbox at all.
                        if (next !== "percent") setTrailingEnabled(false);
                      }}
                    >
                      <option value="">&mdash;</option>
                      <option value="previous_candle">Previous candle low/high</option>
                      <option value="percent">% from entry</option>
                      <option value="indicator">Indicator</option>
                    </select>
                  </label>
                </div>
                {slMethod && (
                  <div className="sl-fields-box">
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
                            <option value="supertrend">SuperTrend</option>
                          </select>
                        </label>
                        <label>
                          {slIndicatorType === "supertrend" ? "ATR period" : "EMA period"}
                          <input
                            type="number"
                            min="2"
                            value={slIndicatorPeriod}
                            onChange={(e) => setSlIndicatorPeriod(e.target.value)}
                            placeholder="e.g. 20"
                          />
                        </label>
                        {slIndicatorType === "supertrend" && (
                          <label>
                            Multiplier
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={slIndicatorMultiplier}
                              onChange={(e) => setSlIndicatorMultiplier(e.target.value)}
                              placeholder="e.g. 3"
                            />
                          </label>
                        )}
                      </>
                    )}
                    {slMethod === "percent" && (
                      <label className="checkbox-label">
                        <input type="checkbox" checked={trailingEnabled} onChange={(e) => setTrailingEnabled(e.target.checked)} />
                        Trailing stop-loss
                      </label>
                    )}
                  </div>
                )}
              </section>

              <section className="form-section">
                <h3 className="section-heading">Schedule</h3>
                <div className="active-windows-field">
                  <span className="muted">Weekdays</span>
                  <WeekdaysEditor selected={activeWeekdays} onChange={setActiveWeekdays} />
                </div>
                <div className="active-windows-field">
                  <span className="muted">Time Window (optional)</span>
                  <ActiveWindowsEditor windows={activeWindows} onChange={setActiveWindows} />
                </div>
              </section>
          </div>

          <label className="title-field">
            Title
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Bullish Breakout v1" />
          </label>

          <div className="form-actions">
            <button
              type="submit"
              disabled={saving || !name.trim() || (createIsInHouse && !ruleId) || (!createIsInHouse && !externalSourceName.trim())}
            >
              {saving ? "Saving..." : editingId ? "Save changes" : "Create strategy"}
            </button>
            {editingId && (
              <button type="button" className="secondary" onClick={handleCancelEdit}>
                Cancel
              </button>
            )}
          </div>
        </form>
        {nonDefaultConfig && (
          <p className="hint">
            Only intraday + spot/future is handled end-to-end by execution today - this will still resolve and
            publish, but execution will reject anything else with "unsupported horizon/instrument_type".
          </p>
        )}
        <InfoDisclosure summary="More info">
          <p>
            New strategies start as <strong>draft</strong> - webhook URLs work immediately, but signal-processing
            rejects signals from a non-live strategy. Activate it once you've verified the URL is wired up
            correctly.
          </p>
          <p>
            No capital/quantity setting here - execution still sizes every position from its own capital_per_trade
            and risk_per_trade_pct settings. Stop-loss/target here just supply the stop distance; configure the
            capital and risk % in execution's frontend, not here.
          </p>
          <p>
            Once a stop-loss method is set it can be switched (e.g. previous-candle to %) but not cleared back to
            &mdash; same limitation as Rule. Delete and recreate the strategy if you need to remove it entirely.
          </p>
          <p>
            Square-off is configured per-segment now, not per-strategy - see execution's Accounts/Settings page.
            Any intraday position still open past that segment's square-off time gets forcefully closed there.
          </p>
        </InfoDisclosure>
      </details>

      {error && <p className="error">{error}</p>}

      <nav className="tabs">
        <button type="button" className={horizonTab === "intraday" ? "active" : ""} onClick={() => setHorizonTab("intraday")}>
          Intraday
        </button>
        <button type="button" className={horizonTab === "positional" ? "active" : ""} onClick={() => setHorizonTab("positional")}>
          Positional
        </button>
      </nav>

      <div className="filter-row">
        <label className="inline-filter">
          Segment
          <select value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value as "all" | Segment)}>
            <option value="all">All</option>
            <option value="NSE">NSE</option>
            <option value="MCX">MCX</option>
            <option value="CRYPTO">CRYPTO</option>
          </select>
        </label>
        <label className="inline-filter">
          Instrument
          <select value={instrumentFilter} onChange={(e) => setInstrumentFilter(e.target.value as "all" | InstrumentType)}>
            <option value="all">All</option>
            <option value="spot">Spot</option>
            <option value="future">Future</option>
            <option value="option">Option</option>
          </select>
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Instrument</th>
            <th>Segment</th>
            <th>Rule</th>
            <th>Created</th>
            <th>Last scan</th>
            <th>Info</th>
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
                <td>
                  {s.instrument_type}
                  {s.instrument_type === "option" && (
                    <span className="muted">
                      {" "}
                      ({s.option_position_style}
                      {s.option_strike_moneyness !== "ATM" ? `, ${s.option_strike_moneyness}` : ""}
                      {s.option_sl_scope !== "combined" ? `, ${s.option_sl_scope} SL` : ""}
                      {s.fixed_lots != null ? `, ${s.fixed_lots} lots fixed` : ""}
                      {s.contract_day_filter !== "any" ? `, ${s.contract_day_filter} day` : ""})
                    </span>
                  )}
                  {s.instrument_type === "future" && (s.contract_day_filter !== "any" || s.fixed_lots != null) && (
                    <span className="muted">
                      {" "}
                      ({[
                        s.contract_day_filter !== "any" ? `${s.contract_day_filter} day` : null,
                        s.fixed_lots != null ? `${s.fixed_lots} lots fixed` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      )
                    </span>
                  )}
                  {s.instrument_type === "spot" && s.fixed_lots != null && (
                    <span className="muted"> ({s.fixed_lots} qty fixed)</span>
                  )}
                </td>
                <td>{s.segment}</td>
                <td className="muted">{s.rule?.name ?? "-"}</td>
                <td className="muted">{formatDateTimeNoSeconds(s.created_at)}</td>
                <td className="muted">{s.last_scan_at ? formatDateTimeNoSeconds(s.last_scan_at) : "never"}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <StrategyInfoCell s={s} />
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

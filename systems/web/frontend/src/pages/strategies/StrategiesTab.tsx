import { useState } from "react";
import { ApiError } from "../../api/http";
import {
  createStrategy, deleteStrategy, updateStrategy, type ActiveWindow, type ContractDayFilter, type CounterSignalPolicy, type DuplicateSignalPolicy,
  type Horizon, type InstrumentType, type OptionPositionStyle, type OptionSlScope, type OptionStrikeMoneyness, type Rule, type Strategy,
  type StrategyFields, type StrategyStatus, type Weekday,
} from "../../api/strategies";
import type { Segment } from "../../api/types";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { TextField } from "../../components/Field";
import { SEGMENTS } from "../../config";
import { formatDay, formatTime } from "../../format";
import type { Resource } from "../../hooks/useResource";
import { STOP_LOSS_METHOD_LABEL, WEEKDAYS, isInHouse, strategySummary, validateStopLoss, validateStrategyCore, validateWindows } from "../../strategies/model";

const STOP_LOSS_METHODS: NonNullable<Strategy["stop_loss_method"]>[] = ["previous_candle", "percent", "indicator", "breakeven"];
const STOP_LOSS_INTERVALS = ["1min", "3min", "5min", "15min", "25min", "30min", "60min"] as const;
type Draft = {
  name: string; sourceType: string; inHouse: boolean; sourceRuleName: string; horizon: Horizon; instrumentType: InstrumentType; segment: Segment;
  ruleId: string; stopMethod: Strategy["stop_loss_method"]; stopInterval: string; stopPercent: string; stopIndicatorType: string; stopPeriod: string;
  stopMultiplier: string; trailing: boolean; targetPercent: string; optionStyle: OptionPositionStyle; optionMoneyness: OptionStrikeMoneyness;
  optionSlScope: OptionSlScope; fixedLots: string; useMargin: boolean; contractDayFilter: ContractDayFilter; duplicatePolicy: DuplicateSignalPolicy;
  counterPolicy: CounterSignalPolicy; windows: ActiveWindow[]; weekdays: Weekday[]; seedOnActivation: boolean;
};

function blankDraft(): Draft {
  return {
    name: "", sourceType: "", inHouse: true, sourceRuleName: "", horizon: "intraday", instrumentType: "future", segment: "NSE", ruleId: "",
    stopMethod: null, stopInterval: "5min", stopPercent: "1", stopIndicatorType: "supertrend", stopPeriod: "10", stopMultiplier: "3", trailing: false,
    targetPercent: "", optionStyle: "spread", optionMoneyness: "ATM", optionSlScope: "combined", fixedLots: "", useMargin: false, contractDayFilter: "any",
    duplicatePolicy: "skip", counterPolicy: "close_and_flip", windows: [], weekdays: [], seedOnActivation: false,
  };
}

function draftFromStrategy(s: Strategy): Draft {
  return {
    name: s.name, sourceType: s.source_type, inHouse: isInHouse(s), sourceRuleName: s.source_rule_name ?? "", horizon: s.horizon, instrumentType: s.instrument_type,
    segment: s.segment, ruleId: s.rule_id ?? "", stopMethod: s.stop_loss_method, stopInterval: s.stop_loss_interval ?? "5min", stopPercent: s.stop_loss_percent != null ? String(s.stop_loss_percent) : "1",
    stopIndicatorType: s.stop_loss_indicator_type ?? "supertrend", stopPeriod: String(s.stop_loss_indicator_params?.period ?? 10), stopMultiplier: String(s.stop_loss_indicator_params?.multiplier ?? 3),
    trailing: s.trailing_stop_enabled, targetPercent: s.target_percent != null ? String(s.target_percent) : "", optionStyle: s.option_position_style, optionMoneyness: s.option_strike_moneyness,
    optionSlScope: s.option_sl_scope, fixedLots: s.fixed_lots != null ? String(s.fixed_lots) : "", useMargin: s.use_margin, contractDayFilter: s.contract_day_filter,
    duplicatePolicy: s.duplicate_signal_policy, counterPolicy: s.counter_signal_policy, windows: s.active_windows, weekdays: s.active_weekdays, seedOnActivation: s.seed_on_activation,
  };
}

function toFields(d: Draft): StrategyFields {
  const method = d.stopMethod;
  return {
    name: d.name.trim(), source_type: d.inHouse ? "in_house" : d.sourceType.trim(), source_rule_name: d.inHouse ? null : d.sourceRuleName.trim() || null,
    horizon: d.horizon, instrument_type: d.instrumentType, rule_id: d.inHouse ? d.ruleId || null : null, segment: d.segment,
    stop_loss_method: method,
    stop_loss_interval: method === "previous_candle" || method === "indicator" ? (d.stopInterval as Strategy["stop_loss_interval"]) : null,
    stop_loss_percent: method === "percent" || method === "breakeven" ? Number(d.stopPercent) : null,
    stop_loss_indicator_type: method === "indicator" ? d.stopIndicatorType : null,
    stop_loss_indicator_params: method === "indicator" ? (d.stopIndicatorType === "supertrend" ? { period: Number(d.stopPeriod), multiplier: Number(d.stopMultiplier) } : { period: Number(d.stopPeriod) }) : null,
    target_percent: d.targetPercent.trim() ? Number(d.targetPercent) : null,
    trailing_stop_enabled: method != null && d.trailing,
    option_position_style: d.optionStyle, option_strike_moneyness: d.optionMoneyness, option_sl_scope: d.optionSlScope,
    fixed_lots: d.fixedLots.trim() ? Number(d.fixedLots) : null, use_margin: d.useMargin, contract_day_filter: d.contractDayFilter,
    duplicate_signal_policy: d.duplicatePolicy, counter_signal_policy: d.counterPolicy, active_windows: d.windows, active_weekdays: d.weekdays,
    seed_on_activation: d.seedOnActivation,
  };
}

function validateDraft(d: Draft): string[] {
  const errors = [...validateStrategyCore({ name: d.name, source_type: d.inHouse ? "in_house" : d.sourceType, instrument_type: d.instrumentType, segment: d.segment })];
  if (d.inHouse && !d.ruleId) errors.push("Pick which rule decides when it fires.");
  errors.push(
    ...validateStopLoss({
      method: d.stopMethod, interval: d.stopMethod === "previous_candle" || d.stopMethod === "indicator" ? d.stopInterval : null,
      percent: d.stopMethod === "percent" || d.stopMethod === "breakeven" ? Number(d.stopPercent) : null, trailing: d.trailing,
      indicatorType: d.stopMethod === "indicator" ? d.stopIndicatorType : null,
    }),
  );
  errors.push(...validateWindows(d.windows));
  if (d.contractDayFilter === "start" && d.instrumentType !== "option") errors.push('"Only the first day of a new contract" needs an option strategy.');
  return errors;
}

function DraftForm({ draft, onChange, rules, prefix }: { draft: Draft; onChange: (patch: Partial<Draft>) => void; rules: Rule[]; prefix: string }) {
  const d = draft;
  return (
    <>
      <TextField id={`${prefix}-name`} label="Name" value={d.name} onChange={(v) => onChange({ name: v })} inputMode="text" />
      <label className="check">
        <input type="checkbox" checked={d.inHouse} onChange={(e) => onChange({ inHouse: e.target.checked })} />
        <span>In-house (watched by this engine, against a saved rule)</span>
      </label>
      {d.inHouse ? (
        <div className="field">
          <label htmlFor={`${prefix}-rule`}>Rule</label>
          <select id={`${prefix}-rule`} value={d.ruleId} onChange={(e) => onChange({ ruleId: e.target.value })}>
            <option value="">Choose one…</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {rules.length === 0 && <p className="faint" style={{ fontSize: 12, margin: "4px 0 0" }}>No rule yet — make one on the Rules tab first.</p>}
        </div>
      ) : (
        <>
          <TextField id={`${prefix}-source`} label="Provider" value={d.sourceType} onChange={(v) => onChange({ sourceType: v })} inputMode="text" hint='e.g. "chartink" — whatever this provider is called' />
          <TextField id={`${prefix}-srn`} label="Scan/rule name (optional)" value={d.sourceRuleName} onChange={(v) => onChange({ sourceRuleName: v })} inputMode="text" hint="The provider's own name for what fires this, purely descriptive" />
        </>
      )}
      <div className="field">
        <label htmlFor={`${prefix}-segment`}>Market</label>
        <select id={`${prefix}-segment`} value={d.segment} onChange={(e) => onChange({ segment: e.target.value as Segment })}>
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-instr`}>Trades</label>
        <select id={`${prefix}-instr`} value={d.instrumentType} onChange={(e) => onChange({ instrumentType: e.target.value as InstrumentType })}>
          <option value="spot" disabled={d.segment !== "NSE"}>
            Shares (spot)
          </option>
          <option value="future">Future</option>
          <option value="option">Option</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-horizon`}>Horizon</label>
        <select id={`${prefix}-horizon`} value={d.horizon} onChange={(e) => onChange({ horizon: e.target.value as Horizon })}>
          <option value="intraday">Intraday</option>
          <option value="positional">Positional</option>
        </select>
      </div>

      {d.instrumentType === "option" && (
        <>
          <div className="field">
            <label htmlFor={`${prefix}-ostyle`}>Option shape</label>
            <select id={`${prefix}-ostyle`} value={d.optionStyle} onChange={(e) => onChange({ optionStyle: e.target.value as OptionPositionStyle })}>
              <option value="spread">Spread (bull call / bear put)</option>
              <option value="naked">Naked (single leg)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-omoney`}>Strike</label>
            <select id={`${prefix}-omoney`} value={d.optionMoneyness} onChange={(e) => onChange({ optionMoneyness: e.target.value as OptionStrikeMoneyness })}>
              {["ITM2", "ITM1", "ATM", "OTM1", "OTM2"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-oscope`}>Stop/target applies to</label>
            <select id={`${prefix}-oscope`} value={d.optionSlScope} onChange={(e) => onChange({ optionSlScope: e.target.value as OptionSlScope })}>
              <option value="combined">The combined premium</option>
              <option value="individual">Each leg on its own</option>
            </select>
          </div>
        </>
      )}

      <div className="field">
        <label htmlFor={`${prefix}-sl-method`}>Stop-loss</label>
        <select id={`${prefix}-sl-method`} value={d.stopMethod ?? ""} onChange={(e) => onChange({ stopMethod: (e.target.value || null) as Strategy["stop_loss_method"] })}>
          <option value="">None</option>
          {STOP_LOSS_METHODS.map((m) => (
            <option key={m} value={m}>
              {STOP_LOSS_METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      {(d.stopMethod === "previous_candle" || d.stopMethod === "indicator") && (
        <div className="field">
          <label htmlFor={`${prefix}-sl-interval`}>Stop candle size</label>
          <select id={`${prefix}-sl-interval`} value={d.stopInterval} onChange={(e) => onChange({ stopInterval: e.target.value })}>
            {STOP_LOSS_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
      )}
      {(d.stopMethod === "percent" || d.stopMethod === "breakeven") && <TextField id={`${prefix}-sl-pct`} label="Stop percent" value={d.stopPercent} onChange={(v) => onChange({ stopPercent: v })} suffix="%" />}
      {d.stopMethod === "indicator" && (
        <>
          <div className="field">
            <label htmlFor={`${prefix}-sl-ind`}>Trailed against</label>
            <select id={`${prefix}-sl-ind`} value={d.stopIndicatorType} onChange={(e) => onChange({ stopIndicatorType: e.target.value })}>
              <option value="supertrend">SuperTrend</option>
              <option value="ema">EMA</option>
            </select>
          </div>
          <TextField id={`${prefix}-sl-period`} label={d.stopIndicatorType === "supertrend" ? "ATR period" : "EMA period"} value={d.stopPeriod} onChange={(v) => onChange({ stopPeriod: v })} inputMode="numeric" />
          {d.stopIndicatorType === "supertrend" && <TextField id={`${prefix}-sl-mult`} label="Multiplier" value={d.stopMultiplier} onChange={(v) => onChange({ stopMultiplier: v })} />}
        </>
      )}
      {d.stopMethod != null && (
        <label className="check">
          <input type="checkbox" checked={d.trailing} onChange={(e) => onChange({ trailing: e.target.checked })} />
          <span>Trail it as the price moves favourably</span>
        </label>
      )}
      <TextField id={`${prefix}-target`} label="Target percent (optional)" value={d.targetPercent} onChange={(v) => onChange({ targetPercent: v })} suffix="%" />
      <TextField id={`${prefix}-lots`} label="Fixed lots (optional — overrides sizing entirely)" value={d.fixedLots} onChange={(v) => onChange({ fixedLots: v })} inputMode="numeric" />

      <div className="field">
        <label htmlFor={`${prefix}-dup`}>A same-direction signal while a position is already open</label>
        <select id={`${prefix}-dup`} value={d.duplicatePolicy} onChange={(e) => onChange({ duplicatePolicy: e.target.value as DuplicateSignalPolicy })}>
          <option value="skip">Skip it</option>
          <option value="add_position">Add another position</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-counter`}>An opposite-direction signal</label>
        <select id={`${prefix}-counter`} value={d.counterPolicy} onChange={(e) => onChange({ counterPolicy: e.target.value as CounterSignalPolicy })}>
          <option value="skip">Leave the position alone</option>
          <option value="close_and_flip">Close it and flip</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-cdf`}>Contract day</label>
        <select id={`${prefix}-cdf`} value={d.contractDayFilter} onChange={(e) => onChange({ contractDayFilter: e.target.value as ContractDayFilter })}>
          <option value="any">Any day</option>
          <option value="expiry" disabled={d.instrumentType === "spot"}>
            Only expiry day
          </option>
          <option value="start" disabled={d.instrumentType !== "option"}>
            Only the first day of a new contract
          </option>
        </select>
      </div>
      {d.horizon === "positional" && d.instrumentType === "spot" && d.segment === "NSE" && (
        <label className="check">
          <input type="checkbox" checked={d.useMargin} onChange={(e) => onChange({ useMargin: e.target.checked })} />
          <span>Use the platform's NSE margin (MTF) facility</span>
        </label>
      )}
      {d.inHouse && (
        <label className="check">
          <input type="checkbox" checked={d.seedOnActivation} onChange={(e) => onChange({ seedOnActivation: e.target.checked })} />
          <span>Enter the current trend as soon as it goes live (crossover rules only)</span>
        </label>
      )}

      <fieldset className="auto-windows">
        <legend>Only accept a signal in these windows (India time)</legend>
        {d.windows.length === 0 && <p className="faint" style={{ margin: "0 0 6px" }}>No limit.</p>}
        {d.windows.map((w, i) => (
          <div key={i} className="auto-window-row">
            <input aria-label={`Window ${i + 1} start`} type="time" value={w.start} onChange={(e) => onChange({ windows: d.windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
            <span>to</span>
            <input aria-label={`Window ${i + 1} end`} type="time" value={w.end} onChange={(e) => onChange({ windows: d.windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
            <button className="link-btn" onClick={() => onChange({ windows: d.windows.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button className="link-btn" onClick={() => onChange({ windows: [...d.windows, { start: "09:15", end: "15:15" }] })}>
          Add a window
        </button>
      </fieldset>
      <fieldset className="auto-windows">
        <legend>Only accept a signal on these days (blank = every day)</legend>
        <div className="chips" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((w) => (
            <button key={w} aria-pressed={d.weekdays.includes(w)} onClick={() => onChange({ weekdays: d.weekdays.includes(w) ? d.weekdays.filter((x) => x !== w) : [...d.weekdays, w] })}>
              {w}
            </button>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function StatusControls({ s, onSet, busy }: { s: Strategy; onSet: (status: StrategyStatus, resetEngineRun: boolean) => void; busy: boolean }) {
  const [reseed, setReseed] = useState(false);
  if (s.status === "live") {
    return (
      <button className="btn btn-small" disabled={busy} onClick={() => onSet("paused", false)}>
        Pause
      </button>
    );
  }
  return (
    <>
      {isInHouse(s) && (
        <label className="check" style={{ display: "inline-flex", marginRight: 8 }}>
          <input type="checkbox" checked={reseed} onChange={(e) => setReseed(e.target.checked)} />
          <span className="faint" style={{ fontSize: 12 }}>
            Re-enter now
          </span>
        </label>
      )}
      <button className="btn btn-small btn-primary" disabled={busy} onClick={() => onSet("live", reseed)}>
        Go live
      </button>
    </>
  );
}

export function StrategiesTab({ strategies, rules }: { strategies: Resource<Strategy[]>; rules: Resource<Rule[]> }) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(blankDraft());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (setter: (d: Draft) => void, cur: Draft) => (p: Partial<Draft>) => setter({ ...cur, ...p });

  async function create() {
    setError(null);
    const problems = validateDraft(draft);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    try {
      await createStrategy(toFields(draft));
      setDraft(blankDraft());
      setCreating(false);
      strategies.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function save(id: string) {
    setError(null);
    const problems = validateDraft(editDraft);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    try {
      await updateStrategy(id, toFields(editDraft));
      setEditingId(null);
      strategies.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: StrategyStatus, resetEngineRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      await updateStrategy(id, { status, ...(resetEngineRun ? { reset_engine_run: true } : {}) });
      strategies.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not change its status.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteStrategy(id);
      setConfirmDelete(null);
      strategies.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  if (strategies.loading || rules.loading) return <Skeleton lines={3} />;
  if (strategies.error && !strategies.data) return <ErrorNotice error={strategies.error} onRetry={strategies.reload} />;

  return (
    <div className="stack">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!creating ? (
        <button className="btn btn-small" onClick={() => setCreating(true)}>
          New strategy
        </button>
      ) : (
        <div className="card stack">
          <DraftForm draft={draft} onChange={patch(setDraft, draft)} rules={rules.data ?? []} prefix="strat-new" />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-small" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void create()}>
              Save
            </button>
          </div>
        </div>
      )}
      {strategies.data && strategies.data.length === 0 && !creating && <Empty title="No strategies yet">A strategy is the unit of configuration for a signal source — a webhook provider, or one of your own rules.</Empty>}
      {strategies.data?.map((s) => (
        <div className="card" key={s.id} data-testid="strategy-row">
          <div className="row">
            <strong>{s.name}</strong>
            <span className={`pill ${s.status === "live" ? "up" : ""}`}>{s.status}</span>
          </div>
          {editingId === s.id ? (
            <div className="stack" style={{ marginTop: 8 }}>
              <DraftForm draft={editDraft} onChange={patch(setEditDraft, editDraft)} rules={rules.data ?? []} prefix={`strat-edit-${s.id}`} />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-small" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
                <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void save(s.id)}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="faint" style={{ margin: "6px 0 2px" }}>
                {isInHouse(s) ? (s.rule?.name ?? "no rule") : `${s.source_type}${s.source_rule_name ? ` · ${s.source_rule_name}` : ""}`}
              </p>
              <p className="faint" style={{ margin: "0 0 6px" }}>
                {strategySummary(s)}
              </p>
              <p className="faint" style={{ margin: "0 0 6px", fontSize: 12 }}>
                {s.last_scan_at ? `Last scanned ${formatDay(s.last_scan_at)} ${formatTime(s.last_scan_at)}` : s.last_signal_at ? `Last signal ${formatDay(s.last_signal_at)} ${formatTime(s.last_signal_at)}` : "No activity yet"}
              </p>
              <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                {confirmDelete === s.id ? (
                  <>
                    <span className="faint">Delete this strategy?</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => setConfirmDelete(null)}>
                      No
                    </button>
                    <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove(s.id)}>
                      Yes, delete
                    </button>
                  </>
                ) : (
                  <>
                    <StatusControls s={s} busy={busy} onSet={(status, reset) => void setStatus(s.id, status, reset)} />
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setEditingId(s.id);
                        setEditDraft(draftFromStrategy(s));
                        setError(null);
                      }}
                    >
                      Edit
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => setConfirmDelete(s.id)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

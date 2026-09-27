import { useState } from "react";
import { ApiError } from "../../api/http";
import {
  createRule, deleteRule, updateRule, type Indicator, type Interval, type Rule, type RuleConfig, type RuleFields, type UnderlyingType, type Watchlist,
} from "../../api/strategies";
import type { Segment } from "../../api/types";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { TextField } from "../../components/Field";
import { SEGMENTS } from "../../config";
import type { Resource } from "../../hooks/useResource";
import {
  INTERVALS, UNDERLYING_TYPE_LABEL, crossoverEligible, defaultRuleConfig, regimeEligible, ruleConfigSummary, underlyingSummary,
  validateRuleConfig, validateUnderlying,
} from "../../strategies/model";

const RULE_TYPES: { value: RuleConfig["type"]; label: string }[] = [
  { value: "crossover", label: "Crossover — value crosses its own signal line" },
  { value: "breakout", label: "Multi-timeframe breakout" },
  { value: "range_breakout", label: "Range breakout — closes past its own N-bar high/low" },
];
const UNDERLYING_TYPES: UnderlyingType[] = ["symbol", "universe", "symbol_list", "watchlist"];

type Draft = {
  name: string; description: string; segment: Segment; underlyingType: UnderlyingType; underlying: string; interval: Interval;
  config: RuleConfig; regimeIds: string[];
};

function blankDraft(): Draft {
  return { name: "", description: "", segment: "NSE", underlyingType: "symbol", underlying: "", interval: "5min", config: defaultRuleConfig("crossover"), regimeIds: [] };
}

function draftFromRule(r: Rule): Draft {
  return {
    name: r.name, description: r.description ?? "", segment: r.segment, underlyingType: r.underlying_type, underlying: r.underlying ?? "",
    interval: r.interval ?? "5min", config: r.rule_config ?? defaultRuleConfig("crossover"), regimeIds: r.regime_indicator_ids,
  };
}

function toFields(d: Draft): RuleFields {
  return {
    name: d.name.trim(), description: d.description.trim() || undefined, segment: d.segment, underlying: d.underlying.trim(),
    underlying_type: d.underlyingType, interval: d.interval, rule_config: d.config, regime_indicator_ids: d.regimeIds,
  };
}

/** What is wrong with the draft, in words, or an empty list. */
function validateDraft(d: Draft): string[] {
  const errors: string[] = [];
  if (!d.name.trim()) errors.push("Give it a name.");
  errors.push(...validateUnderlying(d.underlyingType, d.underlying, d.segment));
  errors.push(...validateRuleConfig(d.config));
  return errors;
}

/** The rule-type-specific fields of `rule_config`, editable inline. Crossover needs an eligible
 * indicator to exist first; breakout and range-breakout are plain number/interval fields. */
function ConfigFields({ config, onChange, indicators, prefix }: { config: RuleConfig; onChange: (c: RuleConfig) => void; indicators: Indicator[]; prefix: string }) {
  const eligible = crossoverEligible(indicators);
  if (config.type === "crossover") {
    return (
      <div className="field">
        <label htmlFor={`${prefix}-indicator`}>Indicator to cross</label>
        <select id={`${prefix}-indicator`} value={config.indicator_id} onChange={(e) => onChange({ ...config, indicator_id: e.target.value })}>
          <option value="">Choose one…</option>
          {eligible.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        {eligible.length === 0 && <p className="faint" style={{ fontSize: 12, margin: "4px 0 0" }}>No RSI or SuperTrend indicator yet — make one on the Indicators tab first.</p>}
      </div>
    );
  }
  if (config.type === "breakout") {
    return (
      <>
        <div className="field">
          <label htmlFor={`${prefix}-htf`}>Higher timeframe</label>
          <select id={`${prefix}-htf`} value={config.htf_interval} onChange={(e) => onChange({ ...config, htf_interval: e.target.value as Interval })}>
            {INTERVALS.filter((i) => i.value !== "daily" || true).map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
        <TextField id={`${prefix}-htfp`} label="Higher-timeframe breakout period (bars)" value={String(config.htf_breakout_period)} onChange={(v) => onChange({ ...config, htf_breakout_period: Number(v) })} inputMode="numeric" />
        <div className="field">
          <label htmlFor={`${prefix}-ltf`}>Lower timeframe (this rule's own interval)</label>
          <select id={`${prefix}-ltf`} value={config.ltf_interval} onChange={(e) => onChange({ ...config, ltf_interval: e.target.value as Interval })}>
            {INTERVALS.filter((i) => i.value !== "daily").map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
        <TextField id={`${prefix}-ltfp`} label="Lower-timeframe breakout period (bars)" value={String(config.ltf_breakout_period)} onChange={(v) => onChange({ ...config, ltf_breakout_period: Number(v) })} inputMode="numeric" />
        <label className="check">
          <input type="checkbox" checked={config.ema_filter_enabled} onChange={(e) => onChange({ ...config, ema_filter_enabled: e.target.checked })} />
          <span>Also require the close to be on the trend side of an EMA</span>
        </label>
        {config.ema_filter_enabled && <TextField id={`${prefix}-ema`} label="EMA period" value={String(config.ema_period)} onChange={(v) => onChange({ ...config, ema_period: Number(v) })} inputMode="numeric" />}
      </>
    );
  }
  if (config.type === "multi_condition") {
    return <p className="faint" style={{ margin: 0 }}>Multi-condition rules are edited in the classic app for now.</p>;
  }
  return <TextField id={`${prefix}-bp`} label="Breakout period (bars)" value={String(config.breakout_period)} onChange={(v) => onChange({ ...config, breakout_period: Number(v) })} inputMode="numeric" />;
}

function UnderlyingField({ draft, onChange, watchlists, prefix }: { draft: Draft; onChange: (patch: Partial<Draft>) => void; watchlists: Watchlist[]; prefix: string }) {
  if (draft.underlyingType === "watchlist") {
    return (
      <div className="field">
        <label htmlFor={`${prefix}-wl`}>Watchlist</label>
        <select id={`${prefix}-wl`} value={draft.underlying} onChange={(e) => onChange({ underlying: e.target.value })}>
          <option value="">Choose one…</option>
          {watchlists.map((w) => (
            <option key={w.id} value={w.name}>
              {w.name} ({w.symbol_count})
            </option>
          ))}
        </select>
      </div>
    );
  }
  const hint = draft.underlyingType === "universe" ? "An index key, e.g. NIFTYBANK" : draft.underlyingType === "symbol_list" ? "Comma-separated, e.g. GOLDM, SILVER" : "e.g. NIFTY, RELIANCE";
  return <TextField id={`${prefix}-under`} label="Underlying" value={draft.underlying} onChange={(v) => onChange({ underlying: v })} inputMode="text" hint={hint} />;
}

function DraftForm({ draft, onChange, indicators, regimeIndicators, watchlists, prefix }: {
  draft: Draft; onChange: (patch: Partial<Draft>) => void; indicators: Indicator[]; regimeIndicators: Indicator[]; watchlists: Watchlist[]; prefix: string;
}) {
  return (
    <>
      <TextField id={`${prefix}-name`} label="Name" value={draft.name} onChange={(v) => onChange({ name: v })} inputMode="text" />
      <TextField id={`${prefix}-desc`} label="Description (optional)" value={draft.description} onChange={(v) => onChange({ description: v })} inputMode="text" />
      <div className="field">
        <label htmlFor={`${prefix}-segment`}>Market</label>
        <select id={`${prefix}-segment`} value={draft.segment} onChange={(e) => onChange({ segment: e.target.value as Segment })}>
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-utype`}>Scans</label>
        <select id={`${prefix}-utype`} value={draft.underlyingType} onChange={(e) => onChange({ underlyingType: e.target.value as UnderlyingType, underlying: "" })}>
          {UNDERLYING_TYPES.map((t) => (
            <option key={t} value={t}>
              {UNDERLYING_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <UnderlyingField draft={draft} onChange={onChange} watchlists={watchlists} prefix={prefix} />
      <div className="field">
        <label htmlFor={`${prefix}-rtype`}>Rule type</label>
        <select id={`${prefix}-rtype`} value={draft.config.type} onChange={(e) => onChange({ config: defaultRuleConfig(e.target.value as RuleConfig["type"]) })}>
          {RULE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {draft.config.type !== "breakout" && (
        <div className="field">
          <label htmlFor={`${prefix}-interval`}>Interval</label>
          <select id={`${prefix}-interval`} value={draft.interval} onChange={(e) => onChange({ interval: e.target.value as Interval })}>
            {INTERVALS.filter((i) => i.value !== "daily").map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <ConfigFields
        config={draft.config}
        onChange={(c) => {
          // A breakout rule's own interval always follows its lower timeframe (the server enforces this too).
          onChange(c.type === "breakout" ? { config: c, interval: c.ltf_interval } : { config: c });
        }}
        indicators={indicators}
        prefix={prefix}
      />
      <fieldset className="auto-windows">
        <legend>Only fire when these also agree (optional)</legend>
        {regimeIndicators.length === 0 && <p className="faint" style={{ margin: 0 }}>No regime indicator yet (structure, efficiency ratio, ADX, DMI direction, EMA slope or SuperTrend).</p>}
        {regimeIndicators.map((i) => (
          <label key={i.id} className="check" style={{ marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={draft.regimeIds.includes(i.id)}
              onChange={(e) => onChange({ regimeIds: e.target.checked ? [...draft.regimeIds, i.id] : draft.regimeIds.filter((id) => id !== i.id) })}
            />
            <span>{i.name}</span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

export function RulesTab({ rules, indicators, watchlists }: { rules: Resource<Rule[]>; indicators: Resource<Indicator[]>; watchlists: Resource<Watchlist[]> }) {
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
      await createRule(toFields(draft));
      setDraft(blankDraft());
      setCreating(false);
      rules.reload();
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
      await updateRule(id, toFields(editDraft));
      setEditingId(null);
      rules.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteRule(id);
      setConfirmDelete(null);
      rules.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete. A strategy may still reference it.");
    } finally {
      setBusy(false);
    }
  }

  if (rules.loading || indicators.loading || watchlists.loading) return <Skeleton lines={3} />;
  if (rules.error && !rules.data) return <ErrorNotice error={rules.error} onRetry={rules.reload} />;

  const regimeIndicators = regimeEligible(indicators.data ?? []);

  return (
    <div className="stack">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!creating ? (
        <button className="btn btn-small" onClick={() => setCreating(true)}>
          New rule
        </button>
      ) : (
        <div className="card stack">
          <DraftForm draft={draft} onChange={patch(setDraft, draft)} indicators={indicators.data ?? []} regimeIndicators={regimeIndicators} watchlists={watchlists.data ?? []} prefix="rule-new" />
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
      {rules.data && rules.data.length === 0 && !creating && <Empty title="No rules yet">A rule decides when a signal fires. Make one here, then reference it from a strategy.</Empty>}
      {rules.data?.map((r) => (
        <div className="card" key={r.id} data-testid="rule-row">
          <div className="row">
            <strong>{r.name}</strong>
            <span className="faint">{r.segment}</span>
          </div>
          {editingId === r.id ? (
            <div className="stack" style={{ marginTop: 8 }}>
              <DraftForm draft={editDraft} onChange={patch(setEditDraft, editDraft)} indicators={indicators.data ?? []} regimeIndicators={regimeIndicators} watchlists={watchlists.data ?? []} prefix={`rule-edit-${r.id}`} />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-small" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
                <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void save(r.id)}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="faint" style={{ margin: "6px 0 2px" }}>
                {underlyingSummary(r)} · {r.interval}
              </p>
              <p className="faint" style={{ margin: "0 0 6px" }}>
                {ruleConfigSummary(r)}
              </p>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                {confirmDelete === r.id ? (
                  <>
                    <span className="faint">Delete this rule?</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => setConfirmDelete(null)}>
                      No
                    </button>
                    <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove(r.id)}>
                      Yes, delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn-small"
                      disabled={r.rule_config?.type === "multi_condition"}
                      title={r.rule_config?.type === "multi_condition" ? "Multi-condition rules are edited in the classic app for now" : undefined}
                      onClick={() => {
                        setEditingId(r.id);
                        setEditDraft(draftFromRule(r));
                        setError(null);
                      }}
                    >
                      Edit
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => setConfirmDelete(r.id)}>
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

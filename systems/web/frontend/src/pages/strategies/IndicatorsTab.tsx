import { useState } from "react";
import { ApiError } from "../../api/http";
import { createIndicator, deleteIndicator, updateIndicator, type Indicator, type IndicatorType } from "../../api/strategies";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { TextField } from "../../components/Field";
import type { Resource } from "../../hooks/useResource";
import { DEFAULT_PARAMS, INDICATOR_PARAM_FIELDS, INDICATOR_TYPE_LABEL, validateParams } from "../../strategies/model";

const TYPES = Object.keys(INDICATOR_TYPE_LABEL) as IndicatorType[];

/** One indicator's params as text fields, driven by INDICATOR_PARAM_FIELDS for its type — the same
 * generic form for creating and editing. `draft` is a string per field so a half-typed number does not
 * fight the parser. */
function ParamsForm({ type, draft, onChange, prefix }: { type: IndicatorType; draft: Record<string, string>; onChange: (key: string, v: string) => void; prefix: string }) {
  return (
    <>
      {INDICATOR_PARAM_FIELDS[type].map((f) => (
        <TextField key={f.key} id={`${prefix}-${f.key}`} label={f.label} value={draft[f.key] ?? ""} onChange={(v) => onChange(f.key, v)} inputMode={f.integer ? "numeric" : "decimal"} />
      ))}
    </>
  );
}

const toText = (params: Record<string, number>): Record<string, string> => Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
const toNumbers = (draft: Record<string, string>): Record<string, number> => Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]));

export function IndicatorsTab({ indicators }: { indicators: Resource<Indicator[]> }) {
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState<IndicatorType>("rsi");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>(toText(DEFAULT_PARAMS.rsi));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function chooseType(t: IndicatorType) {
    setType(t);
    setDraft(toText(DEFAULT_PARAMS[t]));
  }

  async function create() {
    setError(null);
    if (!name.trim()) {
      setError("Give it a name.");
      return;
    }
    const params = toNumbers(draft);
    const problems = validateParams(type, params);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    try {
      await createIndicator({ name: name.trim(), type, params });
      setName("");
      chooseType("rsi");
      setCreating(false);
      indicators.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function save(ind: Indicator) {
    setError(null);
    const params = toNumbers(editDraft);
    const problems = validateParams(ind.type, params);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    try {
      await updateIndicator(ind.id, { params });
      setEditingId(null);
      indicators.reload();
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
      await deleteIndicator(id);
      setConfirmDelete(null);
      indicators.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete. A rule may still reference it.");
    } finally {
      setBusy(false);
    }
  }

  if (indicators.loading) return <Skeleton lines={3} />;
  if (indicators.error && !indicators.data) return <ErrorNotice error={indicators.error} onRetry={indicators.reload} />;

  return (
    <div className="stack">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!creating ? (
        <button className="btn btn-small" onClick={() => setCreating(true)}>
          New indicator
        </button>
      ) : (
        <div className="card stack">
          <TextField id="ind-name" label="Name" value={name} onChange={setName} inputMode="text" hint='e.g. "RSI 14" — how it will show up in a rule picker' />
          <div className="field">
            <label htmlFor="ind-type">Kind</label>
            <select id="ind-type" value={type} onChange={(e) => chooseType(e.target.value as IndicatorType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {INDICATOR_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <ParamsForm type={type} draft={draft} onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} prefix="ind-new" />
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
      {indicators.data && indicators.data.length === 0 && !creating && <Empty title="No indicators yet">An indicator is a reusable calculation a rule can watch, e.g. RSI 14 or ADX 14/20.</Empty>}
      {indicators.data?.map((i) => (
        <div className="card" key={i.id} data-testid="indicator-row">
          <div className="row">
            <strong>{i.name}</strong>
            <span className="pill">{INDICATOR_TYPE_LABEL[i.type]}</span>
          </div>
          {editingId === i.id ? (
            <div className="stack" style={{ marginTop: 8 }}>
              <ParamsForm type={i.type} draft={editDraft} onChange={(k, v) => setEditDraft((d) => ({ ...d, [k]: v }))} prefix={`ind-edit-${i.id}`} />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-small" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
                <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void save(i)}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="faint" style={{ margin: "6px 0" }}>
                {Object.entries(i.params).map(([k, v]) => `${k}: ${v}`).join(" · ")}
              </p>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                {confirmDelete === i.id ? (
                  <>
                    <span className="faint">Delete this indicator?</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => setConfirmDelete(null)}>
                      No
                    </button>
                    <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove(i.id)}>
                      Yes, delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setEditingId(i.id);
                        setEditDraft(toText(i.params));
                        setError(null);
                      }}
                    >
                      Edit
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => setConfirmDelete(i.id)}>
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

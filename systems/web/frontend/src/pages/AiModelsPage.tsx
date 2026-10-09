import { useState } from "react";
import { Link } from "react-router-dom";
import { getAiModels, getModelCatalog, setAiModel } from "../api/aiModels";
import { ApiError } from "../api/http";
import type { AiModelTask, CatalogModel } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { useResource } from "../hooks/useResource";
import { NO_FILTERS, SOURCE_LABEL, checkChoice, filterCatalog, hasFilters, isChanged, optionLabel, priceText, providers, setupSummary, tagsOf, type Filters } from "./aiModelsModel";

const LIST_ID = "ai-model-options";

/** Which model each AI task runs on. A platform-wide setting (the platform pays for the scheduled and shared calls),
 * so it is an operator screen. One shared default plus an optional choice per task covers "the same everywhere" and
 * "different for each" without two separate modes. */
export function AiModelsPage() {
  const models = useResource(getAiModels, []);
  const catalog = useResource(getModelCatalog, []);
  const byId = new Map((catalog.data ?? []).map((m) => [m.id, m]));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const shown = filterCatalog(catalog.data ?? [], filters);

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <Link to="/more">← More</Link>
      </p>
      <h1>AI models</h1>
      <p className="dim" style={{ margin: 0 }}>
        Choose which model handles each AI task. Set one shared default to use the same model everywhere, or give a task its own. A
        change applies to the next run. Only models that can return structured JSON are offered, since every task needs that.
      </p>

      {(models.loading || catalog.loading) && <Skeleton lines={5} />}
      {models.error && <ErrorNotice error={models.error} onRetry={models.reload} />}
      {catalog.error && <ErrorNotice error={catalog.error} onRetry={catalog.reload} />}

      {models.data && catalog.data && (
        <>
          <datalist id={LIST_ID}>
            {shown.map((m) => (
              <option key={m.id} value={m.id}>
                {optionLabel(m)}
              </option>
            ))}
          </datalist>
          <p className="faint" style={{ margin: 0 }} data-testid="ai-setup-summary">
            {setupSummary(models.data.tasks)}
          </p>

          <FilterBar filters={filters} onChange={setFilters} catalog={catalog.data} shown={shown.length} />

          <div className="card stack">
            <div>
              <strong>Shared default</strong>
              <div className="dim" style={{ fontSize: 13 }}>
                Used by every task that has no choice of its own. Leave it empty to use each task&apos;s server setting.
              </div>
            </div>
            <Picker
              label="Shared default model"
              saved={models.data.default}
              catalog={catalog.data}
              onSave={(m) => setAiModel("default", m).then(models.reload)}
              clearLabel="Clear"
            />
          </div>

          {models.data.tasks.map((t) => (
            <TaskCard key={t.task} task={t} catalog={catalog.data!} current={byId.get(t.model)} onChanged={models.reload} />
          ))}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, catalog, current, onChanged }: { task: AiModelTask; catalog: CatalogModel[]; current: CatalogModel | undefined; onChanged: () => void }) {
  return (
    <div className="card stack" data-testid={`ai-task-${task.task}`}>
      <div>
        <strong>{task.label}</strong>
        <div className="dim" style={{ fontSize: 13 }}>
          {task.description}
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <span>
          Using <b className="num">{task.model}</b>
        </span>
        <span className={task.source === "task" ? "pill up" : "pill"}>{SOURCE_LABEL[task.source]}</span>
      </div>
      {current && (
        <span className="faint" style={{ fontSize: 12 }}>
          {[priceText(current), ...tagsOf(current)].join(" · ")}
        </span>
      )}
      {!current && (
        <span className="faint" style={{ fontSize: 12 }}>
          Not in OpenRouter&apos;s current list, so it may stop working. Pick another model.
        </span>
      )}
      <Picker label={`${task.label} model`} saved={task.override} catalog={catalog} onSave={(m) => setAiModel(task.task, m).then(onChanged)} clearLabel="Follow the default" />
    </div>
  );
}

/** A model id box with the catalog as suggestions, a Save that is only offered for a real change, and a Clear. */
function Picker({ label, saved, catalog, onSave, clearLabel }: { label: string; saved: string | null; catalog: CatalogModel[]; onSave: (model: string | null) => Promise<unknown>; clearLabel: string }) {
  const [typed, setTyped] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);

  async function run(model: string | null) {
    setBusy(true);
    setError(null);
    setSavedMsg(false);
    try {
      await onSave(model);
      if (model === null) setTyped("");
      setSavedMsg(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const check = checkChoice(typed, catalog);
    if (!check.ok) return setError(check.reason);
    void run(check.id);
  }

  return (
    <div className="stack">
      <input
        aria-label={label}
        list={LIST_ID}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setError(null);
          setSavedMsg(false);
        }}
        placeholder="Search by name or id, for example google/gemini-2.5-flash-lite"
        spellCheck={false}
        autoComplete="off"
        style={{ width: "100%" }}
      />
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-primary btn-small" onClick={save} disabled={busy || !isChanged(typed, saved)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-small" onClick={() => void run(null)} disabled={busy || saved === null}>
          {clearLabel}
        </button>
        {savedMsg && !error && <span className="up" role="status">Saved</span>}
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Narrows the suggestions every picker below offers. The filters combine, and they only shape the list: a model typed
 * in by id is still accepted if OpenRouter offers it. */
function FilterBar({ filters, onChange, catalog, shown }: { filters: Filters; onChange: (f: Filters) => void; catalog: CatalogModel[]; shown: number }) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const chip = (key: "reasoning" | "vision" | "free", label: string, title: string) => (
    <button key={key} aria-pressed={filters[key]} title={title} onClick={() => set({ [key]: !filters[key] })}>
      {label}
    </button>
  );
  return (
    <div className="card stack" data-testid="ai-filters">
      <div>
        <strong>Filter the model list</strong>
        <div className="dim" style={{ fontSize: 13 }}>
          Narrows the suggestions in the boxes below. Reasoning models think before they answer: usually better on a hard read, but slower and they
          use more tokens.
        </div>
      </div>
      <div className="chips" role="group" aria-label="Model filters">
        {chip("reasoning", "Reasoning", "Models that can think before answering")}
        {chip("vision", "Image input", "Models that also accept images")}
        {chip("free", "Free", "Models with no per-token price")}
      </div>
      <select aria-label="Provider" value={filters.provider} onChange={(e) => set({ provider: e.target.value })}>
        <option value="">All providers</option>
        {providers(catalog).map((p) => (
          <option key={p.id} value={p.id}>
            {p.id} ({p.count})
          </option>
        ))}
      </select>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <span className="faint" data-testid="ai-filter-count">
          {shown} of {catalog.length} models
        </span>
        {hasFilters(filters) && (
          <button className="btn btn-small" onClick={() => onChange(NO_FILTERS)}>
            Reset filters
          </button>
        )}
      </div>
    </div>
  );
}

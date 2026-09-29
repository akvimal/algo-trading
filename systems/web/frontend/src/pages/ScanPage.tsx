import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/http";
import { createCustomScreen, deleteCustomScreen, listCustomScreens, previewCustomScreen, runCustomScreen, updateCustomScreen } from "../api/customScreens";
import type { Buildup, CustomScreen, CustomScreenRunResult, OiBuildup, OiRow, Proximity, Regime, Screener, ScreenerRow } from "../api/types";
import { CLASSIC_APP_URL } from "../config";
import { Empty, ErrorNotice, Signed, Skeleton } from "../components/bits";
import { TextField } from "../components/Field";
import { Sparkline } from "../components/Sparkline";
import { formatDay, formatPct, formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { ScanChartPanel } from "./ScanChartPanel";
import {
  BUILDUP_HELP, BUILDUP_LABEL, OI_DEFAULTS, PAGE, PROXIMITY_LABEL, REGIME_LABEL, SCREENER_DEFAULTS, compactCount, filterOi, filterScreener, tradeLink, visible,
  type OiFilters, type OiSort, type ScreenerFilters, type ScreenerSort,
} from "./scanModel";
import {
  EMPTY_FORM, INDEX_OPTIONS, defToForm, filterSummary, formToDef, sortScreens, validateForm, type CustomScreenForm,
} from "./customScreenModel";

const TABS = [
  { id: "oi", label: "OI buildup" },
  { id: "screener", label: "Screener" },
  { id: "custom", label: "Custom" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const parseTab = (v: string | null): TabId => (TABS.some((t) => t.id === v) ? (v as TabId) : "oi");

export function ScanPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  return (
    <div className="stack">
      <h1>Scan</h1>
      <div className="chips" role="tablist" aria-label="Scans">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "oi" ? <OiScan /> : tab === "screener" ? <ScreenerScan /> : <CustomScreenScan />}
      <p className="faint" style={{ fontSize: 12 }}>
        End-of-day readings for information only. They are not recommendations to buy or sell. Live OI and the Weekly Advisor are still in the{" "}
        <a href={CLASSIC_APP_URL}>classic app</a>.
      </p>
    </div>
  );
}

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <label className="select-field">
      <span className="dim">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="select-field" style={{ flex: "1 1 160px" }}>
      <span className="dim">Search a symbol</span>
      <input type="search" value={value} placeholder="e.g. RELIANCE" onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </label>
  );
}

/** Shows a page at a time; a new filter starts back at the first page. */
function useShown(resetKey: string): [number, () => void] {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [resetKey]);
  return [shown, () => setShown((n) => n + PAGE)];
}

const buildupOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(BUILDUP_LABEL) as Buildup[]).map((b) => ({ value: b, label: BUILDUP_LABEL[b] }))];

function OiScan() {
  const data = useResource(() => api<OiBuildup>("marketData", "/oi-buildup?history_days=10"), []);
  const [f, setF] = useState<OiFilters>(OI_DEFAULTS);
  const rows = data.data ? filterOi(data.data.rows, f) : [];
  const [shown, more] = useShown(JSON.stringify(f));
  // Only one card's chart is ever open at a time - each one is a real live chart (its own quote
  // socket, its own klinecharts instance), so this bounds the list to exactly one of those however
  // many cards are on screen. Picking a different card's Chart closes whichever was open.
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="filters">
        <SearchBox value={f.search} onChange={(search) => setF({ ...f, search })} />
        <Select label="Call side" value={f.call} onChange={(call) => setF({ ...f, call })} options={buildupOptions} />
        <Select label="Put side" value={f.put} onChange={(put) => setF({ ...f, put })} options={buildupOptions} />
        <Select<OiSort>
          label="Sort by"
          value={f.sort}
          onChange={(sort) => setF({ ...f, sort })}
          options={[
            { value: "call_oi", label: "Call OI change" },
            { value: "put_oi", label: "Put OI change" },
            { value: "pcr", label: "Put/call ratio" },
            { value: "price", label: "Price change" },
            { value: "symbol", label: "Symbol A to Z" },
          ]}
        />
      </div>
      {data.loading && <Skeleton lines={6} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="dim" style={{ margin: 0 }}>
            End-of-day snapshot for {formatDay(data.data.snapshot_date)}, compared with the previous trading day. {rows.length} of {data.data.rows.length} stocks.
          </p>
          <details className="legend">
            <summary>What do these mean?</summary>
            {(Object.keys(BUILDUP_LABEL) as Buildup[]).map((b) => (
              <div key={b}>
                <strong>{BUILDUP_LABEL[b]}</strong>: {BUILDUP_HELP[b]}.
              </div>
            ))}
            <div>
              <strong>Put/call ratio</strong>: put open interest divided by call open interest. Above 1 means more puts are open than calls.
            </div>
          </details>
          {data.data.rows.length === 0 ? (
            <Empty title="No snapshot yet">The end-of-day scan has not run yet. Check back after the market closes.</Empty>
          ) : rows.length === 0 ? (
            <Empty title="No stocks match">Try clearing a filter.</Empty>
          ) : (
            <>
              <div className="stack" data-testid="oi-list">
                {visible(rows, shown).map((r) => (
                  <OiCard key={r.symbol} row={r} expanded={expanded === r.symbol} onToggle={() => setExpanded((cur) => (cur === r.symbol ? null : r.symbol))} />
                ))}
              </div>
              {shown < rows.length && (
                <button className="btn" onClick={more}>
                  Show more ({rows.length - shown} left)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function BuildupPill({ b }: { b: Buildup | null }) {
  if (!b) return null;
  const good = b === "long_buildup" || b === "short_covering";
  return (
    <span className={`pill ${good ? "up" : "dn"}`} title={BUILDUP_HELP[b]}>
      {BUILDUP_LABEL[b]}
    </span>
  );
}

function OiCard({ row: r, expanded, onToggle }: { row: OiRow; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="card scan-card" data-testid="oi-card">
      <div className="row">
        <strong>{r.symbol}</strong>
        <span>
          <span className="num">{r.spot_price == null ? "–" : formatPrice(r.spot_price)}</span>{" "}
          <Signed value={r.price_change_pct} text={formatPct(r.price_change_pct, 2, true)} />
        </span>
      </div>
      <div className="pair">
        <div>
          <div className="dim">Call OI {compactCount(r.total_call_oi)}</div>
          <Signed value={r.call_oi_change_pct} text={formatPct(r.call_oi_change_pct, 1, true)} /> <BuildupPill b={r.call_buildup} />
        </div>
        <div>
          <div className="dim">Put OI {compactCount(r.total_put_oi)}</div>
          <Signed value={r.put_oi_change_pct} text={formatPct(r.put_oi_change_pct, 1, true)} /> <BuildupPill b={r.put_buildup} />
        </div>
      </div>
      <div className="row">
        <span className="dim">
          Put/call ratio <span className="num">{r.pcr == null ? "–" : r.pcr.toFixed(2)}</span>
        </span>
        <button className="link-btn" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "Close chart" : "Chart"}
        </button>
      </div>
      {expanded && (
        <>
          <ScanChartPanel exchange={r.exchange} symbol={r.symbol} />
          <p style={{ margin: "2px 0 0" }}>
            <Link to={tradeLink(r.symbol)}>Open in Trade, to place an order →</Link>
          </p>
        </>
      )}
    </div>
  );
}

const regimeOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(REGIME_LABEL) as Regime[]).map((r) => ({ value: r, label: REGIME_LABEL[r] }))];
const proximityOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(PROXIMITY_LABEL) as Proximity[]).map((p) => ({ value: p, label: PROXIMITY_LABEL[p] }))];

function ScreenerScan() {
  const data = useResource(() => api<Screener>("marketData", "/equity-screener?history_days=10"), []);
  const [f, setF] = useState<ScreenerFilters>(SCREENER_DEFAULTS);
  const rows = data.data ? filterScreener(data.data.rows, f) : [];
  const [shown, more] = useShown(JSON.stringify(f));

  return (
    <div className="stack">
      <div className="filters">
        <SearchBox value={f.search} onChange={(search) => setF({ ...f, search })} />
        <Select label="Trend" value={f.regime} onChange={(regime) => setF({ ...f, regime })} options={regimeOptions} />
        <Select label="52-week range" value={f.proximity} onChange={(proximity) => setF({ ...f, proximity })} options={proximityOptions} />
        <Select<ScreenerSort>
          label="Sort by"
          value={f.sort}
          onChange={(sort) => setF({ ...f, sort })}
          options={[
            { value: "d5", label: "5-day change" },
            { value: "d20", label: "20-day change" },
            { value: "adx", label: "Trend strength (ADX)" },
            { value: "symbol", label: "Symbol A to Z" },
          ]}
        />
      </div>
      {data.loading && <Skeleton lines={6} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="dim" style={{ margin: 0 }}>
            End-of-day read for {formatDay(data.data.snapshot_date)}. {rows.length} of {data.data.rows.length} stocks. Trend comes from ADX and DMI, the 52-week range from daily bars.
          </p>
          {data.data.rows.length === 0 ? (
            <Empty title="No snapshot yet">The end-of-day screener has not run yet. Check back after the market closes.</Empty>
          ) : rows.length === 0 ? (
            <Empty title="No stocks match">Try clearing a filter.</Empty>
          ) : (
            <>
              <div className="stack" data-testid="screener-list">
                {visible(rows, shown).map((r) => (
                  <ScreenerCard key={r.symbol} row={r} />
                ))}
              </div>
              {shown < rows.length && (
                <button className="btn" onClick={more}>
                  Show more ({rows.length - shown} left)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ScreenerCard({ row: r }: { row: ScreenerRow }) {
  return (
    <div className="card scan-card" data-testid="screener-card">
      <div className="row">
        <strong>{r.symbol}</strong>
        <span className="num">{formatPrice(r.close)}</span>
      </div>
      <div className="pair">
        <div>
          <div className="dim">5 days</div>
          <Signed value={r.pct_change_5d} text={formatPct(r.pct_change_5d, 1, true)} />
        </div>
        <div>
          <div className="dim">20 days</div>
          <Signed value={r.pct_change_20d} text={formatPct(r.pct_change_20d, 1, true)} />
        </div>
        <Sparkline values={r.history.map((h) => h.close)} />
      </div>
      <div className="row">
        <span>
          {r.regime && <span className="pill">{REGIME_LABEL[r.regime]}</span>}
          {r.adx != null && <span className="faint"> ADX {r.adx.toFixed(0)}</span>}
          {r.proximity && (
            <span className={`pill ${r.proximity === "near_52w_high" ? "up" : "dn"}`} style={{ marginLeft: 6 }}>
              {PROXIMITY_LABEL[r.proximity]}
            </span>
          )}
        </span>
        <Link to={tradeLink(r.symbol)}>Chart</Link>
      </div>
    </div>
  );
}

const FNO_OPTIONS = [{ value: "any" as const, label: "Any" }, { value: "yes" as const, label: "F&O only" }, { value: "no" as const, label: "Non-F&O only" }];
const INDEX_SELECT_OPTIONS = [{ value: "", label: "Any" }, ...INDEX_OPTIONS.map((i) => ({ value: i, label: i }))];

/** A saved, per-user, typed expression evaluated against the same EOD universe the other two
 * tabs read - "weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)", labelled
 * "Bearish breakout", filterable to F&O stocks / an index. A price range is just another
 * condition ("close > 100 and close < 500") - no separate min/max fields, see customScreenModel.
 * See app/domain/screener_expr.py (market-data) for the expression grammar. */
function CustomScreenScan() {
  const saved = useResource(listCustomScreens, []);
  const [tab, setTab] = useState<"new" | "saved">("new");
  const [form, setForm] = useState<CustomScreenForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [result, setResult] = useState<CustomScreenRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const errors = validateForm(form);

  async function preview() {
    setRunError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await previewCustomScreen(formToDef(form)));
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runSaved(s: CustomScreen) {
    setRunError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await runCustomScreen(s.id));
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaveError(null);
    setBusy(true);
    try {
      const def = formToDef(form);
      if (editingId) await updateCustomScreen(editingId, def);
      else await createCustomScreen(def);
      cancelEdit();
      saved.reload();
      setTab("saved");
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await deleteCustomScreen(id).catch(() => undefined);
    if (editingId === id) cancelEdit();
    setDeletingId(null);
    saved.reload();
  }

  function edit(s: CustomScreen) {
    setEditingId(s.id);
    setForm(defToForm(s));
    setResult(null);
    setRunError(null);
    setSaveError(null);
    setTab("new"); // the form lives there, whether starting fresh or editing
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  return (
    <div className="stack">
      <div className="chips" role="tablist" aria-label="Custom screens">
        <button role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>
          {editingId ? "Edit screen" : "New screen"}
        </button>
        <button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>
          Saved screens{saved.data && saved.data.length > 0 ? ` (${saved.data.length})` : ""}
        </button>
      </div>

      {tab === "new" && (
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {editingId ? "Edit screen" : "New screen"}
        </h2>
        <TextField id="cs-label" label="Label" value={form.label} onChange={(label) => setForm({ ...form, label })} placeholder="e.g. Bearish breakout" inputMode="text" />
        <TextField
          id="cs-expr"
          label="Condition"
          value={form.expression}
          onChange={(expression) => setForm({ ...form, expression })}
          placeholder="weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)"
          inputMode="text"
          hint="close, open, high, low (daily); weekly_close etc (weekly); ema(N), weekly_ema(N); min(x, N), max(x, N); <, <=, >, >=, ==, !=, crosses_above, crosses_below; and, or, not."
        />
        <div className="filters">
          <Select<CustomScreenForm["fno"]> label="F&O" value={form.fno} onChange={(fno) => setForm({ ...form, fno })} options={FNO_OPTIONS} />
          <Select label="Index" value={form.index} onChange={(index) => setForm({ ...form, index })} options={INDEX_SELECT_OPTIONS} />
        </div>
        {errors.length > 0 && (
          <ul className="hints" aria-live="polite">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {runError && (
          <div className="notice error" role="alert">
            {runError}
          </div>
        )}
        {saveError && (
          <div className="notice error" role="alert">
            {saveError}
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          {editingId && (
            <button className="btn btn-small" onClick={cancelEdit} disabled={busy}>
              Cancel
            </button>
          )}
          <button className="btn btn-small" onClick={() => void preview()} disabled={busy || errors.length > 0}>
            Preview
          </button>
          <button className="btn btn-small btn-primary" onClick={() => void save()} disabled={busy || errors.length > 0}>
            {editingId ? "Save changes" : "Save screen"}
          </button>
        </div>
      </div>
      )}

      {result && (
        <div className="card" data-testid="custom-screen-result">
          <p className="dim" style={{ margin: 0 }}>
            {result.snapshot_date ? `EOD read for ${formatDay(result.snapshot_date)}` : "No EOD data yet - the screener has not run once."}
            {result.snapshot_date && ` · ${result.matches.length} of ${result.candidates} stocks matched`}
            {filterSummary(form) && ` (${filterSummary(form)})`}
          </p>
          {result.snapshot_date && result.matches.length === 0 ? (
            <Empty title="No matches">Try a different condition, or loosen the filters.</Empty>
          ) : (
            <div className="stack" data-testid="custom-screen-matches">
              {result.matches.map((m) => (
                <div className="row" key={m.symbol}>
                  <strong>{m.symbol}</strong>
                  <span className="num">{formatPrice(m.close)}</span>
                  <Link to={tradeLink(m.symbol)}>Chart</Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "saved" && (
      <>
      {saved.loading && <Skeleton lines={3} />}
      {saved.error && <ErrorNotice error={saved.error} onRetry={saved.reload} />}
      {saved.data &&
        (sortScreens(saved.data).length === 0 ? (
          <Empty title="No saved screens yet">Build one and save it.</Empty>
        ) : (
          <div className="stack" data-testid="saved-screens">
            {sortScreens(saved.data).map((s) => (
              <div className="card scan-card" key={s.id} data-testid="saved-screen">
                <div className="row">
                  <strong>{s.label}</strong>
                  {filterSummary(defToForm(s)) && <span className="faint" style={{ fontSize: 12 }}>{filterSummary(defToForm(s))}</span>}
                </div>
                <p className="faint num" style={{ margin: "4px 0", fontSize: 13 }}>
                  {s.expression}
                </p>
                <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                  {deletingId === s.id ? (
                    <>
                      <span className="dim" style={{ fontSize: 13 }}>Delete this screen?</span>
                      <button className="btn btn-small" onClick={() => setDeletingId(null)} disabled={busy}>
                        Keep
                      </button>
                      <button className="btn btn-small btn-danger" onClick={() => void remove(s.id)} disabled={busy}>
                        Confirm delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-small" onClick={() => edit(s)}>
                        Edit
                      </button>
                      <button className="btn btn-small" onClick={() => void runSaved(s)} disabled={busy}>
                        Run
                      </button>
                      <button className="btn btn-small btn-danger" onClick={() => setDeletingId(s.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </>
      )}
    </div>
  );
}

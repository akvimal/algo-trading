import { useEffect, useRef, useState } from "react";

import { type OiBuildup, type OiSummary, type OiSummaryLeg, fetchOiSummary, fetchOptionExpiries, resolveUnderlying } from "./api";
import { OiBarChart } from "./OiBarChart";

// Options only exist on NSE/MCX in this codebase (CRYPTO option chain/
// execution are still planned - see CLAUDE.md) - a narrower type than
// the shared Segment, deliberately excluding CRYPTO.
type OptionExchange = "NSE" | "MCX";

// Fixed watchlist rather than a free-text symbol picker - the 4
// underlyings actually traded via this codebase's option flows (2 NSE
// index, 2 MCX commodity). A typed-symbol picker existed in an earlier
// version of this page; narrowed to tabs per explicit request.
const PRESETS: { key: string; exchange: OptionExchange; symbol: string }[] = [
  { key: "NIFTY", exchange: "NSE", symbol: "NIFTY" },
  { key: "BANKNIFTY", exchange: "NSE", symbol: "BANKNIFTY" },
  { key: "GOLDM", exchange: "MCX", symbol: "GOLDM" },
  { key: "CRUDEOILM", exchange: "MCX", symbol: "CRUDEOILM" },
];

// Only strikes within this many steps of ATM either side are rendered -
// the full chain (e.g. NIFTY often has 100+ strikes) is mostly deep
// ITM/OTM noise nobody reads; a 21-row window centered on ATM is what
// every retail OI-chain view actually shows.
const STRIKES_EACH_SIDE = 10;

// Re-fetches the live summary while a tab is active - matched to
// market-data's own OPTION_CHAIN_CACHE_TTL_SECONDS (30s), since polling
// faster than that just re-renders the same cached response.
const POLL_INTERVAL_MS = 30000;

type TabState = {
  // The RESOLVED chart symbol/exchange (via resolveUnderlying), not
  // necessarily the preset's own symbol: an index (NIFTY/BANKNIFTY)
  // resolves to itself, but an MCX commodity (GOLDM/CRUDEOILM) has no
  // standalone "underlying" row to query at all - Dhan's option chain
  // there is keyed by the active-month FUTURES CONTRACT's own symbol,
  // the same resolution ManualTab.tsx's order-placement flow already
  // goes through (execution's open_manual_option_group uses this exact
  // chart_symbol/chart_exchange pair for the same reason).
  loaded: { exchange: OptionExchange; symbol: string } | null;
  expiries: string[] | null;
  expiry: string | null;
  summary: OiSummary | null;
  loadingExpiries: boolean;
  loadingSummary: boolean;
  error?: string;
};

const EMPTY_TAB_STATE: TabState = {
  loaded: null,
  expiries: null,
  expiry: null,
  summary: null,
  loadingExpiries: false,
  loadingSummary: false,
};

function fmtOi(n: number): string {
  return n.toLocaleString();
}

function fmtChange(n: number | null): string {
  if (n == null) return "-";
  return `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
}

function changeClass(n: number | null): string {
  if (n == null) return "muted";
  return n > 0 ? "pnl-positive" : n < 0 ? "pnl-negative" : "";
}

function fmtIv(n: number | null): string {
  return n == null ? "-" : `${n.toFixed(2)}%`;
}

function fmtPcr(n: number | null): string {
  return n == null ? "-" : n.toFixed(2);
}

function fmtVol(n: number): string {
  return n.toLocaleString();
}

function fmtBidAsk(bid: number, ask: number): string {
  return `${bid.toFixed(2)}/${ask.toFixed(2)}`;
}

// (price up/down x OI up/down) - see market-data's oi_summary.py
// _classify_buildup for the exact rule. icon+short label kept compact
// since the table's already wide; full phrase + rationale is the
// tooltip/legend.
const BUILDUP_META: Record<OiBuildup, { icon: string; short: string; label: string; cls: string }> = {
  long_buildup: { icon: "▲", short: "LB", label: "Long Buildup — price up, OI up (fresh longs)", cls: "oi-buildup-long-buildup" },
  short_buildup: { icon: "▼", short: "SB", label: "Short Buildup — price down, OI up (fresh shorts)", cls: "oi-buildup-short-buildup" },
  short_covering: { icon: "△", short: "SC", label: "Short Covering — price up, OI down (shorts exiting)", cls: "oi-buildup-short-covering" },
  long_unwinding: { icon: "▽", short: "LU", label: "Long Unwinding — price down, OI down (longs exiting)", cls: "oi-buildup-long-unwinding" },
};

function buildupBadge(b: OiBuildup | null) {
  if (!b) return <span className="muted">-</span>;
  const m = BUILDUP_META[b];
  return (
    <span className={`oi-buildup-badge ${m.cls}`} title={m.label}>
      {m.icon} {m.short}
    </span>
  );
}

// Toggleable strike-table columns - OI and Strike itself stay put as the
// anchor columns (that's the whole point of an option chain: comparing
// calls vs. puts at the same strike), everything else can be hidden to
// cut down the wall of columns. Δ5m/Δ15m/IV default ON (existing
// behaviour before Vol/Bid-Ask/Trend were added); the 3 new ones default
// OFF so the table doesn't get wider than it already was without an
// explicit opt-in.
type ColumnKey = "oiChange5m" | "oiChange15m" | "iv" | "vol" | "bidAsk" | "trend";

const COLUMN_DEFS: { key: ColumnKey; label: string }[] = [
  { key: "oiChange5m", label: "Δ5m" },
  { key: "oiChange15m", label: "Δ15m" },
  { key: "iv", label: "IV" },
  { key: "vol", label: "Vol" },
  { key: "bidAsk", label: "Bid/Ask" },
  { key: "trend", label: "Trend" },
];

const DEFAULT_VISIBLE_COLUMNS: Record<ColumnKey, boolean> = {
  oiChange5m: true,
  oiChange15m: true,
  iv: true,
  vol: false,
  bidAsk: false,
  trend: false,
};

// Per-viewer display preference, not app data - localStorage is the
// right fit (survives reload, never round-trips to a backend).
const VISIBLE_COLUMNS_STORAGE_KEY = "oiSummaryVisibleColumns";

function loadVisibleColumns(): Record<ColumnKey, boolean> {
  try {
    const raw = localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE_COLUMNS;
    return { ...DEFAULT_VISIBLE_COLUMNS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_VISIBLE_COLUMNS;
  }
}

export default function OiSummaryPage() {
  const [activeKey, setActiveKey] = useState(PRESETS[0].key);
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
  // Which OI-change window the chart's increase/decrease caps are drawn
  // against - shared across tabs (not per-tab state) since it's a display
  // preference, not data tied to any one underlying.
  const [chartWindow, setChartWindow] = useState<"5m" | "15m">("5m");
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(loadVisibleColumns);

  function toggleColumn(key: ColumnKey) {
    setVisibleColumns((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort persistence only - a private/blocked storage context
        // just means the toggle doesn't survive reload, not a real failure
      }
      return next;
    });
  }

  function updateTab(key: string, patch: Partial<TabState>) {
    setTabStates((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_TAB_STATE), ...patch } }));
  }

  async function loadExpiriesForTab(preset: (typeof PRESETS)[number]) {
    updateTab(preset.key, { loadingExpiries: true, error: undefined, expiries: null, expiry: null, summary: null });
    try {
      const resolved = await resolveUnderlying(preset.exchange, preset.symbol);
      const target = { exchange: resolved.chart_exchange as OptionExchange, symbol: resolved.chart_symbol };
      const list = await fetchOptionExpiries(target.exchange, target.symbol);
      if (list.length === 0) {
        updateTab(preset.key, { loadingExpiries: false, error: `No expiries found for ${target.symbol} on ${target.exchange}` });
        return;
      }
      updateTab(preset.key, { loaded: target, expiries: list, expiry: list[0], loadingExpiries: false });
    } catch (err) {
      updateTab(preset.key, { loadingExpiries: false, error: err instanceof Error ? err.message : "failed to load expiries" });
    }
  }

  async function loadSummaryForTab(key: string, target: { exchange: OptionExchange; symbol: string }, exp: string) {
    updateTab(key, { loadingSummary: true });
    try {
      const data = await fetchOiSummary(target.exchange, target.symbol, exp);
      updateTab(key, { summary: data, loadingSummary: false, error: undefined });
    } catch (err) {
      updateTab(key, { loadingSummary: false, error: err instanceof Error ? err.message : "failed to load OI summary" });
    }
  }

  // Loads a tab's expiries the first time it's visited - not on every
  // switch back to an already-loaded tab. Deliberately depends on
  // activeKey ONLY (not tabStates) so the async load's own state update
  // doesn't retrigger this effect - see loadExpiries's mount-only
  // counterpart pattern elsewhere in this app (e.g. ManualTab.tsx).
  useEffect(() => {
    const preset = PRESETS.find((p) => p.key === activeKey)!;
    const state = tabStates[activeKey];
    if (!state?.loaded && !state?.loadingExpiries) void loadExpiriesForTab(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Fetches the active tab's summary as soon as it has a (loaded,
  // expiry) pair (first load, expiry dropdown change, or tab switch),
  // then again every POLL_INTERVAL_MS - only the ACTIVE tab polls, not
  // all 4 at once. Refs avoid the interval callback closing over a
  // stale tab/expiry if the user switches tabs between ticks, same
  // pattern ManualTab.tsx's own poll loop uses.
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const tabStatesRef = useRef(tabStates);
  tabStatesRef.current = tabStates;

  const activeState = tabStates[activeKey] ?? EMPTY_TAB_STATE;

  useEffect(() => {
    if (!activeState.loaded || !activeState.expiry) return;
    void loadSummaryForTab(activeKey, activeState.loaded, activeState.expiry);
    const id = setInterval(() => {
      const curKey = activeKeyRef.current;
      const curState = tabStatesRef.current[curKey];
      if (curState?.loaded && curState?.expiry) void loadSummaryForTab(curKey, curState.loaded, curState.expiry);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeState.loaded, activeState.expiry]);

  function renderLegCells(leg: OiSummaryLeg | null, itmClass: string, keyPrefix: string) {
    const cells = [<td key={`${keyPrefix}-oi`} className={itmClass}>{leg ? fmtOi(leg.oi) : "-"}</td>];
    if (visibleColumns.oiChange5m) {
      cells.push(
        <td key={`${keyPrefix}-d5`} className={(leg ? changeClass(leg.oi_change_5m) : "") + itmClass}>
          {leg ? fmtChange(leg.oi_change_5m) : "-"}
        </td>,
      );
    }
    if (visibleColumns.oiChange15m) {
      cells.push(
        <td key={`${keyPrefix}-d15`} className={(leg ? changeClass(leg.oi_change_15m) : "") + itmClass}>
          {leg ? fmtChange(leg.oi_change_15m) : "-"}
        </td>,
      );
    }
    if (visibleColumns.iv) {
      cells.push(
        <td key={`${keyPrefix}-iv`} className={itmClass}>
          {leg ? fmtIv(leg.implied_volatility) : "-"}
        </td>,
      );
    }
    if (visibleColumns.vol) {
      cells.push(
        <td key={`${keyPrefix}-vol`} className={itmClass}>
          {leg ? fmtVol(leg.volume) : "-"}
        </td>,
      );
    }
    if (visibleColumns.bidAsk) {
      cells.push(
        <td key={`${keyPrefix}-ba`} className={itmClass}>
          {leg ? fmtBidAsk(leg.top_bid_price, leg.top_ask_price) : "-"}
        </td>,
      );
    }
    if (visibleColumns.trend) {
      cells.push(
        <td key={`${keyPrefix}-tr`} className={itmClass}>
          {leg ? buildupBadge(leg.buildup) : "-"}
        </td>,
      );
    }
    return cells;
  }

  const sideColSpan = 1 + COLUMN_DEFS.filter((c) => visibleColumns[c.key]).length;

  const summary = activeState.summary;
  let visibleStrikes = summary?.strikes ?? [];
  if (summary) {
    const atmIndex = summary.strikes.findIndex((r) => r.call?.moneyness === "ATM" || r.put?.moneyness === "ATM");
    if (atmIndex !== -1) {
      visibleStrikes = summary.strikes.slice(Math.max(0, atmIndex - STRIKES_EACH_SIDE), atmIndex + STRIKES_EACH_SIDE + 1);
    }
  }

  return (
    <div className="manual-wide-page">
      <div className="oi-summary-tabs-row">
        <nav className="tabs">
          {PRESETS.map((p) => (
            <button key={p.key} className={activeKey === p.key ? "active" : ""} onClick={() => setActiveKey(p.key)}>
              {p.key}
            </button>
          ))}
        </nav>

        {activeState.expiries && activeState.expiries.length > 0 && (
          <label className="oi-summary-expiry-picker">
            Expiry
            <select value={activeState.expiry ?? ""} onChange={(e) => updateTab(activeKey, { expiry: e.target.value })}>
              {activeState.expiries.map((exp) => (
                <option key={exp} value={exp}>
                  {exp}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {activeState.loadingExpiries && <p className="muted">Loading expiries...</p>}

      {activeState.loaded && activeState.loaded.symbol !== activeKey && (
        <p className="muted">
          Resolved to active contract: {activeState.loaded.symbol} ({activeState.loaded.exchange})
        </p>
      )}

      {activeState.error && <p className="error">{activeState.error}</p>}

      {/* First load only - once summary exists, loadingSummary's own
          "Refreshing..." indicator further down covers subsequent poll
          ticks instead. Without this, the whole page was blank between
          expiries resolving and the first chain fetch landing. */}
      {activeState.loadingSummary && !summary && (
        <div className="oi-summary-loading">
          <span className="spinner spinner-lg" />
          <span>Loading option chain...</span>
        </div>
      )}

      {summary && (
        <>
          <section className="manual-settings-section">
            <div className="manual-stats-summary">
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Spot</span>
                <span className="manual-stats-card-value">{summary.underlying_last_price.toFixed(2)}</span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">PCR (OI)</span>
                <span className="manual-stats-card-value">{fmtPcr(summary.pcr)}</span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Total Call OI</span>
                <span className="manual-stats-card-value">{fmtOi(summary.total_call_oi)}</span>
                <span className={changeClass(summary.total_call_oi_change_5m)}>
                  {fmtChange(summary.total_call_oi_change_5m)} (5m)
                </span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Total Put OI</span>
                <span className="manual-stats-card-value">{fmtOi(summary.total_put_oi)}</span>
                <span className={changeClass(summary.total_put_oi_change_5m)}>
                  {fmtChange(summary.total_put_oi_change_5m)} (5m)
                </span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">ATM IV (Call / Put)</span>
                <span className="manual-stats-card-value">
                  {fmtIv(summary.atm_call_iv)} / {fmtIv(summary.atm_put_iv)}
                </span>
              </div>
            </div>
            {activeState.loadingSummary && (
              <p className="muted oi-summary-refreshing">
                <span className="spinner" /> Refreshing...
              </p>
            )}
          </section>

          <section className="manual-settings-section">
            <div className="oi-summary-chart-header">
              <h4>OI by strike - {summary.expiry}</h4>
              <div className="oi-summary-window-toggle">
                <button type="button" className={chartWindow === "5m" ? "active" : ""} onClick={() => setChartWindow("5m")}>
                  5m
                </button>
                <button type="button" className={chartWindow === "15m" ? "active" : ""} onClick={() => setChartWindow("15m")}>
                  15m
                </button>
              </div>
            </div>
            <OiBarChart
              strikes={visibleStrikes}
              spot={summary.underlying_last_price}
              symbol={summary.underlying_symbol}
              changeWindow={chartWindow}
            />
          </section>

          <section className="manual-settings-section">
            <div className="oi-summary-chart-header">
              <h4>By strike - {summary.expiry}</h4>
              <div className="oi-buildup-legend">
                {(Object.keys(BUILDUP_META) as OiBuildup[]).map((b) => {
                  const m = BUILDUP_META[b];
                  return (
                    <span key={b} className={`oi-buildup-badge ${m.cls}`} title={m.label}>
                      {m.icon} {m.short}
                    </span>
                  );
                })}
              </div>
            </div>
            <p className="muted oi-summary-legend-caption">
              LB Long Buildup · SB Short Buildup · SC Short Covering · LU Long Unwinding (15m OI vs. premium change) · ITM
              strikes shaded
            </p>
            <div className="oi-column-toggle-row">
              <span className="muted oi-column-toggle-label">Columns</span>
              <div className="oi-summary-window-toggle">
                {COLUMN_DEFS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={visibleColumns[c.key] ? "active" : ""}
                    onClick={() => toggleColumn(c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table oi-summary-table">
                <thead>
                  <tr>
                    <th colSpan={sideColSpan}>Calls</th>
                    <th>Strike</th>
                    <th colSpan={sideColSpan}>Puts</th>
                  </tr>
                  <tr>
                    <th>OI</th>
                    {visibleColumns.oiChange5m && <th>Δ5m</th>}
                    {visibleColumns.oiChange15m && <th>Δ15m</th>}
                    {visibleColumns.iv && <th>IV</th>}
                    {visibleColumns.vol && <th>Vol</th>}
                    {visibleColumns.bidAsk && <th>Bid/Ask</th>}
                    {visibleColumns.trend && <th>Trend</th>}
                    <th></th>
                    <th>OI</th>
                    {visibleColumns.oiChange5m && <th>Δ5m</th>}
                    {visibleColumns.oiChange15m && <th>Δ15m</th>}
                    {visibleColumns.iv && <th>IV</th>}
                    {visibleColumns.vol && <th>Vol</th>}
                    {visibleColumns.bidAsk && <th>Bid/Ask</th>}
                    {visibleColumns.trend && <th>Trend</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleStrikes.map((row) => {
                    const isAtm = row.call?.moneyness === "ATM" || row.put?.moneyness === "ATM";
                    const callItm = row.call?.moneyness === "ITM" ? " oi-itm-cell" : "";
                    const putItm = row.put?.moneyness === "ITM" ? " oi-itm-cell" : "";
                    return (
                      <tr key={row.strike} className={isAtm ? "selected-row" : ""}>
                        {renderLegCells(row.call, callItm, `${row.strike}-call`)}
                        <td className="oi-summary-strike">
                          {row.strike}
                          {isAtm ? " (ATM)" : ""}
                        </td>
                        {renderLegCells(row.put, putItm, `${row.strike}-put`)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

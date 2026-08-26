import { useEffect, useRef, useState } from "react";

import { type OiBuildup, type OiSummary, fetchOiSummary, fetchOptionExpiries, resolveUnderlying } from "./api";
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

export default function OiSummaryPage() {
  const [activeKey, setActiveKey] = useState(PRESETS[0].key);
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
  // Which OI-change window the chart's increase/decrease caps are drawn
  // against - shared across tabs (not per-tab state) since it's a display
  // preference, not data tied to any one underlying.
  const [chartWindow, setChartWindow] = useState<"5m" | "15m">("5m");

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

  const summary = activeState.summary;
  let visibleStrikes = summary?.strikes ?? [];
  if (summary) {
    const atmIndex = summary.strikes.findIndex((r) => r.call?.moneyness === "ATM" || r.put?.moneyness === "ATM");
    if (atmIndex !== -1) {
      visibleStrikes = summary.strikes.slice(Math.max(0, atmIndex - STRIKES_EACH_SIDE), atmIndex + STRIKES_EACH_SIDE + 1);
    }
  }

  return (
    <div className="manual-settings-page">
      <h3>Options OI Summary</h3>
      <p className="muted">
        Put/Call ratio, live OI change (5m/15m), IV, volume, bid/ask, and buildup trend per strike ({STRIKES_EACH_SIDE}{" "}
        strikes either side of ATM) - via Dhan's option chain.
      </p>

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

      {activeState.loadingExpiries && <p className="muted">Loading expiries...</p>}

      {activeState.loaded && activeState.loaded.symbol !== activeKey && (
        <p className="muted">
          Resolved to active contract: {activeState.loaded.symbol} ({activeState.loaded.exchange})
        </p>
      )}

      {activeState.error && <p className="error">{activeState.error}</p>}

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
            {activeState.loadingSummary && <p className="muted">Refreshing...</p>}
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
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table oi-summary-table">
                <thead>
                  <tr>
                    <th colSpan={7}>Calls</th>
                    <th>Strike</th>
                    <th colSpan={7}>Puts</th>
                  </tr>
                  <tr>
                    <th>OI</th>
                    <th>Δ5m</th>
                    <th>Δ15m</th>
                    <th>IV</th>
                    <th>Vol</th>
                    <th>Bid/Ask</th>
                    <th>Trend</th>
                    <th></th>
                    <th>OI</th>
                    <th>Δ5m</th>
                    <th>Δ15m</th>
                    <th>IV</th>
                    <th>Vol</th>
                    <th>Bid/Ask</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStrikes.map((row) => {
                    const isAtm = row.call?.moneyness === "ATM" || row.put?.moneyness === "ATM";
                    const callItm = row.call?.moneyness === "ITM" ? " oi-itm-cell" : "";
                    const putItm = row.put?.moneyness === "ITM" ? " oi-itm-cell" : "";
                    return (
                      <tr key={row.strike} className={isAtm ? "selected-row" : ""}>
                        <td className={callItm}>{row.call ? fmtOi(row.call.oi) : "-"}</td>
                        <td className={(row.call ? changeClass(row.call.oi_change_5m) : "") + callItm}>
                          {row.call ? fmtChange(row.call.oi_change_5m) : "-"}
                        </td>
                        <td className={(row.call ? changeClass(row.call.oi_change_15m) : "") + callItm}>
                          {row.call ? fmtChange(row.call.oi_change_15m) : "-"}
                        </td>
                        <td className={callItm}>{row.call ? fmtIv(row.call.implied_volatility) : "-"}</td>
                        <td className={callItm}>{row.call ? fmtVol(row.call.volume) : "-"}</td>
                        <td className={callItm}>{row.call ? fmtBidAsk(row.call.top_bid_price, row.call.top_ask_price) : "-"}</td>
                        <td className={callItm}>{row.call ? buildupBadge(row.call.buildup) : "-"}</td>
                        <td className="oi-summary-strike">
                          {row.strike}
                          {isAtm ? " (ATM)" : ""}
                        </td>
                        <td className={putItm}>{row.put ? fmtOi(row.put.oi) : "-"}</td>
                        <td className={(row.put ? changeClass(row.put.oi_change_5m) : "") + putItm}>
                          {row.put ? fmtChange(row.put.oi_change_5m) : "-"}
                        </td>
                        <td className={(row.put ? changeClass(row.put.oi_change_15m) : "") + putItm}>
                          {row.put ? fmtChange(row.put.oi_change_15m) : "-"}
                        </td>
                        <td className={putItm}>{row.put ? fmtIv(row.put.implied_volatility) : "-"}</td>
                        <td className={putItm}>{row.put ? fmtVol(row.put.volume) : "-"}</td>
                        <td className={putItm}>{row.put ? fmtBidAsk(row.put.top_bid_price, row.put.top_ask_price) : "-"}</td>
                        <td className={putItm}>{row.put ? buildupBadge(row.put.buildup) : "-"}</td>
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

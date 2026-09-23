import { useEffect, useMemo, useState } from "react";

import { type OiBuildup, type OiBuildupHistoryPoint, type OiBuildupRow, fetchOiBuildup } from "./api";
import { BUILDUP_META, buildupBadge, fmtPcr } from "./OiSummaryPage";

// Opens this same frontend's OI Summary page as a one-off custom tab for
// `symbol` - the exact URL shape signal-engine's own links.ts already
// builds for WeeklyAdvisorPage's "View OI" link (OiSummaryPage.tsx reads
// ?tab=oi&symbol= on load). A new browser tab, not a shell postMessage/
// iframe-reload (shell/index.html's goToOiTab) - this screener is its own
// top-level shell tab, and replacing ITS OWN iframe's src via postMessage
// would navigate the tab the user is currently looking at away from this
// screener, losing their filters/scroll position.
function openOiSummary(symbol: string) {
  window.open(`${window.location.origin}/?tab=oi&symbol=${encodeURIComponent(symbol)}`, "_blank");
}

// Same reasoning, for the Intraday/Live Chart page - manual-trading's own
// default page (no ?tab=), reading ?symbol= once at mount (see shell/
// index.html's goToIntradayTab, which this deliberately does NOT reuse:
// that one reloads the CURRENT shell tab's iframe via postMessage, which
// from inside a different top-level tab (this screener) would yank the
// user away from it instead of opening a new one).
function openIntradayChart(symbol: string) {
  window.open(`${window.location.origin}/?symbol=${encodeURIComponent(symbol)}`, "_blank");
}

function OiChainIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="1.5" y="2" width="13" height="3" rx="0.6" />
      <rect x="1.5" y="6.5" width="13" height="3" rx="0.6" />
      <rect x="1.5" y="11" width="13" height="3" rx="0.6" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <path d="M2 13.5 V2.5" />
      <path d="M2 13.5 H14" />
      <rect x="4" y="8.5" width="2" height="5" fill="currentColor" stroke="none" />
      <rect x="7.5" y="5.5" width="2" height="8" fill="currentColor" stroke="none" />
      <rect x="11" y="10" width="2" height="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function fmtPct(n: number | null): string {
  if (n == null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function pctClass(n: number | null): string {
  if (n == null) return "muted";
  return n > 0 ? "pnl-positive" : n < 0 ? "pnl-negative" : "";
}

// Compact inline trend line over a row's own history (oldest-first,
// ending at its current snapshot) - total OI (call+put combined), not
// spot price: this screener is about OI buildup, not price action (the
// price Δ% column already covers that). Min-max normalized to the row's
// OWN range, not a shared scale - a sparkline is a shape, not a
// cross-row-comparable chart.
function Sparkline({ history }: { history: OiBuildupHistoryPoint[] }) {
  if (history.length < 2) return <span className="muted">-</span>;
  const totals = history.map((h) => h.total_call_oi + h.total_put_oi);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const width = 72;
  const height = 22;
  const span = max - min;
  const points = totals
    .map((v, i) => {
      const x = (i / (totals.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = totals[totals.length - 1] >= totals[0];
  return (
    <span title={`Total OI over the last ${history.length} trading day(s)`}>
      <svg width={width} height={height} className="oi-buildup-sparkline">
        <polyline points={points} fill="none" stroke={rising ? "var(--buy)" : "var(--sell)"} strokeWidth={1.5} />
      </svg>
    </span>
  );
}

type BuildupFilter = "all" | OiBuildup;
type SortKey = "symbol" | "call_oi_change_pct" | "put_oi_change_pct" | "price_change_pct" | "pcr";

const BUILDUP_FILTER_OPTIONS: BuildupFilter[] = ["all", "long_buildup", "short_buildup", "short_covering", "long_unwinding"];

function buildupFilterLabel(f: BuildupFilter): string {
  return f === "all" ? "All" : BUILDUP_META[f].short;
}

export default function OiBuildupPage() {
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null);
  const [rows, setRows] = useState<OiBuildupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [callFilter, setCallFilter] = useState<BuildupFilter>("all");
  const [putFilter, setPutFilter] = useState<BuildupFilter>("all");
  // Free-text min/max (not numbers) so the field can sit empty (no bound)
  // rather than defaulting to 0 - PCR has no natural "unset" numeric value.
  const [pcrMin, setPcrMin] = useState("");
  const [pcrMax, setPcrMax] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("call_oi_change_pct");
  const [sortDesc, setSortDesc] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOiBuildup(10);
      setSnapshotDate(data.snapshot_date);
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const visibleRows = useMemo(() => {
    const needle = search.trim().toUpperCase();
    const min = pcrMin.trim() === "" ? null : Number(pcrMin);
    const max = pcrMax.trim() === "" ? null : Number(pcrMax);
    let filtered = rows.filter((r) => {
      if (needle && !r.symbol.includes(needle)) return false;
      if (callFilter !== "all" && r.call_buildup !== callFilter) return false;
      if (putFilter !== "all" && r.put_buildup !== putFilter) return false;
      // A symbol with pcr===null (total_call_oi was 0 that day) never
      // matches a real bound - same "can't compare, so exclude rather
      // than guess" convention as the buildup badges' own null handling.
      if (min != null && (r.pcr == null || r.pcr < min)) return false;
      if (max != null && (r.pcr == null || r.pcr > max)) return false;
      return true;
    });
    filtered = [...filtered].sort((a, b) => {
      if (sortKey === "symbol") {
        return sortDesc ? b.symbol.localeCompare(a.symbol) : a.symbol.localeCompare(b.symbol);
      }
      // nulls (no previous-day snapshot yet, or pcr with 0 call OI) sort
      // last regardless of direction
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDesc ? bv - av : av - bv;
    });
    return filtered;
  }, [rows, search, callFilter, putFilter, pcrMin, pcrMax, sortKey, sortDesc]);

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>OI Buildup</h3>
        <button type="button" className="ctp-link" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Every NSE F&amp;O stock's own end-of-day options OI snapshot, one row per trading day per symbol - built up going
        forward only (Dhan's option-chain API has no historical-OI endpoint, so there's nothing to backfill).
        {rows.length > 0 && snapshotDate ? ` Showing ${snapshotDate}.` : ""} Call/Put change % and buildup badges are
        vs. the previous trading day's own snapshot for that symbol.
      </p>

      {error && <p className="ctp-error">{error}</p>}

      <div className="oi-column-toggle-row">
        <input
          type="text"
          placeholder="Filter symbol..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 160 }}
        />
        <span className="muted oi-column-toggle-label">Call buildup</span>
        <div className="oi-summary-window-toggle">
          {BUILDUP_FILTER_OPTIONS.map((f) => (
            <button key={f} type="button" className={callFilter === f ? "active" : ""} onClick={() => setCallFilter(f)}>
              {buildupFilterLabel(f)}
            </button>
          ))}
        </div>
        <span className="muted oi-column-toggle-label">Put buildup</span>
        <div className="oi-summary-window-toggle">
          {BUILDUP_FILTER_OPTIONS.map((f) => (
            <button key={f} type="button" className={putFilter === f ? "active" : ""} onClick={() => setPutFilter(f)}>
              {buildupFilterLabel(f)}
            </button>
          ))}
        </div>
        <span className="muted oi-column-toggle-label">PCR</span>
        <input
          type="number"
          step="0.1"
          placeholder="min"
          value={pcrMin}
          onChange={(e) => setPcrMin(e.target.value)}
          style={{ width: 64 }}
        />
        <span className="muted">–</span>
        <input
          type="number"
          step="0.1"
          placeholder="max"
          value={pcrMax}
          onChange={(e) => setPcrMax(e.target.value)}
          style={{ width: 64 }}
        />
      </div>

      {loading && rows.length === 0 ? (
        <p className="muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="muted">
          No snapshots yet - the daily EOD job hasn't run yet (see market-data's app/scheduler.py). Check back after
          NSE close.
        </p>
      ) : (
        <div className="manual-stats-table-wrap">
          <table className="manual-stats-table oi-summary-table">
            <thead>
              <tr>
                <th className="sortable-th" onClick={() => toggleSort("symbol")}>
                  Symbol
                </th>
                <th>Spot</th>
                <th className="sortable-th" onClick={() => toggleSort("price_change_pct")}>
                  Price Δ
                </th>
                <th className="sortable-th" onClick={() => toggleSort("call_oi_change_pct")}>
                  Call OI Δ
                </th>
                <th>Call buildup</th>
                <th className="sortable-th" onClick={() => toggleSort("put_oi_change_pct")}>
                  Put OI Δ
                </th>
                <th>Put buildup</th>
                <th className="sortable-th" onClick={() => toggleSort("pcr")}>
                  PCR
                </th>
                <th>Trend</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.symbol}>
                  <td>{r.symbol}</td>
                  <td>{r.spot_price != null ? r.spot_price.toFixed(2) : "-"}</td>
                  <td className={pctClass(r.price_change_pct)}>{fmtPct(r.price_change_pct)}</td>
                  <td className={pctClass(r.call_oi_change_pct)}>{fmtPct(r.call_oi_change_pct)}</td>
                  <td>{buildupBadge(r.call_buildup, "CE")}</td>
                  <td className={pctClass(r.put_oi_change_pct)}>{fmtPct(r.put_oi_change_pct)}</td>
                  <td>{buildupBadge(r.put_buildup, "PE")}</td>
                  <td>{fmtPcr(r.pcr)}</td>
                  <td>
                    <Sparkline history={r.history} />
                  </td>
                  <td className="oi-buildup-links">
                    <button type="button" className="icon-btn" onClick={() => openOiSummary(r.symbol)} title="Open OI chain (new tab)">
                      <OiChainIcon />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => openIntradayChart(r.symbol)} title="Open Intraday chart (new tab)">
                      <ChartIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRows.length === 0 && <p className="muted">No stocks match the current filters.</p>}
        </div>
      )}
    </div>
  );
}

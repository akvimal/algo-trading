import { useEffect, useMemo, useState } from "react";

import { type EquityProximity, type EquityScreenerHistoryPoint, type EquityScreenerRow, type RegimeLabel, fetchEquityScreener } from "./api";

// Same reasoning as OiBuildupPage's own openIntradayChart - a new browser
// tab (not a shell postMessage/iframe-reload), since this screener is its
// own top-level shell tab and reloading ITS OWN iframe via postMessage
// would navigate the tab the user is currently looking at away from it.
function openIntradayChart(symbol: string) {
  window.open(`${window.location.origin}/?symbol=${encodeURIComponent(symbol)}`, "_blank");
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

const REGIME_META: Record<RegimeLabel, { label: string; cls: string }> = {
  trending_up: { label: "Trending ↑", cls: "pnl-positive" },
  trending_down: { label: "Trending ↓", cls: "pnl-negative" },
  ranging: { label: "Ranging", cls: "muted" },
  transitional: { label: "Transitional", cls: "muted" },
};

function regimeBadge(r: RegimeLabel | null) {
  if (!r) return <span className="muted">-</span>;
  const m = REGIME_META[r];
  return <span className={m.cls}>{m.label}</span>;
}

const PROXIMITY_META: Record<EquityProximity, { label: string; cls: string }> = {
  near_52w_high: { label: "52w High", cls: "pnl-positive" },
  near_52w_low: { label: "52w Low", cls: "pnl-negative" },
};

function proximityBadge(p: EquityProximity | null) {
  if (!p) return <span className="muted">-</span>;
  const m = PROXIMITY_META[p];
  return <span className={m.cls}>{m.label}</span>;
}

// Compact inline trend line over a row's own history (oldest-first,
// ending at its current snapshot) - CLOSE price, not volume/OI: this
// screener is a price-momentum read. Min-max normalized to the row's OWN
// range, same convention as OiBuildupPage's Sparkline.
function Sparkline({ history }: { history: EquityScreenerHistoryPoint[] }) {
  if (history.length < 2) return <span className="muted">-</span>;
  const closes = history.map((h) => h.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const width = 72;
  const height = 22;
  const span = max - min;
  const points = closes
    .map((v, i) => {
      const x = (i / (closes.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = closes[closes.length - 1] >= closes[0];
  return (
    <span title={`Close price over the last ${history.length} trading day(s)`}>
      <svg width={width} height={height} className="oi-buildup-sparkline">
        <polyline points={points} fill="none" stroke={rising ? "var(--buy)" : "var(--sell)"} strokeWidth={1.5} />
      </svg>
    </span>
  );
}

type RegimeFilter = "all" | RegimeLabel;
type ProximityFilter = "all" | EquityProximity;
type SortKey = "symbol" | "pct_change_5d" | "pct_change_20d" | "adx";

const REGIME_FILTER_OPTIONS: RegimeFilter[] = ["all", "trending_up", "trending_down", "ranging", "transitional"];
const PROXIMITY_FILTER_OPTIONS: ProximityFilter[] = ["all", "near_52w_high", "near_52w_low"];

function regimeFilterLabel(f: RegimeFilter): string {
  return f === "all" ? "All" : REGIME_META[f].label;
}

function proximityFilterLabel(f: ProximityFilter): string {
  return f === "all" ? "All" : PROXIMITY_META[f].label;
}

export default function EquityScreenerPage() {
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null);
  const [rows, setRows] = useState<EquityScreenerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [regimeFilter, setRegimeFilter] = useState<RegimeFilter>("all");
  const [proximityFilter, setProximityFilter] = useState<ProximityFilter>("all");
  const [adxMin, setAdxMin] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("pct_change_5d");
  const [sortDesc, setSortDesc] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEquityScreener(10);
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
    const minAdx = adxMin.trim() === "" ? null : Number(adxMin);
    let filtered = rows.filter((r) => {
      if (needle && !r.symbol.includes(needle)) return false;
      if (regimeFilter !== "all" && r.regime !== regimeFilter) return false;
      if (proximityFilter !== "all" && r.proximity !== proximityFilter) return false;
      if (minAdx != null && (r.adx == null || r.adx < minAdx)) return false;
      return true;
    });
    filtered = [...filtered].sort((a, b) => {
      if (sortKey === "symbol") {
        return sortDesc ? b.symbol.localeCompare(a.symbol) : a.symbol.localeCompare(b.symbol);
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDesc ? bv - av : av - bv;
    });
    return filtered;
  }, [rows, search, regimeFilter, proximityFilter, adxMin, sortKey, sortDesc]);

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>Equity Screener</h3>
        <button type="button" className="ctp-link" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Every NSE-listed equity's own end-of-day momentum/trend read - 5d/20d price change, ADX trend strength
        (app/domain/regime.py's own regime badge, run in a daily batch), and 52-week high/low proximity. Recomputed
        fresh each day from Dhan's own historical daily bars (no chunking needed there), not diffed against a
        previous snapshot the way OI Buildup is.
        {rows.length > 0 && snapshotDate ? ` Showing ${snapshotDate}.` : ""}
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
        <span className="muted oi-column-toggle-label">Regime</span>
        <div className="oi-summary-window-toggle">
          {REGIME_FILTER_OPTIONS.map((f) => (
            <button key={f} type="button" className={regimeFilter === f ? "active" : ""} onClick={() => setRegimeFilter(f)}>
              {regimeFilterLabel(f)}
            </button>
          ))}
        </div>
        <span className="muted oi-column-toggle-label">52w</span>
        <div className="oi-summary-window-toggle">
          {PROXIMITY_FILTER_OPTIONS.map((f) => (
            <button key={f} type="button" className={proximityFilter === f ? "active" : ""} onClick={() => setProximityFilter(f)}>
              {proximityFilterLabel(f)}
            </button>
          ))}
        </div>
        <span className="muted oi-column-toggle-label">ADX min</span>
        <input type="number" step="1" placeholder="e.g. 25" value={adxMin} onChange={(e) => setAdxMin(e.target.value)} style={{ width: 64 }} />
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
                <th>Close</th>
                <th className="sortable-th" onClick={() => toggleSort("pct_change_5d")}>
                  5d Δ
                </th>
                <th className="sortable-th" onClick={() => toggleSort("pct_change_20d")}>
                  20d Δ
                </th>
                <th className="sortable-th" onClick={() => toggleSort("adx")}>
                  ADX
                </th>
                <th>Regime</th>
                <th>52w</th>
                <th>Trend</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.symbol}>
                  <td>{r.symbol}</td>
                  <td>{r.close.toFixed(2)}</td>
                  <td className={pctClass(r.pct_change_5d)}>{fmtPct(r.pct_change_5d)}</td>
                  <td className={pctClass(r.pct_change_20d)}>{fmtPct(r.pct_change_20d)}</td>
                  <td>{r.adx != null ? r.adx.toFixed(1) : "-"}</td>
                  <td>{regimeBadge(r.regime)}</td>
                  <td>{proximityBadge(r.proximity)}</td>
                  <td>
                    <Sparkline history={r.history} />
                  </td>
                  <td className="oi-buildup-links">
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

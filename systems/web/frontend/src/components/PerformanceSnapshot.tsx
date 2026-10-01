import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { DisciplineV2, EquityHistory, Performance, Segment } from "../api/types";
import { SEGMENTS } from "../config";
import { formatDay, formatInr, formatPct, formatPnl, formatR } from "../format";
import { useResource } from "../hooks/useResource";
import { curveChange, disciplineBand, fillEquityCurve } from "../pages/portfolioModel";
import { DisciplineGauge } from "./DisciplineGauge";
import { EquityChart } from "./EquityChart";
import { ErrorNotice, Signed, Skeleton } from "./bits";
import { Stat } from "./Stat";

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };
const BAND_TEXT = { none: "Not enough trades yet", low: "Needs work", fair: "Getting there", good: "Good" } as const;

/** How the person is actually doing, on the page they open first - a shorter cut of Portfolio's
 * Overview + Review tabs (same equity chart, same discipline idea) rather than a new source of
 * truth. Segment-scoped like those tabs are (the equity/performance/discipline endpoints are
 * per-account, there is no cross-segment rollup on the server), so a person trading more than
 * one market gets a small chip row to flip between them, same as Portfolio's own. */
export function PerformanceSnapshot({ markets }: { markets: Segment[] }) {
  const [segment, setSegment] = useState<Segment>(markets.includes("NSE") ? "NSE" : markets[0]);
  const equity = useResource(() => api<EquityHistory>("execution", `/equity-history/${segment}?days=30`), [segment]);
  const perf = useResource(() => api<Performance>("execution", `/performance/${segment}`), [segment]);
  const discipline = useResource(() => api<DisciplineV2>("execution", `/discipline/${segment}`), [segment]);

  const stats = equity.data?.stats ?? null;
  const change = curveChange(stats);
  const curve = equity.data ? fillEquityCurve(equity.data.points, stats?.since) : [];
  const p = perf.data?.performance ?? null;
  const d = discipline.data;
  const band = d ? disciplineBand(d.score) : "none";

  return (
    <>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Performance
        </h2>
        {markets.length > 1 && (
          <div className="chips" role="group" aria-label="Account">
            {SEGMENTS.filter((s) => markets.includes(s)).map((s) => (
              <button key={s} aria-pressed={segment === s} onClick={() => setSegment(s)}>
                {SEGMENT_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        {equity.loading && <Skeleton lines={3} />}
        {equity.error && <ErrorNotice error={equity.error} onRetry={equity.reload} />}
        {equity.data && !stats && (
          <p className="dim" style={{ margin: 0 }}>
            No equity history yet. It is recorded once a day, so the curve starts after your first trading day ends.
          </p>
        )}
        {stats && change && (
          <>
            <div className="row" style={{ alignItems: "baseline" }}>
              <span className="num" style={{ fontSize: 22, fontWeight: 600 }}>
                {formatInr(stats.latest_equity)}
              </span>
              <Signed value={change.amount} text={`${formatPnl(change.amount)} (${formatPct(change.pct, 2, true)})`} />
            </div>
            <span className="faint" style={{ fontSize: 12 }}>
              since {formatDay(stats.since)}
            </span>
            <div style={{ marginTop: 8 }}>
              <EquityChart points={curve} baseline={stats.baseline} />
            </div>
          </>
        )}
      </div>

      <div className="card">
        {perf.loading && <Skeleton lines={2} />}
        {perf.error && <ErrorNotice error={perf.error} onRetry={perf.reload} />}
        {perf.data && !p && (
          <p className="dim" style={{ margin: 0 }}>
            Numbers appear once you have closed a trade on this account.
          </p>
        )}
        {(p || d) && (
          <div className="row" style={{ alignItems: "center", gap: 20, flexWrap: "wrap" }}>
            {d && (
              <div style={{ display: "grid", justifyItems: "center", gap: 2 }}>
                <DisciplineGauge score={d.score} />
                <span className={`pill ${band === "good" ? "up" : band === "low" ? "dn" : ""}`} style={{ fontSize: 11 }}>
                  {BAND_TEXT[band]}
                </span>
              </div>
            )}
            {p && (
              <div className="stats" style={{ flex: 1, minWidth: 180 }}>
                <Stat label="Win rate" value={formatPct(p.win_rate_pct, 0)} hint={`${p.wins}W / ${p.losses}L`} />
                <Stat label="Expectancy" value={formatR(p.avg_r)} hint="per trade" />
                <Stat label="Profit factor" value={p.profit_factor == null ? "–" : p.profit_factor.toFixed(2)} />
              </div>
            )}
          </div>
        )}
        <p style={{ margin: "12px 0 0" }}>
          <Link to={`/portfolio?segment=${segment}&tab=review`}>See the full breakdown →</Link>
        </p>
      </div>
    </>
  );
}

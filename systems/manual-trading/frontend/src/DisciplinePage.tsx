import { useEffect, useMemo, useState } from "react";

import { type Account, type ChartInterval, type Segment, fetchAccounts, fetchExecPositions, fetchOptionGroups } from "./api";
import { computeDisciplineScore, disciplineColor } from "./discipline";
import { breakdown, BreakdownTable } from "./statsBreakdown";

// Split out of ManualStatsPage (Performance) 2026-09-05 - the overall
// discipline score + "more graphics and data" the user asked for, then
// reworked the same day ("this page takes too much space, make it
// concise and more informative with multiple dimensions") into a wide,
// dense layout instead of a narrow centered column - see
// docs/architecture.md § "Discipline score" for the full design.

const WINDOW_OPTIONS = [7, 14, 30, 60, 90];
const WINDOW_STORAGE_KEY = "manualDisciplineWindowDays";

// The full trade shape both the score (discipline.ts) and the moved
// breakdown tables (statsBreakdown.tsx) need - a superset of each of
// their own narrower input types.
type Trade = {
  id: string;
  segment: Segment;
  symbol: string;
  pnl: number | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
  exit_time: string;
  trend_followed: boolean | null;
  risk_managed: boolean | null;
  entry_interval: ChartInterval | null;
};

function fmtPct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function loadWindowDays(): number {
  const raw = Number(localStorage.getItem(WINDOW_STORAGE_KEY));
  return WINDOW_OPTIONS.includes(raw) ? raw : 30;
}

// A compact ring gauge - stroke-dasharray on a circle, the same
// hand-rolled-SVG convention every other chart in this repo uses (no
// charting-library dependency for something this simple). 0-100 -> 0-360°.
function ScoreGauge({ score }: { score: number | null }) {
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = disciplineColor(score);
  return (
    <svg viewBox="0 0 108 108" className={`discipline-gauge is-${color}`} width="116" height="116">
      <circle cx="54" cy="54" r={r} className="discipline-gauge-track" strokeWidth="9" fill="none" />
      <circle
        cx="54"
        cy="54"
        r={r}
        className="discipline-gauge-fill"
        strokeWidth="9"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        strokeLinecap="round"
        transform="rotate(-90 54 54)"
      />
      <text x="54" y="50" textAnchor="middle" className="discipline-gauge-number">
        {score ?? "—"}
      </text>
      <text x="54" y="68" textAnchor="middle" className="discipline-gauge-label">
        {score == null ? "n/a" : "/ 100"}
      </text>
    </svg>
  );
}

// One compact stat card - label, big rate, a thin bar, trade count. Four
// of these sit in a grid next to the gauge instead of stacking as full-
// width bars (the original layout - too tall, mostly empty either side
// of a narrow centered column).
function StatCard({ label, rate, trades, detail }: { label: string; rate: number | null; trades: number; detail?: string }) {
  const pct = rate == null ? 0 : Math.round(rate * 100);
  const color = disciplineColor(rate == null ? null : pct);
  return (
    <div className={`discipline-card is-${color}`}>
      <span className="discipline-card-label">{label}</span>
      <span className="discipline-card-value">{fmtPct(rate)}</span>
      <div className="discipline-bar-track">
        <div className="discipline-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="discipline-card-detail muted">
        {trades === 0 ? "no tracked trades" : detail ? detail : `${trades} trade${trades === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

export default function DisciplinePage() {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [windowDays, setWindowDays] = useState<number>(loadWindowDays);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    localStorage.setItem(WINDOW_STORAGE_KEY, String(windowDays));
  }, [windowDays]);

  async function refresh() {
    try {
      const [positions, groups, accs] = await Promise.all([
        fetchExecPositions({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchOptionGroups({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchAccounts(),
      ]);
      const fromPositions: Trade[] = positions
        .filter((p) => p.option_group_id == null && p.exit_time != null)
        .map((p) => ({
          id: p.id,
          segment: p.segment,
          symbol: p.symbol,
          pnl: p.pnl,
          entry_price: p.entry_price,
          stop_loss_price: p.stop_loss_price,
          quantity: p.quantity,
          exit_time: p.exit_time!,
          trend_followed: p.trend_followed,
          risk_managed: p.risk_managed,
          entry_interval: p.entry_interval,
        }));
      const fromGroups: Trade[] = groups
        .filter((g) => g.exit_time != null)
        .map((g) => ({
          id: g.id,
          segment: g.segment,
          symbol: g.underlying_symbol,
          pnl: g.pnl,
          entry_price: null,
          stop_loss_price: null,
          quantity: g.quantity,
          exit_time: g.exit_time!,
          trend_followed: g.trend_followed,
          risk_managed: g.risk_managed,
          entry_interval: g.entry_interval,
        }));
      setTrades([...fromPositions, ...fromGroups]);
      setAccounts(accs);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const result = useMemo(() => computeDisciplineScore(trades ?? [], accounts, windowDays), [trades, accounts, windowDays]);

  // Same window the score itself used (windowStart..now) - every table/
  // breakdown below reads this same slice, not the full trade history, so
  // nothing on the page can disagree with the number at the top.
  const windowed = useMemo(() => {
    if (!trades || !result.windowStart) return [];
    return trades.filter((t) => new Date(t.exit_time).toLocaleDateString("en-CA") >= result.windowStart!);
  }, [trades, result.windowStart]);

  // A new dimension: the SAME 4 components, broken out per segment - the
  // header/gauge only ever show one blended number, but NSE/MCX/CRYPTO
  // are traded quite differently, and a segment dragging the overall
  // score down is exactly the kind of thing worth surfacing.
  const bySegment = useMemo(() => {
    const segments = [...new Set(windowed.map((t) => t.segment))] as Segment[];
    return segments
      .map((seg) => {
        const segTrades = windowed.filter((t) => t.segment === seg);
        const withPnl = segTrades.filter((t) => t.pnl != null);
        const known = (flags: (boolean | null)[]) => flags.filter((f): f is boolean => f != null);
        const trendKnown = known(segTrades.map((t) => t.trend_followed));
        const riskKnown = known(segTrades.map((t) => t.risk_managed));
        const acct = accounts.find((a) => a.segment === seg);
        const tfFlags =
          acct?.default_interval != null
            ? segTrades
                .filter((t) => t.entry_interval != null)
                .map((t) => t.entry_interval === acct.default_interval || t.entry_interval === acct.default_higher_interval)
            : [];
        return {
          segment: seg,
          trades: segTrades.length,
          pnl: withPnl.reduce((s, t) => s + (t.pnl ?? 0), 0),
          winRate: withPnl.length > 0 ? withPnl.filter((t) => (t.pnl as number) > 0).length / withPnl.length : null,
          trendRate: trendKnown.length > 0 ? trendKnown.filter(Boolean).length / trendKnown.length : null,
          riskRate: riskKnown.length > 0 ? riskKnown.filter(Boolean).length / riskKnown.length : null,
          timeframeRate: tfFlags.length > 0 ? tfFlags.filter(Boolean).length / tfFlags.length : null,
        };
      })
      .sort((a, b) => b.trades - a.trades);
  }, [windowed, accounts]);

  // Per (segment, day) loss-budget rows - the same aggregation
  // computeDisciplineScore does internally, recomputed here just for
  // display (small enough not to bother threading through the shared fn).
  const lossDays = useMemo(() => {
    const capBySegment = new Map(accounts.filter((a) => a.max_daily_loss != null).map((a) => [a.segment, a.max_daily_loss as number]));
    const byKey = new Map<string, { segment: Segment; day: string; pnl: number }>();
    for (const t of windowed) {
      if (t.pnl == null || !capBySegment.has(t.segment)) continue;
      const day = new Date(t.exit_time).toLocaleDateString("en-CA");
      const key = `${t.segment}|${day}`;
      const row = byKey.get(key) ?? { segment: t.segment, day, pnl: 0 };
      row.pnl += t.pnl;
      byKey.set(key, row);
    }
    return [...byKey.values()]
      .map((r) => ({ ...r, cap: capBySegment.get(r.segment)!, within: r.pnl >= -capBySegment.get(r.segment)! }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }, [windowed, accounts]);

  if (trades === null) {
    return (
      <div className="manual-wide-page">
        <div className="manual-page-header">
          <h3>Discipline</h3>
        </div>
        {error ? <p className="error">Could not reach the backend: {error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>Discipline</h3>
        <label className="discipline-window-picker">
          Window
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                last {d} active days
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted discipline-intro">
        A read on trading HABITS, not just outcomes - averaged only over dimensions you actually have tracked data for,
        over the last {windowDays} days you placed at least one trade{result.windowStart && ` (since ${result.windowStart})`}.
      </p>

      <section className="discipline-hero">
        <ScoreGauge score={result.score} />
        <div className="discipline-cards">
          <StatCard label="Trend-followed" rate={result.trend.rate} trades={result.trend.trades} />
          <StatCard label="Risk-managed" rate={result.riskManaged.rate} trades={result.riskManaged.trades} />
          <StatCard
            label="Loss-budget"
            rate={result.lossDiscipline.rate}
            trades={result.lossDiscipline.trades}
            detail={result.lossDiscipline.days > 0 ? `${result.lossDiscipline.days} day(s) w/ a cap` : undefined}
          />
          <StatCard
            label="Outcome"
            rate={result.outcome.rate}
            trades={result.outcome.trades}
            detail={
              result.outcome.winRate != null
                ? `${fmtPct(result.outcome.winRate)} win${result.outcome.avgR != null ? ` · ${result.outcome.avgR >= 0 ? "+" : ""}${result.outcome.avgR.toFixed(2)}R avg` : ""}`
                : undefined
            }
          />
          <StatCard
            label="Timeframe"
            rate={result.timeframe.rate}
            trades={result.timeframe.trades}
            detail={
              result.timeframe.trades === 0
                ? "set a default interval on the Money tab"
                : undefined
            }
          />
        </div>
      </section>

      <div className="stats-grid">
        {bySegment.length > 0 && (
          <section className="manual-settings-section">
            <h4>By segment</h4>
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table">
                <thead>
                  <tr>
                    <th>Segment</th>
                    <th>Trades</th>
                    <th>Trend</th>
                    <th>Risk-managed</th>
                    <th>Timeframe</th>
                    <th>Win rate</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {bySegment.map((s) => (
                    <tr key={s.segment}>
                      <td>{s.segment}</td>
                      <td>{s.trades}</td>
                      <td>{fmtPct(s.trendRate)}</td>
                      <td>{fmtPct(s.riskRate)}</td>
                      <td>{fmtPct(s.timeframeRate)}</td>
                      <td>{fmtPct(s.winRate)}</td>
                      <td className={s.pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{s.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {lossDays.length > 0 && (
          <section className="manual-settings-section">
            <h4>Daily loss-budget compliance</h4>
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Segment</th>
                    <th>Day P&L</th>
                    <th>Cap</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {lossDays.map((r) => (
                    <tr key={`${r.segment}|${r.day}`}>
                      <td>{r.day}</td>
                      <td>{r.segment}</td>
                      <td className={r.pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{r.pnl.toFixed(2)}</td>
                      <td className="muted">-{r.cap.toFixed(2)}</td>
                      <td>
                        <span className={`badge ${r.within ? "badge-buy" : "badge-sell"}`}>{r.within ? "within" : "breached"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <BreakdownTable
          title="Discipline — trend"
          header="Direction"
          rows={breakdown(windowed, (t) =>
            t.trend_followed == null ? null : t.trend_followed ? "With the trend" : "Against the trend",
          ).sort((a, b) => b.pnl - a.pnl)}
        />
        <BreakdownTable
          title="Discipline — sizing"
          header="Sizing"
          rows={breakdown(windowed, (t) =>
            t.risk_managed == null ? null : t.risk_managed ? "Risk-managed" : "Discretionary size",
          ).sort((a, b) => b.pnl - a.pnl)}
        />
        <BreakdownTable
          title="Discipline — timeframe"
          header="Timeframe"
          rows={breakdown(windowed, (t) => {
            if (t.entry_interval == null) return null;
            const acct = accounts.find((a) => a.segment === t.segment);
            if (acct?.default_interval == null) return null;
            const onDefault = t.entry_interval === acct.default_interval || t.entry_interval === acct.default_higher_interval;
            return onDefault ? "On default" : "Off default";
          }).sort((a, b) => b.pnl - a.pnl)}
        />
      </div>
    </div>
  );
}

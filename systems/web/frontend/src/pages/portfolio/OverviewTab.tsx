import { Link } from "react-router-dom";
import type { EquityHistory, LiveEligibility, Performance } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { EquityChart } from "../../components/EquityChart";
import { ErrorNotice, Signed, Skeleton } from "../../components/bits";
import { Stat } from "../../components/Stat";
import { formatDay, formatInr, formatPct, formatPnl, formatR, formatTime } from "../../format";
import { curveChange, fillEquityCurve, graduation, type Trade } from "../portfolioModel";

type Props = {
  equity: Resource<EquityHistory>;
  perf: Resource<Performance>;
  elig: Resource<LiveEligibility>;
  trades: Trade[] | null;
};

export function OverviewTab({ equity, perf, elig, trades }: Props) {
  const stats = equity.data?.stats ?? null;
  const change = curveChange(stats);
  const curve = equity.data ? fillEquityCurve(equity.data.points, stats?.since) : [];
  const p = perf.data?.performance ?? null;

  return (
    <div className="stack">
      <div className="card">
        <div className="dim">Paper account equity</div>
        {equity.loading && <Skeleton lines={3} />}
        {equity.error && <ErrorNotice error={equity.error} onRetry={equity.reload} />}
        {equity.data && !stats && <p style={{ margin: "6px 0 0" }}>No equity history yet. It is recorded once a day, so the curve starts after your first trading day ends.</p>}
        {stats && change && (
          <>
            <div className="num" style={{ fontSize: 28, fontWeight: 600 }}>
              {formatInr(stats.latest_equity)}
            </div>
            <div style={{ marginBottom: 12 }}>
              <Signed value={change.amount} text={`${formatPnl(change.amount)} (${formatPct(change.pct, 2, true)})`} />
              <span className="dim"> since {formatDay(stats.since)}</span>
            </div>
            <EquityChart points={curve} baseline={stats.baseline} />
            <div className="stats" style={{ marginTop: 14 }}>
              <Stat label="Biggest fall" value={formatPct(-Math.abs(stats.max_drawdown_pct), 1)} hint="from a peak, measured at day end" />
              <Stat label="Days tracked" value={stats.days_tracked} />
              <Stat label="Peak equity" value={formatInr(stats.peak_equity)} />
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 10px" }}>
          How you are doing
        </h2>
        {perf.loading && <Skeleton lines={2} />}
        {perf.error && <ErrorNotice error={perf.error} onRetry={perf.reload} />}
        {perf.data && !p && <p className="dim" style={{ margin: 0 }}>Numbers appear once you have closed a trade on this account.</p>}
        {p && (
          <div className="stats">
            <Stat label="Trades" value={p.trades} />
            <Stat label="Win rate" value={formatPct(p.win_rate_pct, 0)} hint={`${p.wins} won, ${p.losses} lost`} />
            <Stat label="Expectancy" value={formatR(p.avg_r)} hint="average result per trade, in units of the risk you took" />
            <Stat label="Profit factor" value={p.profit_factor == null ? "–" : p.profit_factor.toFixed(2)} hint="money won for every rupee lost" />
            <Stat label="Average win" value={formatPnl(p.avg_win)} />
            <Stat label="Average loss" value={formatPnl(p.avg_loss)} />
          </div>
        )}
      </div>

      <Graduation elig={elig} />

      <h2 className="section-title">Recent fills</h2>
      {trades == null ? (
        <Skeleton lines={3} />
      ) : trades.length === 0 ? (
        <div className="card dim">No closed trades yet.</div>
      ) : (
        <div className="card">
          {trades.slice(0, 5).map((t) => (
            <div className="list-row" key={t.id}>
              <span>
                <span className={`pill ${t.action === "BUY" ? "up" : "dn"}`}>{t.action}</span> {t.symbol}
                <span className="faint"> {formatTime(t.exitTime)}</span>
              </span>
              <Signed value={t.pnl} text={formatPnl(t.pnl)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Graduation({ elig }: { elig: Resource<LiveEligibility> }) {
  if (elig.loading) return <Skeleton lines={2} />;
  if (elig.error) return <ErrorNotice error={elig.error} onRetry={elig.reload} />;
  if (!elig.data) return null;
  const g = graduation(elig.data);
  return (
    <div className="card">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Graduation to live trading
        </h2>
        <span className={`pill ${g.eligible ? "up" : "warn"}`}>
          {g.met} of {g.total}
        </span>
      </div>
      {g.eligible ? (
        <p style={{ marginBottom: 0 }}>You have met every requirement on paper.</p>
      ) : (
        <>
          <p className="dim" style={{ margin: "8px 0" }}>
            Still needed before live trading:
          </p>
          <div>
            {g.unmet.map((r) => (
              <div className="list-row" key={r.key}>
                <span>{r.label}</span>
                <span className="num dim">
                  {r.actual} / {r.required}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!g.enforced && (
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
          For now this is a guide: it does not block you.
        </p>
      )}
      <p style={{ marginBottom: 0 }}>
        <Link to="/more/settings?tab=broker">Manage live trading in Settings</Link>
      </p>
    </div>
  );
}

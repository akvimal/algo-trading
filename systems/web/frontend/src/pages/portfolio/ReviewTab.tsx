import type { Discipline, Performance } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { ErrorNotice, Signed, Skeleton } from "../../components/bits";
import { Stat } from "../../components/Stat";
import { TradeListItem } from "../../components/TradeListItem";
import { formatInr, formatPct, formatPnl } from "../../format";
import { bySetup, disciplineBand, unreviewed, type Trade } from "../portfolioModel";

const BAND_TEXT = { none: "Not enough trades yet", low: "Needs work", fair: "Getting there", good: "Good" } as const;

type Row = { label: string; weight: number; rate: number | null; trades: number; help: string };

function rows(d: Discipline): Row[] {
  return [
    { label: "Planned", weight: 1, rate: d.planned.rate, trades: d.planned.trades, help: "Limit order with a stop-loss set before entering" },
    { label: "Stuck to the plan", weight: 2, rate: d.plan_adherence.rate, trades: d.plan_adherence.trades, help: "Did not move the stop-loss mid-trade" },
    { label: "Reviewed before and after", weight: 2, rate: d.plan_review.rate, trades: d.plan_review.trades, help: "Wrote a plan, then reviewed the trade" },
    { label: "Winning", weight: 1, rate: d.outcome.rate, trades: d.outcome.trades, help: "How the trades actually turned out" },
  ];
}

type Props = { perf: Resource<Performance>; trades: Trade[]; onSaved: () => void };

export function ReviewTab({ perf, trades, onSaved }: Props) {
  const p = perf.data?.performance ?? null;
  const d = perf.data?.discipline ?? null;
  const manual = trades.filter((t) => t.manual && !t.autoTraded);
  const owed = unreviewed(trades);
  const setups = bySetup(manual);
  const band = d ? disciplineBand(d.score) : "none";

  return (
    <div className="stack">
      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 8px" }}>
          Discipline
        </h2>
        {perf.loading && <Skeleton lines={3} />}
        {perf.error && <ErrorNotice error={perf.error} onRetry={perf.reload} />}
        {d && (
          <>
            <div className="row" style={{ alignItems: "baseline" }}>
              <span className="num" style={{ fontSize: 32, fontWeight: 600 }}>
                {d.score ?? "–"}
                {d.score != null && <span className="dim" style={{ fontSize: 14 }}> out of 100</span>}
              </span>
              <span className={`pill ${band === "good" ? "up" : band === "low" ? "dn" : ""}`}>{BAND_TEXT[band]}</span>
            </div>
            <p className="faint" style={{ fontSize: 12, margin: "4px 0 12px" }}>
              {d.score == null
                ? `Needs at least 5 trades in the last ${d.window_days} days. You have ${d.trade_count}.`
                : `Your last ${d.window_days} days, ${d.trade_count} trades. Habits, not profit: it rewards following your own plan.`}
            </p>
            {rows(d).map((r) => (
              <div key={r.label} style={{ marginBottom: 12 }}>
                <div className="row">
                  <span>
                    {r.label} <span className="faint">weight {r.weight}</span>
                  </span>
                  <span className="num">{r.rate == null ? "–" : formatPct(r.rate * 100, 0)}</span>
                </div>
                <div className="bar" role="meter" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.rate == null ? 0 : Math.round(r.rate * 100)}>
                  <i style={{ width: `${(r.rate ?? 0) * 100}%` }} />
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {r.rate == null ? "No trades to judge yet. " : ""}
                  {r.help}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {p && (
        <div className="card">
          <h2 className="section-title" style={{ margin: "0 0 10px" }}>
            What trading costs you
          </h2>
          <div className="stats">
            <Stat label="Result before costs" value={formatPnl(p.gross_pnl)} />
            <Stat label="Charges and taxes" value={formatInr(p.total_charges)} />
            <Stat label="Slippage" value={formatInr(p.total_slippage)} hint="the gap between the price you wanted and got" />
            <Stat label="Result after costs" value={<Signed value={p.total_pnl} text={formatPnl(p.total_pnl)} />} />
            <Stat label="Worst trade" value={formatPnl(p.worst_trade)} />
            <Stat label="Longest losing run" value={p.max_consecutive_losses} hint="trades in a row" />
          </div>
        </div>
      )}

      <h2 className="section-title">By setup</h2>
      {setups.length === 0 ? (
        <div className="card dim">Tag your trades with a setup on the ticket and the results are grouped here.</div>
      ) : (
        <div className="card table-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Setup</th>
                <th>Trades</th>
                <th>Win rate</th>
                <th>Average</th>
              </tr>
            </thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.tag}>
                  <td>{s.tag}</td>
                  <td className="num">{s.trades}</td>
                  <td className="num">{formatPct(s.winRatePct, 0)}</td>
                  <td>
                    <Signed value={s.avgPnl} text={formatPnl(s.avgPnl)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="section-title">Journal</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          {owed.length === 0 ? "Every closed trade is reviewed." : `${owed.length} of ${manual.length} closed trades still need a review.`}
        </p>
        {owed.slice(0, 8).map((t) => (
          <TradeListItem key={t.id} trade={t} onSaved={onSaved} cta="tap to review" />
        ))}
        {owed.length > 8 && <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>Showing the 8 most recent. Review these and the rest appear.</p>}
      </div>
    </div>
  );
}

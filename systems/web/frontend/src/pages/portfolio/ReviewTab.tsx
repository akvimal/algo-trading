import type { DisciplineV2, Performance } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { DisciplineCard } from "../../components/DisciplineCard";
import { Signed } from "../../components/bits";
import { Stat } from "../../components/Stat";
import { TradeListItem } from "../../components/TradeListItem";
import { formatInr, formatPct, formatPnl } from "../../format";
import { bySetup, unreviewed, type Trade } from "../portfolioModel";

type Props = { perf: Resource<Performance>; discipline: Resource<DisciplineV2>; trades: Trade[]; onSaved: () => void };

export function ReviewTab({ perf, discipline, trades, onSaved }: Props) {
  const p = perf.data?.performance ?? null;
  const manual = trades.filter((t) => t.manual && !t.autoTraded);
  const owed = unreviewed(trades);
  const setups = bySetup(manual);

  return (
    <div className="stack">
      <DisciplineCard resource={discipline} />

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

import type { DisciplineV2, MistakeSummary, Performance } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { CredentialsShelf } from "../../components/CredentialsShelf";
import { DisciplineCard } from "../../components/DisciplineCard";
import { MistakeCostCard } from "../../components/MistakeCostCard";
import { Signed } from "../../components/bits";
import { Stat } from "../../components/Stat";
import { TradeListItem } from "../../components/TradeListItem";
import { formatInr, formatPct, formatPnl } from "../../format";
import { bySetup, unreviewed, type Trade } from "../portfolioModel";

type Props = { perf: Resource<Performance>; discipline: Resource<DisciplineV2>; mistakes: Resource<MistakeSummary>; trades: Trade[]; onSaved: () => void };

export function ReviewTab({ perf, discipline, mistakes, trades, onSaved }: Props) {
  const p = perf.data?.performance ?? null;
  const manual = trades.filter((t) => t.manual && !t.autoTraded);
  const owed = unreviewed(trades);
  const setups = bySetup(manual);

  // Trades still owing a review come first: that is what the person is here to do. With none owed it is a quiet note at the end.
  const journal = (
    <>
      <h2 className="section-title">{owed.length > 0 ? "To review" : "Journal"}</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          {owed.length === 0 ? "Every closed trade is reviewed." : `${owed.length} of ${manual.length} closed trades still need a review.`}
        </p>
        {owed.slice(0, 8).map((t) => (
          <TradeListItem key={t.id} trade={t} onSaved={onSaved} cta="tap to review" />
        ))}
        {owed.length > 8 && <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>Showing the 8 most recent. Review these and the rest appear.</p>}
      </div>
    </>
  );

  return (
    <div className="stack">
      {owed.length > 0 && journal}
      <DisciplineCard resource={discipline} />
      {discipline.data && <CredentialsShelf credentials={discipline.data.credentials ?? []} />}

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

      {mistakes.data && <MistakeCostCard summary={mistakes.data} />}

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

      {owed.length === 0 && journal}
    </div>
  );
}

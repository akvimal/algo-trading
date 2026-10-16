import type { MistakeSummary, RootCause } from "../api/types";
import { formatPnl } from "../format";
import { LEVEL_LABEL, tagLabel } from "../pages/journalModel";
import { Signed } from "./bits";

const LEVELS: Exclude<RootCause, "clean">[] = ["study", "plan", "execution"];
const FIX: Record<Exclude<RootCause, "clean">, string> = {
  study: "Check the trend, regime and OI read before the order button.",
  plan: "Set the stop, target and size before you place the order.",
  execution: "Stick to the plan once you are in: alerts, no stop changes.",
};

/** What the reviewed trades cost, by the step that failed, then by specific mistake. Money is what changes behaviour, so it leads. */
export function MistakeCostCard({ summary }: { summary: MistakeSummary }) {
  if (summary.reviewed === 0) {
    return (
      <div className="card dim" data-testid="mistake-costs">
        Review a closed trade (“What went wrong?”) and what each kind of mistake costs shows up here.
        {summary.pending > 0 ? ` ${summary.pending} closed trade${summary.pending === 1 ? " is" : "s are"} waiting.` : ""}
      </div>
    );
  }
  const worst = LEVELS.filter((l) => summary.by_level[l].n > 0).sort((a, b) => summary.by_level[a].pnl - summary.by_level[b].pnl)[0];
  const tags = Object.entries(summary.by_tag).sort((a, b) => a[1].pnl - b[1].pnl).slice(0, 6);
  return (
    <div className="card" data-testid="mistake-costs">
      <h2 className="section-title" style={{ margin: "0 0 10px" }}>
        What went wrong, and what it cost
      </h2>
      <table className="t">
        <thead>
          <tr>
            <th>Step that failed</th>
            <th>Trades</th>
            <th>Result</th>
            <th>Avg loss</th>
          </tr>
        </thead>
        <tbody>
          {LEVELS.map((l) => (
            <tr key={l}>
              <td>{LEVEL_LABEL[l]}</td>
              <td className="num">{summary.by_level[l].n}</td>
              <td>
                <Signed value={summary.by_level[l].pnl} text={formatPnl(summary.by_level[l].pnl)} />
              </td>
              <td className="num">{summary.by_level[l].avg_loss == null ? "–" : formatPnl(summary.by_level[l].avg_loss)}</td>
            </tr>
          ))}
          <tr>
            <td>Clean{summary.clean.lost > 0 ? ` (${summary.clean.lost} lost)` : ""}</td>
            <td className="num">{summary.clean.n}</td>
            <td>
              <Signed value={summary.clean.pnl} text={formatPnl(summary.clean.pnl)} />
            </td>
            <td className="num">{summary.clean.avg_loss == null ? "–" : formatPnl(summary.clean.avg_loss)}</td>
          </tr>
        </tbody>
      </table>
      {worst && summary.by_level[worst].pnl < 0 && (
        <p style={{ margin: "10px 0 0" }}>
          <strong>{LEVEL_LABEL[worst]}</strong> is costing you the most. {FIX[worst]}
        </p>
      )}
      {tags.length > 0 && (
        <>
          <div className="dim" style={{ fontSize: 12, margin: "12px 0 6px" }}>
            By mistake, costliest first
          </div>
          {tags.map(([tag, c]) => (
            <div key={tag} className="list-row">
              <span>
                {tagLabel(tag)} <span className="faint">· {c.n}×{summary.trades_since_last[tag] != null ? `, ${summary.trades_since_last[tag]} trades ago` : ""}</span>
              </span>
              <Signed value={c.pnl} text={formatPnl(c.pnl)} />
            </div>
          ))}
        </>
      )}
      {summary.pending > 0 && <p className="faint" style={{ margin: "10px 0 0", fontSize: 12 }}>{summary.pending} closed trade{summary.pending === 1 ? " is" : "s are"} not reviewed yet and not counted.</p>}
    </div>
  );
}

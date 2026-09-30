import { Empty } from "../../components/bits";
import { TradeListItem } from "../../components/TradeListItem";
import type { Trade } from "../portfolioModel";

export function HistoryTab({ trades, onSaved }: { trades: Trade[]; onSaved: () => void }) {
  if (trades.length === 0) return <Empty title="No closed trades yet">Once you close a trade it is listed here with its result and costs.</Empty>;
  return (
    <div className="card" data-testid="history">
      <p className="faint" style={{ margin: "0 0 4px", fontSize: 12 }}>
        Tap a trade to tag it, add a note or review it.
      </p>
      {trades.map((t) => (
        <TradeListItem key={t.id} trade={t} onSaved={onSaved} />
      ))}
    </div>
  );
}

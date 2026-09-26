import { useState } from "react";
import { formatDay, formatPnl, formatPrice, formatTime } from "../format";
import type { Trade } from "../pages/portfolioModel";
import { Signed } from "./bits";
import { TradeJournal } from "./TradeJournal";

export const EXIT_REASONS: Record<string, string> = {
  square_off: "closed at square-off time",
  stop_loss: "stop-loss hit",
  target: "target hit",
  exit_condition: "exit rule fired",
  manual: "closed by you",
  counter_signal: "closed by an opposite signal",
  liquidation: "liquidated",
  combined_stop_loss: "stop-loss hit",
  combined_target: "target hit",
  individual_stop_loss: "stop-loss hit",
  individual_target: "target hit",
  spot_stop_loss: "stop-loss hit",
  spot_target: "target hit",
};

/** One closed trade as a row that opens into its journal. The whole header is the button, so
 * the tap target is the row (a phone thumb), and aria-expanded tells a screen reader. */
export function TradeListItem({ trade, onSaved, cta }: { trade: Trade; onSaved: () => void; cta?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="list-block">
      <button className="list-row list-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div style={{ textAlign: "left" }}>
          <strong>
            {trade.symbol} <span className={`pill ${trade.action === "BUY" ? "up" : "dn"}`}>{trade.action}</span>
            {trade.kind === "group" && <span className="pill"> options</span>}
            {trade.setupTag && <span className="pill"> {trade.setupTag}</span>}
          </strong>
          <div className="faint" style={{ fontSize: 12 }}>
            {formatDay(trade.exitTime)} {formatTime(trade.exitTime)}
            {trade.exitReason ? ` · ${EXIT_REASONS[trade.exitReason] ?? trade.exitReason}` : ""}
            {trade.charges ? ` · costs ${formatPrice(trade.charges)}` : ""}
            {cta ? ` · ${cta}` : ""}
          </div>
        </div>
        <Signed value={trade.pnl} text={formatPnl(trade.pnl)} />
      </button>
      {open && <TradeJournal trade={trade} onSaved={onSaved} />}
    </div>
  );
}

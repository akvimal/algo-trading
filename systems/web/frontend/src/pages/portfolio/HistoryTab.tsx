import { Empty, Signed } from "../../components/bits";
import { formatDay, formatPnl, formatPrice, formatTime } from "../../format";
import type { Trade } from "../portfolioModel";

const REASONS: Record<string, string> = {
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

export function HistoryTab({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <Empty title="No closed trades yet">Once you close a trade it is listed here with its result and costs.</Empty>;
  return (
    <div className="card" data-testid="history">
      {trades.map((t) => (
        <div className="list-row" key={t.id}>
          <div>
            <strong>
              {t.symbol} <span className={`pill ${t.action === "BUY" ? "up" : "dn"}`}>{t.action}</span>
              {t.kind === "group" && <span className="pill"> options</span>}
            </strong>
            <div className="faint" style={{ fontSize: 12 }}>
              {formatDay(t.exitTime)} {formatTime(t.exitTime)}
              {t.exitReason ? ` · ${REASONS[t.exitReason] ?? t.exitReason}` : ""}
              {t.charges ? ` · costs ${formatPrice(t.charges)}` : ""}
            </div>
          </div>
          <Signed value={t.pnl} text={formatPnl(t.pnl)} />
        </div>
      ))}
    </div>
  );
}

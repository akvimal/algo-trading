import { useState } from "react";
import { cancelWaitingOrder } from "../api/trade";
import type { PendingOrder } from "../api/types";
import { formatPrice } from "../format";

const KIND: Record<PendingOrder["strategy"], string> = { spot: "Stock", future: "Future", naked: "Option", spread: "Debit spread", credit_spread: "Credit spread" };

/** The legs an option order was armed with: the strikes picked (otherwise they are chosen at the open from its moneyness) and the expiry. */
function legsText(w: PendingOrder): string | null {
  if (w.strategy === "spot" || w.strategy === "future") return null;
  const one = w.strategy === "naked";
  const strikes = [w.primary_strike, !one ? w.second_strike : null].filter((s): s is number => s != null);
  const parts = [strikes.length ? `strikes ${strikes.join(" / ")}` : `${w.moneyness ?? "ATM"} strike chosen at the open`, w.expiry ? `expiry ${w.expiry}` : "nearest expiry"];
  return parts.join(" · ");
}

/** Orders that have not opened yet. They hold no position, so the one thing to do with them is cancel. */
export function WaitingOrders({ orders, onChanged }: { orders: PendingOrder[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (orders.length === 0) return null;

  const cancel = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await cancelWaitingOrder(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel that order.");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <>
      <h2 className="section-title">Waiting for a price</h2>
      <div className="card" data-testid="waiting-orders">
        {error && (
          <p role="alert" className="dn" style={{ margin: "0 0 8px" }}>
            {error}
          </p>
        )}
        {orders.map((w) => (
          <div className="list-row" key={w.id} data-testid="waiting-order">
            <span>
              <span className={`pill ${w.action === "BUY" ? "up" : "dn"}`}>{w.action}</span> {w.symbol}{" "}
              <span className="faint">
                {KIND[w.strategy]}
                {w.moneyness ? ` · ${w.moneyness}` : ""}
                {w.horizon === "positional" ? " · positional" : ""}
              </span>
              <span className="faint" style={{ display: "block", fontSize: 12 }}>
                {w.fire_when_open ? (
                    "opens when the market opens, at the latest prices"
                  ) : (
                    <>
                      opens at <span className="num">{formatPrice(w.trigger_price)}</span>
                    </>
                  )}
                {w.last_price != null ? ` · now ${formatPrice(w.last_price)}` : ""}
                {w.quantity != null ? ` · qty ${w.quantity}` : ""}
              </span>
              {legsText(w) && (
                <span className="faint" data-testid="waiting-legs" style={{ display: "block", fontSize: 12 }}>
                  {legsText(w)}
                </span>
              )}
              <span className="faint" style={{ display: "block", fontSize: 12 }}>
                {w.stop_loss_price != null ? `stop ${formatPrice(w.stop_loss_price)}` : "no stop"}
                {w.target_price != null ? ` · target ${formatPrice(w.target_price)}` : ""}
              </span>
            </span>
            <button className="btn btn-small" disabled={busy === w.id} onClick={() => void cancel(w.id)}>
              Cancel
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

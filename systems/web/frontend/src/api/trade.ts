import { api } from "./http";
import type { Candle, Ltp, MarketRegime, PendingOrder, ResolvedUnderlying, Segment } from "./types";
import type { OrderRequest } from "../pages/tradeModel";

export const resolveUnderlying = (segment: Segment, symbol: string) =>
  api<ResolvedUnderlying>("marketData", `/instruments/resolve?segment=${segment}&underlying=${encodeURIComponent(symbol)}`);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Recent candles for one series. `days` reaches back far enough to cover a weekend or holiday. */
export function getCandles(exchange: string, symbol: string, interval: string, days: number, now: Date = new Date()) {
  const from = isoDay(new Date(now.getTime() - days * 86_400_000));
  return api<Candle[]>("marketData", `/candles/history?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&from=${from}`);
}

export const getLtp = (exchange: string, symbol: string) => api<Ltp>("marketData", `/quotes/ltp?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}`);

export const getRegime = (exchange: string, symbol: string, interval: string) =>
  api<MarketRegime>("marketData", `/regime?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=${interval}`);

export const listWaitingOrders = () => api<PendingOrder[]>("execution", "/pending-orders?status=pending");
export const cancelWaitingOrder = (id: string) => api<PendingOrder>("execution", `/pending-orders/${id}`, { method: "DELETE" });

export type PlaceResult = {
  ok: boolean;
  /** Plain-language outcome to show the person. */
  message: string;
  /** Something that did not go as planned but did not stop the order (e.g. a stop that would not attach). */
  warning?: string;
  kind: OrderRequest["kind"];
};

type Placed = { id?: string; status?: string; rejection_reason?: string | null };

/** Sends the order. A rejection from the server (an over-budget order, a stop on the wrong side)
 * comes back as a message, not a crash: the person sees why and can change the ticket. */
export async function placeOrder(req: OrderRequest): Promise<PlaceResult> {
  if (req.kind === "pending") {
    const o = await api<PendingOrder>("execution", req.path, { method: "POST", json: req.body });
    return { ok: true, kind: "pending", message: `Order waiting. It is placed when the price reaches ${o.trigger_price}. It stays armed for up to a day, even with the app closed.` };
  }
  const placed = await api<Placed>("execution", req.path, { method: "POST", json: req.body });
  if (placed.status === "REJECTED") return { ok: false, kind: req.kind, message: placed.rejection_reason ?? "The order was rejected." };

  if (req.kind === "option" && placed.id) {
    // For an option the stop and target are levels of the underlying, attached right after it opens.
    const missed: string[] = [];
    if (req.stop != null) await api("execution", `/option-groups/${placed.id}/spot-stop-loss`, { method: "PUT", json: { spot_stop_loss_price: req.stop } }).catch(() => missed.push("stop-loss"));
    if (req.target != null) await api("execution", `/option-groups/${placed.id}/spot-target`, { method: "PUT", json: { spot_target_price: req.target } }).catch(() => missed.push("target"));
    if (missed.length) return { ok: true, kind: "option", message: "Paper order placed.", warning: `The ${missed.join(" and ")} did not attach. Set it from Portfolio → Positions.` };
  }
  return { ok: true, kind: req.kind, message: "Paper order placed." };
}

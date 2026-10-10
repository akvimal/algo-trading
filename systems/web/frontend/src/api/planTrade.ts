import { api } from "./http";
import type { PendingOrder, Position } from "./types";

/** Where a plan note's trade stands (GET /study-notes/trades). A note that has produced no trade is simply absent. */
export type NoteTrade = {
  note_id: string;
  /** waiting: a Limit entry is armed. open / closed: the position it became. ended: the order expired, was cancelled or refused. */
  state: "waiting" | "open" | "closed" | "ended";
  order: {
    id: string;
    status: string;
    status_reason: string | null;
    trigger_price: number;
    stop_loss_price: number | null;
    target_price: number | null;
    expires_at: string;
    last_price: number | null;
  } | null;
  position: {
    id: string;
    status: string;
    action: "BUY" | "SELL";
    horizon: string | null;
    quantity: number | null;
    entry_price: number | null;
    exit_price: number | null;
    pnl: number | null;
    exit_reason: string | null;
    stop_loss_price: number | null;
    initial_stop_loss_price: number | null;
    target_price: number | null;
    segment: string;
  } | null;
  /** How it ended as a multiple of the risk it was planned with (closed trades with a stop only). */
  r_multiple: number | null;
};

export const getNoteTrades = (ids: string[]) =>
  ids.length === 0 ? Promise.resolve<NoteTrade[]>([]) : api<NoteTrade[]>("execution", `/study-notes/trades?ids=${ids.slice(0, 100).join(",")}`);

/** Places the trade a plan describes, on the positional book: a Market entry opens straight away, a Limit entry is armed on the server. */
export type PlanOrder =
  | { kind: "market"; body: Record<string, unknown> }
  | { kind: "limit"; body: Record<string, unknown> };

export async function placePlanTrade(order: PlanOrder): Promise<{ ok: boolean; message: string }> {
  if (order.kind === "limit") {
    const o = await api<PendingOrder>("execution", "/pending-orders", { method: "POST", json: order.body });
    return { ok: true, message: `Order waiting: it is placed when the price reaches ${o.trigger_price}. It stays armed even with the app closed.` };
  }
  const placed = await api<Pick<Position, "status"> & { rejection_reason?: string | null }>("execution", "/positions/manual", { method: "POST", json: order.body });
  if (placed.status === "REJECTED") return { ok: false, message: placed.rejection_reason ?? "The order was rejected." };
  return { ok: true, message: "Paper trade opened on your positional account." };
}

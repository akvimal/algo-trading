import { api } from "./http";

export type AlertDirection = "above" | "below" | "cross";

export type PriceAlert = {
  id: string;
  exchange: string;
  symbol: string;
  target_price: number;
  direction: AlertDirection;
  note: string | null;
  repeat: boolean;
  active: boolean;
  last_side: "above" | "below" | null;
  created_at: string;
  last_triggered_at: string | null;
  trigger_count: number;
  /** Crossings that could not be sent (no chat, Telegram down...); a one-shot alert stays armed while this is above 0. */
  delivery_failures: number;
  last_error: string | null;
  /** The price when the alert was created. Only on the create response; null in the list. */
  current_price?: number | null;
};

export type AlertChannel = { bot_configured: boolean; chat_set: boolean; chat_id_hint: string | null };

export type NewAlert = { exchange: string; symbol: string; target_price: number; direction: AlertDirection; note?: string; repeat: boolean };

export const listPriceAlerts = () => api<PriceAlert[]>("marketData", "/price-alerts");
export const createPriceAlert = (a: NewAlert) => api<PriceAlert>("marketData", "/price-alerts", { method: "POST", json: a });
export const deletePriceAlert = (id: string) => api<void>("marketData", `/price-alerts/${id}`, { method: "DELETE" });
export const getAlertChannel = () => api<AlertChannel>("marketData", "/price-alerts/channel");
/** Set the Telegram chat the alerts go to; an empty id clears it. */
export const setAlertChannel = (telegram_chat_id: string) => api<AlertChannel>("marketData", "/price-alerts/channel", { method: "PUT", json: { telegram_chat_id } });
export const sendTestAlert = () => api<{ sent: boolean }>("marketData", "/price-alerts/test-telegram", { method: "POST" });

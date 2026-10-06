import { api } from "./http";

export type NotificationCategory = {
  key: string;
  label: string;
  description: string;
  schedule: string;
  admin_only: boolean;
  enabled: boolean;
  params: { top_n?: number };
};

export type Notifications = {
  /** The person has set a Telegram chat; without one nothing can be sent. */
  chat_ready: boolean;
  categories: NotificationCategory[];
};

export type Delivery = {
  category: string;
  label: string;
  /** Sent by "send me the latest now", not on schedule. */
  manual: boolean;
  created_at: string;
  sent_at: string | null;
  status: "sent" | "retrying" | "gave_up";
  attempts: number;
  last_error: string | null;
  first_line: string;
};

export const getNotifications = () => api<Notifications>("marketData", "/notifications");
export const setNotification = (category: string, enabled: boolean, params?: { top_n?: number }) =>
  api<Notifications>("marketData", `/notifications/${category}`, { method: "PUT", json: { enabled, ...(params ? { params } : {}) } });
export const getDeliveries = (limit = 12) => api<Delivery[]>("marketData", `/notifications/history?limit=${limit}`);
/** Send the latest message of a category to the person's own chat now, to check it works. */
export const sendLatestNow = (category: string) => api<{ sent: boolean }>("marketData", `/notifications/${category}/send-now`, { method: "POST" });

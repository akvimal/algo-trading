import { api } from "./http";

export type InboxSeverity = "info" | "warn" | "alert";

export type InboxItem = {
  id: string;
  /** An event is a one-off; a to-do is a live condition that clears itself when fixed. */
  kind: "event" | "todo";
  category: string;
  severity: InboxSeverity;
  title: string;
  body: string | null;
  /** An in-app path to open, e.g. "/portfolio?tab=review". */
  link: string | null;
  created_at: string;
  read: boolean;
};

export type Inbox = { unread: number; items: InboxItem[]; categories: { category: string; count: number; unread: number }[] };

export const getInbox = (opts: { unreadOnly?: boolean; category?: string } = {}) => {
  const q = new URLSearchParams();
  if (opts.unreadOnly) q.set("unread_only", "true");
  if (opts.category) q.set("category", opts.category);
  const s = q.toString();
  return api<Inbox>("execution", `/inbox${s ? `?${s}` : ""}`);
};
export const getUnreadCount = () => api<{ unread: number }>("execution", "/inbox/unread-count");
export const markRead = (id: string) => api<unknown>("execution", `/inbox/${id}/read`, { method: "POST" });
export const markUnread = (id: string) => api<unknown>("execution", `/inbox/${id}/unread`, { method: "POST" });
export const markAllRead = () => api<{ marked: number }>("execution", "/inbox/read-all", { method: "POST" });
export const dismissItem = (id: string) => api<unknown>("execution", `/inbox/${id}`, { method: "DELETE" });

import type { InboxItem, InboxSeverity } from "../api/inbox";
import { formatDay, formatTime } from "../format";

/** What each source calls itself in the filter row. Anything new from a service shows under its own key until it is named here. */
export const CATEGORY_LABEL: Record<string, string> = {
  review: "To review",
  bot: "Spread bot",
  premarket: "Pre-market",
  oi_buildup: "OI alerts",
  oi_index_shift: "Index OI",
  session_nse: "NSE summary",
  session_mcx: "MCX summary",
  session_crypto: "Crypto summary",
  ops: "Operator",
};

export const categoryLabel = (c: string): string => CATEGORY_LABEL[c] ?? c.replace(/_/g, " ");

export const SEVERITY_TONE: Record<InboxSeverity, "dim" | "warn" | "dn"> = { info: "dim", warn: "warn", alert: "dn" };

/** The bell's badge: nothing at 0, the number up to 9, then "9+". */
export const badgeText = (unread: number): string => (unread <= 0 ? "" : unread > 9 ? "9+" : String(unread));

/** "6 Oct 08:45" for an event; to-dos say "open" since their time is when the condition began, not news. */
export function itemTime(i: Pick<InboxItem, "kind" | "created_at">): string {
  return i.kind === "todo" ? "To do" : `${formatDay(i.created_at)} ${formatTime(i.created_at)}`;
}

/** Only an in-app path is followed; anything else (a stray absolute URL from another service) is ignored. */
export const safeLink = (link: string | null): string | null => (link && link.startsWith("/") && !link.startsWith("//") ? link : null);

/** Open to-dos first, then newest first: the order the server sends, kept if it is already right. */
export function arrange(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => Number(b.kind === "todo") - Number(a.kind === "todo") || b.created_at.localeCompare(a.created_at));
}

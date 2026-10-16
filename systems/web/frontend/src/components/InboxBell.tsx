import { useEffect } from "react";
import { Link, NavLink } from "react-router-dom";
import { getUnreadCount } from "../api/inbox";
import { useResource } from "../hooks/useResource";
import { badgeText } from "../pages/inboxModel";

/** The bell with the unread count, opening the inbox. Polls the count quietly, and re-reads at once when the inbox page changes something.
 * `nav` is a full row in the sidebar (labelled, or icon-only with the label for screen readers when the sidebar is collapsed); `bar` is the
 * larger bell above the page on a phone. */
export function InboxBell({ variant = "bar", collapsed = false }: { variant?: "bar" | "nav"; collapsed?: boolean }) {
  const count = useResource(getUnreadCount, [], { pollMs: 60_000 });
  const { reload } = count;
  useEffect(() => {
    window.addEventListener("inbox-changed", reload);
    return () => window.removeEventListener("inbox-changed", reload);
  }, [reload]);
  const unread = count.data?.unread ?? 0;
  const badge = badgeText(unread);
  const label = unread > 0 ? `Inbox, ${unread} unread` : "Inbox";
  const icon = (
    <span className="inbox-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 01-3.4 0" />
      </svg>
      {badge && <span className="inbox-badge" data-testid="inbox-badge">{badge}</span>}
    </span>
  );
  if (variant === "nav") {
    return (
      <NavLink to="/more/inbox" aria-label={label} title={collapsed ? label : undefined} className="inbox-nav">
        {icon}
        <span className={collapsed ? "sr-only" : undefined}>Inbox</span>
      </NavLink>
    );
  }
  return (
    <Link to="/more/inbox" className="inbox-bell" aria-label={label} title="Inbox">
      {icon}
    </Link>
  );
}

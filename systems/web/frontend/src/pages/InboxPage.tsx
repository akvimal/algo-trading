import { useState } from "react";
import { BackLink } from "../components/nav";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/http";
import { dismissItem, getInbox, markAllRead, markRead, markUnread, type InboxItem } from "../api/inbox";
import { Empty, ErrorNotice, Skeleton } from "../components/bits";
import { useResource } from "../hooks/useResource";
import { SEVERITY_TONE, arrange, categoryLabel, itemTime, safeLink } from "./inboxModel";

const POLL_MS = 30_000;

/** Every warning, alert and to-do in one list, unread in bold. Open a line and it is marked read and takes you to where it can be dealt with.
 * To-dos ("3 trades not reviewed") clear themselves when the condition is fixed; events stay until read or dismissed. */
export function InboxPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inbox = useResource(() => getInbox({ unreadOnly, category: category ?? undefined }), [unreadOnly, category], { pollMs: POLL_MS });
  const navigate = useNavigate();

  /** Runs one change, refreshes the list and the bell, and says so if it failed. Returns whether it worked. */
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setProblem(null);
    try {
      await fn();
      inbox.reload();
      window.dispatchEvent(new Event("inbox-changed"));
      return true;
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "That did not work. Try again.");
      return false;
    }
  }

  async function open(item: InboxItem) {
    const to = safeLink(item.link);
    const ok = item.read ? true : await act(() => markRead(item.id));
    if (ok && to) navigate(to);
  }

  return (
    <div className="stack">
      <BackLink to="/more" />
      <h1>Inbox</h1>
      <p className="dim" style={{ margin: 0 }}>
        Warnings, alerts and things to do, in one place. To-dos clear themselves when you have dealt with them.
      </p>

      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn btn-small" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</button>
        <button className="btn btn-small" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread{inbox.data ? ` (${inbox.data.unread})` : ""}</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-small" disabled={!inbox.data || inbox.data.unread === 0} onClick={() => void act(markAllRead)}>Mark all read</button>
      </div>
      {inbox.data && inbox.data.categories.length > 1 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }} role="group" aria-label="Filter by source">
          <button className="btn btn-small" aria-pressed={category === null} onClick={() => setCategory(null)}>Everything</button>
          {inbox.data.categories.map((c) => (
            <button key={c.category} className="btn btn-small" aria-pressed={category === c.category} onClick={() => setCategory(c.category)}>
              {categoryLabel(c.category)}{c.unread > 0 ? ` · ${c.unread}` : ""}
            </button>
          ))}
        </div>
      )}

      {problem && <span className="dn" role="alert">{problem}</span>}
      {inbox.loading && <Skeleton lines={4} />}
      {inbox.error && <ErrorNotice error={inbox.error} onRetry={inbox.reload} />}
      {inbox.data && inbox.data.items.length === 0 && <Empty title={unreadOnly ? "Nothing unread" : "Nothing here"}>Warnings and to-dos will show up as they happen.</Empty>}
      {inbox.data && arrange(inbox.data.items).map((item) => (
        <div key={item.id} className="card" data-testid="inbox-item" data-read={item.read ? "true" : "false"}>
          <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
            <button
              onClick={() => void open(item)}
              style={{ all: "unset", cursor: "pointer", flex: 1, display: "block" }}
              aria-label={`${item.read ? "" : "Unread: "}${item.title}`}
            >
              <span style={{ fontWeight: item.read ? 400 : 700, display: "block" }}>
                {!item.read && <span aria-hidden="true" className={SEVERITY_TONE[item.severity] === "dim" ? "faint" : SEVERITY_TONE[item.severity]}>● </span>}
                {item.title}
              </span>
              {item.body && <span className="dim" style={{ display: "block", fontSize: 13, whiteSpace: "pre-wrap" }}>{item.body}</span>}
              <span className="faint" style={{ display: "block", fontSize: 12 }}>{categoryLabel(item.category)} · {itemTime(item)}</span>
            </button>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn btn-small" onClick={() => void act(() => (item.read ? markUnread(item.id) : markRead(item.id)))}>{item.read ? "Mark unread" : "Mark read"}</button>
              <button className="btn btn-small" aria-label={`Dismiss ${item.title}`} onClick={() => void act(() => dismissItem(item.id))}>×</button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

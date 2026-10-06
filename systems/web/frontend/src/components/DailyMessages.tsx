import { useState } from "react";
import { ApiError } from "../api/http";
import { getDeliveries, getNotifications, sendLatestNow, setNotification, type NotificationCategory } from "../api/notifications";
import { useResource } from "../hooks/useResource";
import { DEFAULT_TOP_N, STATUS_LABEL, deliveryProblem, deliveryTime, statusTone, topNOptions } from "../pages/notificationsModel";
import { ErrorNotice, Skeleton } from "./bits";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The Telegram messages a person can subscribe to: the pre-market bias, the strong OI buildup digest and, for the operator, token and
 * job problems. Every one starts off. Each goes to the person's own Telegram chat, once, and what was delivered (or why not) is listed
 * below, so "did it send?" is never a guess. */
export function DailyMessages() {
  const state = useResource(getNotifications, []);
  const history = useResource(() => getDeliveries(12), [], { pollMs: 60_000 });

  if (state.loading) return <Skeleton lines={4} />;
  if (state.error) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { chat_ready: chatReady, categories } = state.data;

  return (
    <>
      <h2 className="section-title">Daily messages</h2>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        Telegram messages on a schedule, sent to your own chat, once each. They are market context, not recommendations.
        {!chatReady && " Connect Telegram above to receive them."}
      </p>
      {categories.map((c) => (
        <CategoryCard key={c.key} category={c} chatReady={chatReady} onChanged={() => { state.reload(); history.reload(); }} />
      ))}

      <div className="card stack" data-testid="deliveries">
        <strong>Recent messages</strong>
        {history.data && history.data.length === 0 && <span className="dim" style={{ fontSize: 13 }}>Nothing sent yet.</span>}
        {history.data?.map((d, i) => {
          const problem = deliveryProblem(d);
          return (
            <div key={`${d.category}-${d.created_at}-${i}`} className="stack" data-testid="delivery">
              <div className="row" style={{ alignItems: "flex-start" }}>
                <span>
                  {d.label}
                  {d.manual && <span className="faint"> · sent on request</span>}
                  <span className="faint" style={{ display: "block", fontSize: 12 }}>{deliveryTime(d)} · {d.first_line}</span>
                </span>
                <span className={`pill ${statusTone(d.status)}`}>{STATUS_LABEL[d.status]}</span>
              </div>
              {problem && <span className="dn" style={{ fontSize: 13 }}>{problem}</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function CategoryCard({ category: c, chatReady, onChanged }: { category: NotificationCategory; chatReady: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const topN = c.params.top_n;

  async function save(enabled: boolean, params?: { top_n?: number }) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await setNotification(c.key, enabled, params);
      onChanged();
    } catch (e) {
      setError(message(e, "Could not save that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await sendLatestNow(c.key);
      setNote("Sent. Check Telegram.");
      onChanged();
    } catch (e) {
      setError(message(e, "Could not send it. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid={`daily-${c.key}`}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span>
          <strong>{c.label}</strong>
          {c.admin_only && <span className="pill" style={{ marginLeft: 8 }}>Operator</span>}
          <span className="faint" style={{ display: "block", fontSize: 12 }}>{c.schedule}</span>
        </span>
        <label className="check" htmlFor={`daily-${c.key}-on`} style={{ flex: "none" }}>
          <input id={`daily-${c.key}-on`} type="checkbox" checked={c.enabled} disabled={busy || (!chatReady && !c.enabled)} onChange={(e) => void save(e.target.checked, topN != null ? { top_n: topN } : undefined)} />
          <span>{c.enabled ? "On" : "Off"}</span>
        </label>
      </div>
      <span className="dim" style={{ fontSize: 13 }}>{c.description}</span>
      {topN != null && (
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <label htmlFor={`daily-${c.key}-n`} className="dim" style={{ fontSize: 13 }}>List the top</label>
          <select id={`daily-${c.key}-n`} value={topN} disabled={busy} onChange={(e) => void save(c.enabled, { top_n: Number(e.target.value) })} aria-label="How many per side">
            {topNOptions(topN).map((n) => (
              <option key={n} value={n}>{n}{n === DEFAULT_TOP_N ? " (default)" : ""}</option>
            ))}
          </select>
          <span className="dim" style={{ fontSize: 13 }}>on each side</span>
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <button className="btn btn-small" onClick={() => void sendNow()} disabled={busy || !chatReady}>
          {busy ? "Working…" : "Send me the latest now"}
        </button>
        {note && !error && <span className="up" role="status">{note}</span>}
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
    </div>
  );
}

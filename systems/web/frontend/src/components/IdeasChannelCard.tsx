import { useState } from "react";
import { ApiError } from "../api/http";
import { getIdeasConfig, sendTestIdea, setIdeasDestination } from "../api/ideas";
import { useResource } from "../hooks/useResource";
import { looksLikeDestination } from "../pages/ideasModel";
import { ErrorNotice, Skeleton } from "./bits";
import { TextField } from "./Field";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Where published ideas go: the ideas bot's status, the channel or group it posts to, and the disclaimer every idea ends with.
 * Admin only (the page renders it only for the operator). */
export function IdeasChannelCard() {
  const config = useResource(getIdeasConfig, []);
  const [chat, setChat] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmTest, setConfirmTest] = useState(false);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
      setNote(done);
      return true;
    } catch (e) {
      setError(message(e, "That did not work. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!looksLikeDestination(chat)) return setError("Use the channel's numeric id (a channel's starts with -100) or its @name.");
    if (await run(() => setIdeasDestination(chat.trim()), "Saved.")) {
      setChat("");
      setEditing(false);
      config.reload();
    }
  }

  async function test() {
    if (!confirmTest) {
      setConfirmTest(true);
      window.setTimeout(() => setConfirmTest(false), 5000);
      return;
    }
    setConfirmTest(false);
    await run(() => sendTestIdea(), "Test post sent to the channel.");
  }

  if (config.loading) return <Skeleton lines={2} />;
  if (config.error) return <ErrorNotice error={config.error} onRetry={config.reload} />;
  const c = config.data;
  if (!c) return null;

  return (
    <div className="card stack" data-testid="ideas-channel">
      <div className="row">
        <strong>Ideas channel</strong>
        <span className={c.bot_configured && c.destination_set ? "pill up" : "pill warn"}>{c.bot_configured && c.destination_set ? `Posting to ${c.destination_hint}` : "Not set up"}</span>
      </div>
      <span className="dim" style={{ fontSize: 13 }}>
        Publish a plan or observation note to a Telegram channel or group through a separate ideas bot. Only you see this.
      </span>
      {!c.bot_configured && (
        <div className="notice" role="status">
          The ideas bot is not set up on this server. Create a bot with BotFather, then put its token in <code>TELEGRAM_IDEAS_BOT_TOKEN</code>.
        </div>
      )}
      {(!c.destination_set || editing) && (
        <>
          <span className="dim" style={{ fontSize: 13 }}>Add the bot to your channel or group as an admin who can post, then enter the channel&apos;s id or @name.</span>
          <TextField id="ideas-chat" label="Channel id or @name" value={chat} onChange={(v) => { setChat(v); setError(null); }} inputMode="text" placeholder="-1001234567890" />
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn btn-primary btn-small" onClick={() => void save()} disabled={busy || !chat.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            {editing && (
              <button className="btn btn-small" onClick={() => { setEditing(false); setChat(""); setError(null); }}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {c.destination_set && !editing && (
        <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <button className="btn btn-small" onClick={() => void test()} disabled={busy || !c.bot_configured}>
            {confirmTest ? "This posts to the channel. Send?" : "Send a test post"}
          </button>
          <button className="btn btn-small" onClick={() => setEditing(true)} disabled={busy}>
            Change channel
          </button>
          <button className="btn btn-small" onClick={() => void run(() => setIdeasDestination(""), "Removed.").then((ok) => ok && config.reload())} disabled={busy}>
            Remove
          </button>
        </div>
      )}
      <details>
        <summary className="premarket-toggle">The disclaimer on every post</summary>
        <p className="dim" style={{ fontSize: 11, whiteSpace: "pre-wrap", marginBottom: 0 }} data-testid="ideas-disclaimer">{c.disclaimer}</p>
      </details>
      {note && !error && <span className="up" role="status">{note}</span>}
      {error && <div className="notice error" role="alert">{error}</div>}
    </div>
  );
}

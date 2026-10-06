import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/http";
import { previewIdea, publishIdea, snapshotDataUrl, unpublishIdea, type IdeaPreview, type PublishedIdea } from "../api/ideas";
import type { StudyNote } from "../api/types";
import { canPublish, deliveryNote, publishedLabel, toIdeaRequest } from "../pages/ideasModel";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Publish a plan or observation note as an idea to the operator's Telegram channel. It always shows exactly what will be posted,
 * disclaimer included, and asks for a second click before anything is sent; an idea that is out can be unpublished (the message
 * is deleted). Admin only: the page renders this only for the operator. */
export function PublishIdea({ note, state, onChanged }: { note: StudyNote; state: PublishedIdea | undefined; onChanged: (p: PublishedIdea) => void }) {
  const [open, setOpen] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [includeImage, setIncludeImage] = useState(false);
  const [preview, setPreview] = useState<IdeaPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDown, setConfirmDown] = useState(false);
  const [stuck, setStuck] = useState(false); // Telegram would not delete it: offer to mark it unpublished anyway
  const snapshot = useRef<string | null>(null);
  const label = publishedLabel(state);

  async function request() {
    if (includeImage && note.has_snapshot && !snapshot.current) snapshot.current = await snapshotDataUrl(note.id);
    return toIdeaRequest(note, { includeContext, snapshot: includeImage ? snapshot.current : null });
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview(null);
    setError(null);
    (async () => {
      try {
        const p = await previewIdea(await request());
        if (live) setPreview(p);
      } catch (e) {
        if (live) setError(message(e, "Could not build the preview."));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, includeContext, includeImage]);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      onChanged(await publishIdea(await request()));
      setOpen(false);
    } catch (e) {
      setError(message(e, "Could not publish. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function unpublish(force = false) {
    if (!confirmDown && !force) {
      setConfirmDown(true);
      window.setTimeout(() => setConfirmDown(false), 4000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChanged(await unpublishIdea(note.id, force));
      setStuck(false);
    } catch (e) {
      setError(message(e, "Could not unpublish. Try again."));
      setStuck(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
      setConfirmDown(false);
    }
  }

  if (label) {
    return (
      <div className="stack" data-testid="idea-published">
        <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <span className="pill up">{label}</span>
          {state?.destination_hint && <span className="faint">to {state.destination_hint}</span>}
          <button className="btn btn-small" onClick={() => void unpublish()} disabled={busy}>
            {confirmDown ? "Delete the post?" : "Unpublish"}
          </button>
          {stuck && (
            <button className="btn btn-small" onClick={() => void unpublish(true)} disabled={busy}>
              Mark as unpublished anyway
            </button>
          )}
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
      </div>
    );
  }

  if (!canPublish(note)) return null;

  if (!open) {
    return (
      <div className="stack">
        <button className="btn btn-small" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
          Publish idea
        </button>
        {error && <div className="notice error" role="alert">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card stack" data-testid="idea-preview">
      <strong>Publish this idea</strong>
      <label className="check" htmlFor={`ctx-${note.id}`}>
        <input id={`ctx-${note.id}`} type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} />
        <span>Include the market line (price, trend, PCR)</span>
      </label>
      {note.has_snapshot && (
        <label className="check" htmlFor={`img-${note.id}`}>
          <input id={`img-${note.id}`} type="checkbox" checked={includeImage} onChange={(e) => setIncludeImage(e.target.checked)} />
          <span>
            Include the chart image
            <span className="faint" style={{ display: "block", fontSize: 12 }}>The image can show lines you drew, including your own trades, so look at it first.</span>
          </span>
        </label>
      )}
      {!preview && !error && <span className="faint">Building the preview…</span>}
      {preview && (
        <>
          <div className="dim" style={{ fontSize: 12 }}>This is exactly what will be posted{preview.destination_hint ? ` to ${preview.destination_hint}` : ""}. {deliveryNote(preview.messages, preview.has_image)}</div>
          <pre className="idea-text" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 13 }}>{preview.text}</pre>
          {!preview.destination_hint && <div className="notice" role="status">No ideas channel is set. Set it at the top of this page first.</div>}
        </>
      )}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-primary btn-small" onClick={() => void publish()} disabled={busy || !preview || !preview.destination_hint}>
          {busy ? "Publishing…" : "Publish now"}
        </button>
        <button className="btn btn-small" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/http";
import { previewIdea, publishIdea, snapshotDataUrl, unpublishIdea, type IdeaPreview, type PublishedIdea } from "../api/ideas";
import type { StudyNote } from "../api/types";
import { canPublish, closedTradesFor, deliveryNote, publishedLabel, toIdeaRequest, type ClosedTrade } from "../pages/ideasModel";
import { groupsApi, positionsApi } from "../api/rupees";

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
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null); // the person's closed trades on this instrument; null until loaded
  const [tradesProblem, setTradesProblem] = useState<string | null>(null);
  const [tradeId, setTradeId] = useState("");
  const snapshot = useRef<string | null>(null);
  const label = publishedLabel(state);
  // A note saved after the clean picture existed has one (the chart with only a header); an older one has only the composed picture.
  const variant = note.has_clean_snapshot ? "clean" : "full";
  const attached = trades?.find((t) => t.id === tradeId) ?? null;

  async function request() {
    if (includeImage && note.has_snapshot && !snapshot.current) snapshot.current = await snapshotDataUrl(note.id, variant);
    return toIdeaRequest(note, { includeContext, snapshot: includeImage ? snapshot.current : null, trade: attached?.request ?? null });
  }

  // Closed trades are fetched once, when the panel is first opened.
  useEffect(() => {
    if (!open || trades !== null) return;
    let live = true;
    Promise.all([positionsApi("/positions?limit=200"), groupsApi("/option-groups?limit=200")])
      .then(([positions, groups]) => live && setTrades(closedTradesFor(note, positions, groups)))
      .catch(() => {
        if (live) {
          setTrades([]);
          setTradesProblem("Could not load your trades, so none can be attached right now.");
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  }, [open, includeContext, includeImage, tradeId]);

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
            <span className="faint" style={{ display: "block", fontSize: 12 }}>
              {note.has_clean_snapshot
                ? "The chart with a header only. It can still show lines you drew, including your own trades, so look at it first."
                : "This is the picture saved with the note: it also shows your note text and any AI read line, as well as lines you drew, including your own trades. Notes saved from now on keep a chart-only picture too."}
            </span>
          </span>
        </label>
      )}
      <div className="stack" data-testid="idea-trade">
        <label htmlFor={`trade-${note.id}`} className="dim" style={{ fontSize: 13 }}>
          Attach a closed trade (optional)
        </label>
        {trades === null && <span className="faint" style={{ fontSize: 12 }}>Loading your trades…</span>}
        {trades !== null && trades.length > 0 && (
          <select id={`trade-${note.id}`} value={tradeId} onChange={(e) => setTradeId(e.target.value)} aria-label="Attach a closed trade">
            <option value="">No trade</option>
            {trades.map((t) => (
              <option key={t.id} value={t.id}>
                {t.summary}
              </option>
            ))}
          </select>
        )}
        {trades !== null && trades.length === 0 && (
          <span className="faint" style={{ fontSize: 12 }}>{tradesProblem ?? `No closed trades on ${note.symbol} to attach.`}</span>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          Closed trades only. The post shows the levels and how it ended, as a multiple of the risk taken (R) or, for an option spread, a share of the premium paid, and
          says whether it was paper or live. It never shows quantity, lots, rupee amounts, charges or your balance.
        </span>
      </div>
      {!preview && !error && <span className="faint">Building the preview…</span>}
      {preview && (
        <>
          <div className="dim" style={{ fontSize: 12 }}>This is exactly what will be posted{preview.destination_hint ? ` to ${preview.destination_hint}` : ""}. {deliveryNote(preview.messages, preview.has_image)}</div>
          <pre className="idea-text" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 13 }}>
            {preview.disclaimer && preview.text.endsWith(preview.disclaimer) ? preview.text.slice(0, -preview.disclaimer.length) : preview.text}
            {preview.disclaimer && preview.text.endsWith(preview.disclaimer) && <small className="idea-disclaimer" style={{ fontSize: 10.5, opacity: 0.75 }}>{preview.disclaimer}</small>}
          </pre>
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

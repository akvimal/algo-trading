import { useEffect, useRef, useState } from "react";
import { addNote, deleteNote, fetchSnapshotUrl, listNotes } from "../api/notes";
import { ApiError } from "../api/http";
import type { AiRead, NoteContext, NoteTag, Segment, StudyNote } from "../api/types";
import type { ChartImage } from "../chart/ChartPane";
import { composeSnapshot, copyDataUrl, downloadDataUrl, snapshotFileName } from "../chart/snapshot";
import { formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { NOTE_MAX, NOTE_TAGS, contextChips, groupByDay } from "./notesModel";

type Props = {
  segment: Segment;
  /** The instrument as the person knows it (NIFTY, GOLDM, BTCUSD), which is what notes are filed under. */
  symbol: string;
  interval: string;
  /** The market as it is on screen right now. A function, so it is read at the moment a note is sent. */
  getContext: () => NoteContext;
  /** The chart as a PNG data URL, or the reason there is none to take. */
  getChartImage: () => ChartImage;
  /** The latest AI read for this instrument, if one has been run - its one-liner goes on the snapshot. */
  aiRead: AiRead | null;
};

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** The thoughts-and-plans panel under the chart: write what you are seeing and what you plan to do, tagged, with the
 * market's state stored beside it, and optionally a picture of the chart with the note on it. Private to the
 * person; a record for studying their own process, and for handing to an AI later. Not sent anywhere. */
export function NotesPanel({ segment, symbol, interval, getContext, getChartImage, aiRead }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [tag, setTag] = useState<NoteTag | null>(null);
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const notes = useResource(() => listNotes(segment, symbol), [segment, symbol], { enabled: open });
  const list = notes.data ?? [];
  const threadEnd = useRef<HTMLDivElement>(null);

  // A different instrument is a different thread (and a different half-written note).
  useEffect(() => {
    setDraft("");
    setTag(null);
    setStatus(null);
  }, [segment, symbol]);
  useEffect(() => {
    if (open) threadEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, list.length]);

  // Why the last attempt to take a picture failed, so the message says what to do rather than "not ready".
  const lastProblem = useRef("the chart is not ready");

  async function snapshot(): Promise<string | null> {
    const image = getChartImage();
    if ("problem" in image) {
      lastProblem.current = image.problem;
      return null;
    }
    const ctx = getContext();
    const composed = await composeSnapshot({
      chart: image.url,
      title: `${symbol} · ${interval.replace("min", "m")}`,
      subtitle: `${new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${ctx.price != null ? ` · ${formatPrice(ctx.price)}` : ""}`,
      note: draft,
      tag,
      aiLine: aiRead?.one_liner ?? null,
    });
    if (!composed) lastProblem.current = "this browser could not build the picture";
    return composed;
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      let png: string | null = null;
      if (attach) {
        png = await snapshot();
        if (!png) setStatus({ text: `The note was saved without a snapshot: ${lastProblem.current}.`, error: true });
      }
      await addNote({ segment, symbol, interval, text, tag, context: getContext(), ...(png ? { snapshot_png_base64: png } : {}) });
      setDraft("");
      setTag(null);
      notes.reload();
    } catch (e) {
      setStatus({ text: e instanceof ApiError ? e.message : "Could not save the note. Try again.", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function saveFile(action: "download" | "copy") {
    setStatus(null);
    const png = await snapshot();
    if (!png) {
      setStatus({ text: `No snapshot taken: ${lastProblem.current}.`, error: true });
      return;
    }
    if (action === "download") {
      downloadDataUrl(png, snapshotFileName(symbol, interval, new Date()));
      setStatus({ text: "Snapshot saved to your downloads.", error: false });
      return;
    }
    const result = await copyDataUrl(png);
    setStatus(
      result === "copied"
        ? { text: "Snapshot copied. Paste it into your chat.", error: false }
        : { text: result === "unsupported" ? "This browser cannot copy images. Use Download instead." : "Could not copy the snapshot. Use Download instead.", error: true },
    );
  }

  return (
    <div className="notes" data-testid="notes">
      <div className="notes-bar">
        <button className="chip-btn notes-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="notes-toggle">
          ✎ Notes{notes.data ? ` · ${notes.data.length}` : ""}
          <span aria-hidden="true"> {open ? "▴" : "▾"}</span>
        </button>
        {!open && <span className="faint">Your thoughts and plans on {symbol}, kept with the market's state at the time.</span>}
      </div>

      {open && (
        <div className="notes-body">
          <div className="notes-thread" role="log" aria-label={`Notes on ${symbol}`} data-testid="notes-thread">
            {notes.loading && <p className="faint">Loading…</p>}
            {notes.error && <p className="error-text">Could not load your notes. {notes.error.message}</p>}
            {!notes.loading && !notes.error && list.length === 0 && <p className="faint">No notes on {symbol} yet. Write what you see and what you plan to do.</p>}
            {groupByDay(list).map((g) => (
              <div key={g.label}>
                <div className="notes-day">{g.label}</div>
                {g.notes.map((n) => (
                  <NoteRow key={n.id} note={n} onDeleted={notes.reload} />
                ))}
              </div>
            ))}
            <div ref={threadEnd} />
          </div>

          <div className="notes-composer">
            <label className="sr-only" htmlFor="note-text">
              Note
            </label>
            <textarea
              id="note-text"
              className="notes-input"
              rows={3}
              maxLength={NOTE_MAX}
              placeholder="What are you seeing? What is the plan, and what would change it?"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="notes-actions">
              <div className="chips" role="group" aria-label="Note type">
                {NOTE_TAGS.map((t) => (
                  <button key={t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                    {t}
                  </button>
                ))}
              </div>
              <label className="check notes-attach">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach a snapshot of the chart
              </label>
              <span className="notes-spacer" />
              <button className="link-btn" onClick={() => void saveFile("download")} title="Save a picture of the chart with this note on it">
                Download snapshot
              </button>
              <button className="link-btn" onClick={() => void saveFile("copy")} title="Copy the picture to paste it into a chat">
                Copy snapshot
              </button>
              <button className="btn" disabled={busy || draft.trim() === ""} onClick={() => void send()} title="Ctrl+Enter">
                {busy ? "Saving…" : "Save note"}
              </button>
            </div>
            {status && (
              <p className={status.error ? "error-text" : "faint"} role={status.error ? "alert" : "status"} data-testid="notes-status">
                {status.text}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoteRow({ note, onDeleted }: { note: StudyNote; onDeleted: () => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const chips = contextChips(note.context);

  useEffect(() => () => (image ? URL.revokeObjectURL?.(image) : undefined), [image]);

  async function toggleImage() {
    if (image) {
      setImage(null);
      return;
    }
    setError(null);
    try {
      setImage(await fetchSnapshotUrl(note.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the snapshot.");
    }
  }

  async function remove() {
    if (!confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    try {
      await deleteNote(note.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete the note.");
      setConfirm(false);
    }
  }

  return (
    <div className="note" data-testid="note">
      <div className="note-head">
        <span className="faint">{hhmm(note.created_at)}</span>
        {note.tag && <span className="pill">{note.tag}</span>}
        {note.interval && <span className="faint">{note.interval.replace("min", "m")}</span>}
        <span className="notes-spacer" />
        {note.has_snapshot && (
          <button className="link-btn" aria-expanded={image != null} onClick={() => void toggleImage()}>
            {image ? "Hide snapshot" : "View snapshot"}
          </button>
        )}
        <button className="link-btn" aria-label={confirm ? "Confirm delete note" : "Delete note"} onClick={() => void remove()}>
          {confirm ? "Delete?" : "✕"}
        </button>
      </div>
      <p className="note-text">{note.text}</p>
      {chips.length > 0 && (
        <div className="note-chips" aria-label="Market when written">
          {chips.map((c, i) => (
            <span key={i} className="faint note-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {image && <img className="note-image" src={image} alt={`Chart snapshot with the note from ${hhmm(note.created_at)}`} />}
    </div>
  );
}

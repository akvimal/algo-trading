import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { addNote, listNotes } from "../api/notes";
import { ApiError } from "../api/http";
import type { AiRead, NoteContext, NoteTag, Segment } from "../api/types";
import type { ChartImage } from "../chart/ChartPane";
import { composeSnapshot, copyDataUrl, downloadDataUrl, snapshotFileName } from "../chart/snapshot";
import { CopyIcon, DownloadIcon, ListIcon } from "../chart/icons";
import { formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { NoteRow } from "./NoteRow";
import { NOTE_MAX, NOTE_TAGS, groupByDay } from "./notesModel";

/** How many of the latest notes on the instrument are shown under the chart. */
const RECENT = 3;

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
  // Only the latest few sit under the chart; the whole history, by instrument, is on its own page.
  const notes = useResource(() => listNotes({ segment, symbol, limit: RECENT }), [segment, symbol], { enabled: open });
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

  /** The picture kept with the note (chart, header, the words, the tag, the AI line) and a second, clean one (chart and header only) that a
   * published idea uses instead, because the first is flattened and its words and AI line cannot be taken off afterwards. */
  async function snapshot(withClean = true): Promise<{ full: string; clean: string | null } | null> {
    const image = getChartImage();
    if ("problem" in image) {
      lastProblem.current = image.problem;
      return null;
    }
    const ctx = getContext();
    const header = {
      chart: image.url,
      title: `${symbol} · ${interval.replace("min", "m")}`,
      subtitle: `${new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${ctx.price != null ? ` · ${formatPrice(ctx.price)}` : ""}`,
    };
    const full = await composeSnapshot({ ...header, note: draft, tag, aiLine: aiRead?.one_liner ?? null });
    if (!full) {
      lastProblem.current = "this browser could not build the picture";
      return null;
    }
    const clean = withClean ? await composeSnapshot({ ...header, note: "", tag: null, aiLine: null }) : null;
    return { full, clean };
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      let png: { full: string; clean: string | null } | null = null;
      if (attach) {
        png = await snapshot();
        if (!png) setStatus({ text: `The note was saved without a snapshot: ${lastProblem.current}.`, error: true });
      }
      await addNote({
        segment, symbol, interval, text, tag, context: getContext(),
        ...(png ? { snapshot_png_base64: png.full, ...(png.clean ? { clean_png_base64: png.clean } : {}) } : {}),
      });
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
    const png = (await snapshot(false))?.full ?? null; // a file for the person to keep or paste needs only the composed picture
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
          ✎ Notes
          <span aria-hidden="true"> {open ? "▴" : "▾"}</span>
        </button>
        {!open && <span className="faint">Your thoughts and plans on {symbol}, kept with the market's state at the time.</span>}
        <span className="notes-spacer" />
        <Link
          className="icon-link"
          to={`/more/notes?segment=${segment}&symbol=${encodeURIComponent(symbol)}`}
          aria-label={`All notes on ${symbol}`}
          title={`All notes on ${symbol}${open && list.length >= RECENT ? ` (the latest ${RECENT} are shown here)` : ""}`}
          data-testid="notes-history-link"
        >
          <ListIcon />
        </Link>
      </div>

      {open && (
        <div className="notes-body">
          <div className="notes-thread" role="log" aria-label={`Notes on ${symbol}`} data-testid="notes-thread">
            {notes.loading && <p className="faint">Loading…</p>}
            {notes.error && <p className="error-text">Could not load your notes. {notes.error.message}</p>}
            {groupByDay(list).map((g) => (
              <div key={g.label}>
                {g.label !== "Today" && <div className="notes-day">{g.label}</div>}
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
            <div className="chips notes-tags" role="group" aria-label="Note type">
              {NOTE_TAGS.map((t) => (
                <button key={t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                  {t}
                </button>
              ))}
            </div>
            <textarea
              id="note-text"
              className="notes-input"
              rows={2}
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
            <div className="notes-footer">
              <span className={`faint notes-count ${draft.length >= NOTE_MAX ? "at-limit" : ""}`} data-testid="notes-count" aria-live="off">
                {draft.length}/{NOTE_MAX}
              </span>
              <span className="notes-status-slot">
                {status && (
                  <span className={status.error ? "error-text" : "faint"} role={status.error ? "alert" : "status"} data-testid="notes-status">
                    {status.text}
                  </span>
                )}
              </span>
              <button className="icon-btn" aria-label="Download snapshot" onClick={() => void saveFile("download")} title="Download a picture of the chart with this note on it">
                <DownloadIcon />
              </button>
              <button className="icon-btn" aria-label="Copy snapshot" onClick={() => void saveFile("copy")} title="Copy the picture to paste it into a chat">
                <CopyIcon />
              </button>
              <label className="notes-attach" title="Keep a picture of the chart, with this note on it, with the note">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach snapshot
              </label>
              <button className="btn btn-small" aria-label="Save note" disabled={busy || draft.trim() === ""} onClick={() => void send()} title="Save note (Ctrl+Enter)">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { addNote, listNotes } from "../api/notes";
import { previewIdea, publishIdea, type IdeaPreview } from "../api/ideas";
import { useIsAdmin } from "../auth/AuthContext";
import { canAttachAnalysis, canPublish, publishableContext } from "../pages/ideasModel";
import { useIdeaAnalysis } from "../hooks/useIdeaAnalysis";
import { useAnalysisCard } from "../hooks/useAnalysisCard";
import { AttachAnalysis } from "./AttachAnalysis";
import { ApiError } from "../api/http";
import type { AiRead, NoteContext, NoteTag, Segment } from "../api/types";
import type { ChartImage } from "../chart/ChartPane";
import type { OiItem } from "../chart/oiStripModel";
import { composeSnapshot, copyDataUrl, downloadDataUrl, snapshotFileName } from "../chart/snapshot";
import { CopyIcon, DownloadIcon, ListIcon } from "../chart/icons";
import { formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { NoteRow } from "./NoteRow";
import { NoteTrade } from "./NoteTrade";
import { useNoteTrades } from "../hooks/useNoteTrades";
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
  /** The chart as a picture; with `withoutTrades` it has the person's own trade lines and markers hidden (for a picture that may be published). */
  getChartImage: (opts?: { withoutTrades?: boolean }) => ChartImage;
  /** The OI strip as it reads on screen (drawable items), when the chart has one; it is drawn on the snapshot. */
  getOiItems?: () => OiItem[] | null;
  /** The latest AI read for this instrument, if one has been run - its one-liner goes on the snapshot. */
  aiRead: AiRead | null;
};

/** The thoughts-and-plans panel under the chart: write what you are seeing and what you plan to do, tagged, with the
 * market's state stored beside it, and optionally a picture of the chart with the note on it. Private to the
 * person; a record for studying their own process, and for handing to an AI later. Not sent anywhere. */
export function NotesPanel({ segment, symbol, interval, getContext, getChartImage, getOiItems, aiRead }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [tag, setTag] = useState<NoteTag | null>(null);
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAdmin = useIsAdmin();
  const [publish, setPublish] = useState(false);
  const [preview, setPreview] = useState<IdeaPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const publishable = isAdmin && canPublish({ tag }) && draft.trim() !== "";
  // The AI analysis of the stock can go out with the idea (NSE stocks): it is read when the box is ticked and the preview waits for it.
  const [withAnalysis, setWithAnalysis] = useState(false);
  const analysis = useIdeaAnalysis(symbol, publish && publishable && withAnalysis && canAttachAnalysis({ segment }));
  // With the analysis the post's picture is a card: the live chart (chart and header only, never the person's own trade lines) under the verdict, both
  // reads and the price levels. What the preview shows is the picture that is posted.
  const card = useAnalysisCard({
    enabled: publish && publishable && withAnalysis && canAttachAnalysis({ segment }),
    analysis: analysis.analysis,
    title: `${symbol} · ${interval.replace("min", "m")}`,
    getChart: cleanChart,
  });
  const analysisPending = publish && withAnalysis && (!analysis.analysis || !card.settled);
  const ideaBody = (noteId: string, picture?: string | null) => ({
    note_id: noteId, segment, symbol, interval, tag: tag ?? "", text: draft.trim(), context: publishableContext(getContext()), include_context: true,
    ...((publish && withAnalysis && card.card ? card.card : picture) ? { snapshot_png_base64: (publish && withAnalysis && card.card ? card.card : picture) as string } : {}),
    ...(publish && withAnalysis && analysis.analysis ? { analysis: analysis.analysis } : {}),
  });
  // What would be posted, shown while the person writes (text only: the picture is taken when they save).
  useEffect(() => {
    if (!publish || !publishable || analysisPending) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      previewIdea(ideaBody("00000000-0000-4000-8000-000000000000"))
        .then((p) => live && (setPreview(p), setPreviewError(null)))
        .catch((e) => live && (setPreview(null), setPreviewError(e instanceof ApiError ? e.message : "Could not build the preview.")));
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, publishable, draft, tag, withAnalysis, analysis.analysis, card.card, card.settled]);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  // Only the latest few sit under the chart; the whole history, by instrument, is on its own page.
  const notes = useResource(() => listNotes({ segment, symbol, limit: RECENT }), [segment, symbol], { enabled: open });
  const list = notes.data ?? [];
  const trades = useNoteTrades(list);
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

  /** The chart with only its header (no note, no AI line, none of the person's own trade lines): what a published picture is built on. */
  async function cleanChart(): Promise<string | null> {
    const bare = getChartImage({ withoutTrades: true });
    if ("problem" in bare) return null;
    const ctx = getContext();
    return composeSnapshot({
      chart: bare.url,
      scale: bare.scale,
      title: `${symbol} · ${interval.replace("min", "m")}`,
      oiItems: getOiItems?.() ?? null,
      subtitle: `${new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${ctx.price != null ? ` · ${formatPrice(ctx.price)}` : ""}`,
      note: "",
      tag: null,
      aiLine: null,
    });
  }

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
      scale: image.scale,
      title: `${symbol} · ${interval.replace("min", "m")}`,
      oiItems: getOiItems?.() ?? null,
      subtitle: `${new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${ctx.price != null ? ` · ${formatPrice(ctx.price)}` : ""}`,
    };
    const full = await composeSnapshot({ ...header, note: draft, tag, aiLine: aiRead?.one_liner ?? null });
    if (!full) {
      lastProblem.current = "this browser could not build the picture";
      return null;
    }
    // The clean picture is the one that can be published, so it is taken with the person's own trade lines hidden: their open trades'
    // levels carry the entry and a profit figure in rupees, which a post must never show. It is a second capture of the same chart.
    let clean: string | null = null;
    if (withClean) {
      const bare = getChartImage({ withoutTrades: true });
      if (!("problem" in bare)) clean = await composeSnapshot({ ...header, chart: bare.url, scale: bare.scale, note: "", tag: null, aiLine: null });
    }
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
      const saved = await addNote({
        segment, symbol, interval, text, tag, context: getContext(),
        ...(png ? { snapshot_png_base64: png.full, ...(png.clean ? { clean_png_base64: png.clean } : {}) } : {}),
      });
      if (publish && publishable) {
        try {
          await publishIdea(ideaBody(saved.id, attach ? png?.clean : null));
          setStatus({ text: "Saved and published.", error: false });
        } catch (e) {
          setStatus({ text: `The note was saved, but publishing failed: ${e instanceof ApiError ? e.message : "try again from the Notes page"}.`, error: true });
        }
      }
      setPublish(false);
      setWithAnalysis(false);
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
                  <NoteRow key={n.id} note={n} onDeleted={notes.reload} extra={<NoteTrade note={n} trade={trades.byId[n.id]} onChanged={trades.reload} />} />
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
            {publishable && (
              <div className="stack" data-testid="notes-publish">
                <label className="check">
                  <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish as an idea when saving
                </label>
                {publish && canAttachAnalysis({ segment }) && (
                  <AttachAnalysis id="notes-analysis" symbol={symbol} checked={withAnalysis} onChange={setWithAnalysis} state={analysis} />
                )}
                {publish && withAnalysis && card.problem && <span className="faint" role="status">{card.problem}.</span>}
                {publish && withAnalysis && card.card && <img src={card.card} alt="The analysis card that will be posted" data-testid="analysis-card-preview" style={{ width: "100%", borderRadius: 8 }} />}
                {publish && previewError && <span className="error-text" role="alert">{previewError}</span>}
                {publish && preview && (
                  <>
                    <span className="dim" style={{ fontSize: 12 }}>
                      This is what will be posted{preview.destination_hint ? ` to ${preview.destination_hint}` : ""}
                      {attach ? ", with the chart-only picture (the OI line included, never your trade lines)" : ""}.
                    </span>
                    <pre className="idea-text" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 13 }}>{preview.text}</pre>
                    {!preview.destination_hint && <span className="error-text">No ideas channel is set, so this cannot be published yet.</span>}
                  </>
                )}
              </div>
            )}
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
              <button className="btn btn-small" aria-label="Save note" disabled={busy || draft.trim() === "" || analysisPending} onClick={() => void send()} title="Save note (Ctrl+Enter)">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

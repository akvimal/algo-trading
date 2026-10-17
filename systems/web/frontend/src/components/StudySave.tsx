import { useState } from "react";
import { addNote } from "../api/notes";
import { previewIdea, publishIdea, type IdeaPreview } from "../api/ideas";
import { ApiError } from "../api/http";
import { useIsAdmin } from "../auth/AuthContext";
import type { NoteContext, Segment } from "../api/types";
import type { ChartImage } from "../chart/ChartPane";
import type { OiItem } from "../chart/oiStripModel";
import { composeSnapshot } from "../chart/snapshot";
import { formatPrice } from "../format";
import { publishableContext } from "../pages/ideasModel";

type Props = {
  segment: Segment;
  symbol: string;
  interval: string;
  /** The study as words (market state, setup, the reason): what is saved as the note and posted as the idea. Empty while nothing is decided. */
  text: string;
  getContext: () => NoteContext;
  /** The chart as it is on screen, drawings and indicators included; with `withoutTrades` the person's own trade lines are left off. */
  getChartImage: (opts?: { withoutTrades?: boolean }) => ChartImage;
  /** The OI strip as a list of drawable items, or null when this instrument has no OI read. */
  getOiItems: () => OiItem[] | null;
};

const failure = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Save the study with a picture of the chart (the person's drawings and, when there is one, the OI read), and for the operator publish it as an idea.
 * Saving keeps it as a private "plan" note on the instrument. Publishing is a second, deliberate step: it shows exactly what will be posted
 * (with the chart-only picture, never the person's trade lines) and asks again before anything leaves. */
export function StudySave({ segment, symbol, interval, text, getContext, getChartImage, getOiItems }: Props) {
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState<IdeaPreview | null>(null);
  const ready = text.trim() !== "";

  /** The picture kept with the note (chart, header, the study in words, the OI read) and a clean one (chart, header, OI) that a post uses instead. */
  async function pictures(): Promise<{ full: string; clean: string } | { problem: string }> {
    const image = getChartImage();
    if ("problem" in image) return { problem: image.problem };
    const bare = getChartImage({ withoutTrades: true });
    if ("problem" in bare) return { problem: bare.problem };
    const ctx = getContext();
    const header = {
      scale: image.scale,
      title: `${symbol} · ${interval.replace("min", "m")}`,
      oiItems: getOiItems(),
      subtitle: `${new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${ctx.price != null ? ` · ${formatPrice(ctx.price)}` : ""}`,
    };
    const full = await composeSnapshot({ ...header, chart: image.url, note: text, tag: "plan", aiLine: null });
    const clean = await composeSnapshot({ ...header, chart: bare.url, scale: bare.scale, note: "", tag: null, aiLine: null });
    return full && clean ? { full, clean } : { problem: "this browser could not build the picture" };
  }

  const ideaBody = (noteId: string, picture: string | null) => ({
    note_id: noteId, segment, symbol, interval, tag: "plan", text: text.trim(), context: publishableContext(getContext()), include_context: true,
    ...(picture ? { snapshot_png_base64: picture } : {}),
  });

  async function save(publish: boolean) {
    if (!ready || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const pics = await pictures();
      const noPicture = "problem" in pics ? pics.problem : null;
      const saved = await addNote({
        segment, symbol, interval, text: text.trim(), tag: "plan", context: getContext(),
        ...(!noPicture && "full" in pics ? { snapshot_png_base64: pics.full, clean_png_base64: pics.clean } : {}),
      });
      if (!publish) {
        setStatus({ text: noPicture ? `Study saved, without a chart: ${noPicture}.` : "Study saved with the chart.", error: Boolean(noPicture) });
        return;
      }
      try {
        await publishIdea(ideaBody(saved.id, !noPicture && "clean" in pics ? pics.clean : null));
        setStatus({ text: noPicture ? `Study saved and published, without a chart: ${noPicture}.` : "Study saved and published with the chart.", error: Boolean(noPicture) });
        setPreview(null);
      } catch (e) {
        setStatus({ text: `The study was saved, but publishing failed: ${failure(e, "try again from the Notes page")}.`, error: true });
      }
    } catch (e) {
      setStatus({ text: failure(e, "Could not save the study. Try again."), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    setStatus(null);
    try {
      setPreview(await previewIdea(ideaBody("00000000-0000-4000-8000-000000000000", null)));
    } catch (e) {
      setPreview(null);
      setStatus({ text: failure(e, "Could not build the preview."), error: true });
    }
  }

  return (
    <div className="study-save" data-testid="study-save">
      <div className="row" style={{ gap: 8, justifyContent: "flex-start", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-small" disabled={!ready || busy} onClick={() => void save(false)} title="Keep this study as a note, with a picture of the chart: your drawings and the OI read">
          {busy && !preview ? "Saving…" : "Save study"}
        </button>
        {isAdmin && (
          <button type="button" className="btn btn-small" disabled={!ready || busy} aria-expanded={preview != null} onClick={() => (preview ? setPreview(null) : void review())} title="Save it and post it as an idea, with the chart">
            Publish…
          </button>
        )}
      </div>
      {preview && (
        <div className="stack" data-testid="study-publish" style={{ marginTop: 8 }}>
          <span className="dim" style={{ fontSize: 12 }}>
            This is what will be posted{preview.destination_hint ? ` to ${preview.destination_hint}` : ""}, with the chart-only picture (your drawings and the OI read, never your trade lines).
          </span>
          <pre className="idea-text" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 13 }}>{preview.text}</pre>
          {!preview.destination_hint && <span className="error-text">No ideas channel is set, so this cannot be published yet.</span>}
          <div className="row" style={{ gap: 8, justifyContent: "flex-start" }}>
            <button type="button" className="btn btn-small" disabled={busy || !preview.destination_hint} onClick={() => void save(true)}>
              {busy ? "Posting…" : "Save and post"}
            </button>
            <button type="button" className="link-btn" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {status && (
        <p className={status.error ? "error-text" : "faint"} role={status.error ? "alert" : "status"} data-testid="study-save-status" style={{ fontSize: 12, margin: "6px 0 0" }}>
          {status.text}
        </p>
      )}
    </div>
  );
}

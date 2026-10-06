import type { IdeaRequest, PublishedIdea } from "../api/ideas";
import type { NoteContext, StudyNote } from "../api/types";
import { formatDay, formatTime } from "../format";

/** Only these types of note can be published; "mistake" and "review" notes stay private. The server enforces the same rule. */
export const PUBLISHABLE_TAGS = ["plan", "observation"] as const;

export const canPublish = (note: Pick<StudyNote, "tag">): boolean => note.tag != null && (PUBLISHABLE_TAGS as readonly string[]).includes(note.tag);

/** The parts of a note's market context that may be sent. The position held and the AI read never leave the browser (the server
 * would ignore them anyway; this keeps them off the wire too). */
export function publishableContext(ctx: NoteContext | null): Record<string, unknown> | null {
  if (!ctx) return null;
  const out: Record<string, unknown> = { price: ctx.price, interval: ctx.interval };
  if (ctx.regime) out.regime = { regime: ctx.regime.regime, adx: ctx.regime.adx };
  if (ctx.structure_trend) out.structure_trend = ctx.structure_trend;
  if (ctx.oi?.pcr != null) out.oi = { pcr: ctx.oi.pcr };
  return out;
}

export function toIdeaRequest(note: StudyNote, opts: { includeContext: boolean; snapshot?: string | null }): IdeaRequest {
  return {
    note_id: note.id,
    segment: note.segment,
    symbol: note.symbol,
    interval: note.interval,
    tag: note.tag ?? "",
    text: note.text,
    context: publishableContext(note.context),
    include_context: opts.includeContext,
    ...(opts.snapshot ? { snapshot_png_base64: opts.snapshot } : {}),
  };
}

/** "Published 6 Oct at 11:30", or null when it is not (or no longer) published. */
export function publishedLabel(p: PublishedIdea | undefined): string | null {
  if (!p || !p.published || !p.published_at) return null;
  return `Published ${formatDay(p.published_at)} at ${formatTime(p.published_at)}`;
}

/** How a preview will go out, in words. */
export function deliveryNote(messages: number, hasImage: boolean): string {
  if (!hasImage) return "Sent as one message.";
  return messages === 1 ? "Sent as one photo with this text as its caption." : "Sent as the chart image followed by this text.";
}

/** Accepts a numeric id (a channel's starts with -100) or a public channel's @name, like the server. */
export const looksLikeDestination = (raw: string): boolean => /^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(raw.trim());

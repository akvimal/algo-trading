import type { IdeaAnalysis, IdeaRequest, PublishedIdea, TradeRequest } from "../api/ideas";
import type { StockAnalysis } from "../api/analysis";
import { leanStrength } from "../components/analysisModel";
import type { NoteContext, OptionGroup, Position, StudyNote } from "../api/types";
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

/** The AI analysis is for an NSE stock (the weekly and daily history it reads is NSE's), so it is only offered for those. */
export const canAttachAnalysis = (note: { segment: string }): boolean => note.segment === "NSE";

/** The short form of an analysis that goes into a post: the verdict, the chart's and the business's lean, their first reasons, and the nearest
 * level either side. The rest of the analysis stays on the Scan card. */
export function toIdeaAnalysis(a: StockAnalysis): IdeaAnalysis {
  const f = a.fundamental;
  const business = f.available && f.bias != null;
  const lv = (l: { low: number; high: number; distance_pct: number } | undefined) => (l ? { low: l.low, high: l.high, distance_pct: l.distance_pct } : null);
  return {
    verdict: a.verdict.headline,
    agreement: a.verdict.agreement,
    overall: a.verdict.bias,
    overall_strength: a.verdict.confidence > 0 ? leanStrength(a.verdict.confidence) : null,
    chart_bias: a.technical.bias,
    chart_points: a.technical.points.slice(0, 4),
    price: a.price,
    as_of: a.as_of,
    business_bias: business ? f.bias : null,
    business_confidence: business ? f.confidence : null,
    business_summary: business ? f.summary : null,
    pros: business ? f.pros.slice(0, 2) : [],
    cons: business ? f.cons.slice(0, 2) : [],
    support: lv(a.technical.support[0]),
    resistance: lv(a.technical.resistance[0]),
  };
}

export function toIdeaRequest(note: StudyNote, opts: { includeContext: boolean; snapshot?: string | null; trade?: TradeRequest | null; analysis?: IdeaAnalysis | null }): IdeaRequest {
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
    ...(opts.trade ? { trade: opts.trade } : {}),
    ...(opts.analysis ? { analysis: opts.analysis } : {}),
  };
}

// ---- Attaching a closed trade -----------------------------------------------------------------------------------------------------

export type ClosedTrade = {
  /** A position's or a spread's id. */
  id: string;
  kind: "position" | "group";
  closedAt: string;
  /** One line for the picker: what it was, when it closed and how. No amounts. */
  summary: string;
  request: TradeRequest;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** A position is on this instrument when its symbol is the instrument or one of its contracts ("NIFTY-Oct2026-FUT", "NIFTY 23200 CE"), so
 * "NIFTY" never pulls in "NIFTYBEES" or "NIFTYIT". */
export const onInstrument = (positionSymbol: string, instrument: string): boolean => {
  const p = norm(positionSymbol);
  const i = norm(instrument);
  return p === i || p.startsWith(`${i}-`) || p.startsWith(`${i} `);
};

/** A stop that was moved after entry (a trailing or indicator stop) is not the risk the trade was planned with, and a stop on the wrong side
 * of the entry is one that has trailed into profit; either would make "R" meaningless, so such a stop is left out and the result is a
 * percentage move instead. */
export function usableStop(p: Pick<Position, "action" | "entry_price" | "stop_loss_price" | "trailing_stop_enabled" | "stop_loss_method">): number | null {
  const stop = p.stop_loss_price;
  if (stop == null || p.trailing_stop_enabled || p.stop_loss_method) return null;
  const onTheRightSide = p.action === "BUY" ? stop < p.entry_price : stop > p.entry_price;
  return onTheRightSide ? stop : null;
}

function spreadName(g: Pick<OptionGroup, "underlying_symbol" | "strategy_type">): string {
  return `${g.underlying_symbol} ${g.strategy_type.replace(/_/g, " ")}`;
}

const REASON_WORDS: Record<string, string> = { target: "hit target", target_hit: "hit target", stop_loss: "stopped out", stop_loss_hit: "stopped out", trailing_stop: "trailed out", square_off: "squared off", counter_signal: "counter signal", manual: "closed by hand" };

const day = (iso: string) => formatDay(iso);

/** The person's CLOSED trades on this note's instrument, newest first: single positions (spot, futures, one option), and option spreads that
 * were bought for a debit. Open trades are not offered (an open trade's levels read as a live call), and a spread bought for a credit is
 * not either, since its result as a share of premium paid is undefined. A trade with no way to say how it ended is left out. */
export function closedTradesFor(note: Pick<StudyNote, "segment" | "symbol">, positions: Position[], groups: OptionGroup[], limit = 15): ClosedTrade[] {
  const sym = norm(note.symbol);
  const out: ClosedTrade[] = [];
  for (const p of positions) {
    if (p.status !== "CLOSED" || p.exit_price == null || !p.exit_time || p.option_group_id) continue;
    if (p.segment !== note.segment || !onInstrument(p.symbol, note.symbol)) continue;
    const reason = p.exit_reason ? REASON_WORDS[p.exit_reason.toLowerCase()] : undefined;
    out.push({
      id: p.id, kind: "position", closedAt: p.exit_time,
      summary: `${p.action} ${p.symbol} · closed ${day(p.exit_time)}${reason ? ` · ${reason}` : ""}${p.is_live_broker_order ? " · live" : " · paper"}`,
      request: {
        kind: "position", label: p.symbol, side: p.action, live: Boolean(p.is_live_broker_order), entry: p.entry_price, stop: usableStop(p), target: p.target_price,
        exit: p.exit_price, exit_reason: p.exit_reason ?? null, result_pct: null,
      },
    });
  }
  for (const g of groups) {
    if (g.status !== "CLOSED" || !g.exit_time || g.pnl == null || g.net_debit == null || g.net_debit <= 0 || !g.quantity) continue;
    if ((g.segment ?? "NSE") !== note.segment || norm(g.underlying_symbol) !== sym) continue;
    const live = positions.some((p) => p.option_group_id === g.id && p.is_live_broker_order);
    const reason = g.exit_reason ? REASON_WORDS[g.exit_reason.toLowerCase()] : undefined;
    const trailed = Boolean(g.spot_stop_loss_trailing_enabled || g.spot_stop_loss_indicator_type);
    out.push({
      id: g.id, kind: "group", closedAt: g.exit_time,
      summary: `${g.action} ${spreadName(g)} · closed ${day(g.exit_time)}${reason ? ` · ${reason}` : ""}${live ? " · live" : " · paper"}`,
      request: {
        kind: "group", label: spreadName(g), side: g.action, live, entry: g.entry_spot_price ?? null, stop: trailed ? null : g.spot_stop_loss_price, target: g.spot_target_price,
        exit: null, exit_reason: g.exit_reason ?? null,
        // pnl over the premium paid (per unit, times the quantity), so neither the quantity nor the rupee amount leaves this function
        result_pct: (g.pnl / (g.net_debit * g.quantity)) * 100,
      },
    });
  }
  return out.sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, limit);
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

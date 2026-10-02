import type { AiRead, MarketRegime, NoteContext, OiSummary, StudyNote } from "../api/types";
import { formatPrice } from "../format";
import { volumePcr } from "../chart/oiStripModel";

export const NOTE_TAGS = ["plan", "observation", "mistake", "review"] as const;
export const NOTE_MAX = 4000;

/** The market as it is on screen right now, in the shape stored with a note. Only what is actually available is
 * included (no option chain, no AI read yet, ... simply leave those parts out). */
export function buildNoteContext(input: {
  price: number | null;
  interval: string;
  regime: MarketRegime | null;
  structure: Record<string, string>;
  oi: OiSummary | null;
  aiRead: AiRead | null;
  holding: string | null;
}): NoteContext {
  const { price, interval, regime, structure, oi, aiRead, holding } = input;
  const ctx: NoteContext = { price, interval };
  if (regime) ctx.regime = { regime: regime.regime, adx: regime.adx, atr_percentile: regime.atr_percentile };
  if (Object.keys(structure).length > 0) ctx.structure_trend = structure;
  if (oi) {
    ctx.oi = {
      expiry: oi.expiry,
      pcr: oi.pcr,
      vol_pcr: volumePcr(oi.strikes),
      call_oi_change_5m: oi.total_call_oi_change_5m,
      put_oi_change_5m: oi.total_put_oi_change_5m,
      call_buildup: oi.total_call_buildup,
      put_buildup: oi.total_put_buildup,
    };
  }
  if (aiRead) ctx.ai_read = { bias: aiRead.bias, confidence: aiRead.confidence, one_liner: aiRead.one_liner, generated_at: aiRead.generated_at };
  if (holding) ctx.holding = holding;
  return ctx;
}

const REGIME_WORD: Record<string, string> = { trending_up: "Trending up", trending_down: "Trending down", ranging: "Ranging", transitional: "Changing" };

/** A short line of chips saying what the market looked like when a note was written. */
export function contextChips(ctx: NoteContext | null): string[] {
  if (!ctx) return [];
  const chips: string[] = [];
  if (ctx.price != null) chips.push(formatPrice(ctx.price));
  if (ctx.regime) chips.push(`${REGIME_WORD[ctx.regime.regime] ?? ctx.regime.regime} · ADX ${ctx.regime.adx.toFixed(0)}`);
  for (const [tf, t] of Object.entries(ctx.structure_trend ?? {})) chips.push(`${tf} ${t === "range" ? "sideways" : t}`);
  if (ctx.oi?.pcr != null) chips.push(`PCR ${ctx.oi.pcr.toFixed(2)}`);
  if (ctx.ai_read) chips.push(`AI: ${ctx.ai_read.bias} ${ctx.ai_read.confidence}%`);
  if (ctx.holding) chips.push(`holding ${ctx.holding}`);
  return chips;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Notes grouped under day headings ("Today", "Yesterday", "28 Sep 2026"), oldest day first, notes within a day
 * oldest first - a conversation that reads top to bottom. */
export function groupByDay(notes: StudyNote[], now: Date = new Date()): { label: string; notes: StudyNote[] }[] {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const groups = new Map<string, { label: string; notes: StudyNote[] }>();
  for (const n of notes) {
    const when = n.created_at ? new Date(n.created_at) : now;
    const key = dayKey(when);
    if (!groups.has(key)) {
      const label = key === dayKey(now) ? "Today" : key === dayKey(yesterday) ? "Yesterday" : when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      groups.set(key, { label, notes: [] });
    }
    groups.get(key)!.notes.push(n);
  }
  return [...groups.values()];
}

import type { Buildup, OiSummary, SentimentHistoryPoint } from "../api/types";

// The OI strip: a compact read of the option chain, always shown under the chart of an OI-eligible
// instrument (unlike the OI *levels* drawn on the chart itself, which are opt-in — see chart/oiLevels.ts).
// Plain data and no chart library, so it can be tested without a screen.

/** Put volume / call volume — today's actual trading, the flow-based sibling of the OI-based `pcr`
 * (a standing position that can sit unchanged for days). Null when there is no call volume to divide by. */
export function volumePcr(strikes: OiSummary["strikes"]): number | null {
  let callVolume = 0;
  let putVolume = 0;
  for (const s of strikes) {
    callVolume += s.call?.volume ?? 0;
    putVolume += s.put?.volume ?? 0;
  }
  return callVolume > 0 ? putVolume / callVolume : null;
}

export function classifyPcr(pcr: number | null): "bullish" | "bearish" | "neutral" | null {
  if (pcr == null) return null;
  if (pcr >= 1.15) return "bullish";
  if (pcr <= 0.85) return "bearish";
  return "neutral";
}

/** Whether the OI-based PCR and the volume-based one read different buckets — today's flow may be
 * shifting sentiment before it shows up in the standing OI, or vice versa. */
export const pcrDiverges = (oiPcr: number | null, volPcr: number | null): boolean => {
  const a = classifyPcr(oiPcr);
  const b = classifyPcr(volPcr);
  return a != null && b != null && a !== b;
};

/** How lopsided this 5-minute window's OI flow is between calls and puts, in percentage points of each
 * side's own total — e.g. call OI +0.6% and put OI +1.5% nets to "+0.9pp PE-led". Null when either side
 * has no change reading yet, or the total is zero. */
export function flowSkew(callOiChange5m: number | null, callOiTotal: number, putOiChange5m: number | null, putOiTotal: number): { pct: number; leader: "CE" | "PE" } | null {
  if (callOiChange5m == null || putOiChange5m == null || callOiTotal <= 0 || putOiTotal <= 0) return null;
  const gap = (putOiChange5m / putOiTotal) * 100 - (callOiChange5m / callOiTotal) * 100;
  if (gap === 0) return null;
  return { pct: Math.abs(gap), leader: gap > 0 ? "PE" : "CE" };
}

/** A gap this wide fills the whole skew bar; anything beyond just stays full. */
export const SKEW_BAR_FULL_PP = 5;

/** How the flow-skew reads on the strip: which side is leading, how much of the bar to fill (0-1), and a
 * tone following the same convention as the PCR — put-led reads bullish (put writers adding support),
 * call-led bearish (call writers adding resistance). That is only the usual reading: OI alone can't say
 * whether the leading side is being written or bought, which the tooltip says. */
export function skewView(skew: { pct: number; leader: "CE" | "PE" }): { leader: "CE" | "PE"; fill: number; tone: "up" | "dn" } {
  return { leader: skew.leader, fill: Math.min(1, skew.pct / SKEW_BAR_FULL_PP), tone: skew.leader === "PE" ? "up" : "dn" };
}

/** Short form for the strip's pills (the full wording stays in each pill's tooltip). */
export const BUILDUP_ABBR: Record<Buildup, string> = { long_buildup: "LB", short_buildup: "SB", short_covering: "SC", long_unwinding: "LU" };
export const BUILDUP_ICON: Record<Buildup, string> = { long_buildup: "▲", short_buildup: "▼", short_covering: "△", long_unwinding: "▽" };
export const BUILDUP_LABEL: Record<Buildup, string> = {
  long_buildup: "Long Buildup — price up, OI up (fresh longs)", short_buildup: "Short Buildup — price down, OI up (fresh shorts)",
  short_covering: "Short Covering — price up, OI down (shorts exiting)", long_unwinding: "Long Unwinding — price down, OI down (longs exiting)",
};
/** Green for bullish buildup states, red for bearish, matching --up/--dn — CE and PE read the same
 * 4 states oppositely: being long a put is bearish, being long a call is bullish. */
export function buildupTone(b: Buildup, side: "CE" | "PE"): "up" | "dn" {
  const bullish = b === "long_buildup" || b === "short_covering";
  return bullish === (side === "CE") ? "up" : "dn";
}

/** A signed change as a share of the total, e.g. { pct: 0.8, up: true } for a rising figure. Null input
 * (no reading yet) or a non-positive total gives null: nothing to show. */
export function deltaPct(change: number | null, total: number): { pct: number; up: boolean } | null {
  if (change == null || total <= 0) return null;
  const pct = (change / total) * 100;
  return { pct: Math.abs(pct), up: pct > 0 };
}

// ---- the "OI trend" sparkline: today's sentiment_history score, bucketed to clean 5m/15m slots ----

export type SentStep = { barTime: number; score: number; major: boolean; recordedAt: string };

const SPARK_BARS = 10;

/** sentiment_history is written every 5 minutes on whatever offset the scheduler happens to fire at, so
 * raw timestamps never land on a clean boundary. Each reading is snapped down to the clock-aligned slot
 * it falls in (a multiple of the window), keeping at most the latest reading per slot — this also merges
 * away the old "15m re-measured every 5 min" overlap, since only one reading per 15-minute slot survives.
 * Returns the most recent `SPARK_BARS` slots, oldest first, each flagged `major` when the score crossed
 * zero (positioning flipped side) or jumped further than twice the window's own typical step. */
export function sentimentSteps(points: SentimentHistoryPoint[], window: "5m" | "15m"): SentStep[] {
  const intervalMs = (window === "15m" ? 15 : 5) * 60_000;
  const scoreOf = (p: SentimentHistoryPoint) => (window === "15m" ? p.score_15m : p.score_5m);
  const slots = new Map<number, SentimentHistoryPoint>();
  for (const p of points) {
    const score = scoreOf(p);
    if (score == null) continue;
    const slot = Math.floor(Date.parse(p.recorded_at) / intervalMs) * intervalMs;
    const existing = slots.get(slot);
    if (!existing || Date.parse(p.recorded_at) > Date.parse(existing.recorded_at)) slots.set(slot, p);
  }
  const scored = [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-SPARK_BARS)
    .map(([slot, p]) => ({ barTime: slot, score: scoreOf(p) as number, recordedAt: p.recorded_at }));
  const deltas = scored.slice(1).map((s, i) => Math.abs(s.score - scored[i].score));
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return scored.map((s, i) => {
    if (i === 0) return { ...s, major: false };
    const prev = scored[i - 1].score;
    const flipped = Math.sign(s.score) !== Math.sign(prev) && Math.abs(s.score) > 0.05 && Math.abs(prev) > 0.05;
    const big = Math.abs(s.score - prev) >= Math.max(0.15, 2 * median);
    return { ...s, major: flipped || big };
  });
}

/** Whether the strip's "OI trend" sparklines have anything to draw at all (either window). */
export const hasSentimentTrend = (points: SentimentHistoryPoint[]) => sentimentSteps(points, "5m").length >= 2 || sentimentSteps(points, "15m").length >= 2;

/** More than 2 recording cycles (5-minute) behind: the reading is stale. */
export const isStaleAt = (recordedAt: string, now: number = Date.now()) => now - Date.parse(recordedAt) > 12 * 60_000;

/** Indices report OI in crores; a crypto perpetual's open interest is a plain contract count. */
export const fmtOi = (n: number, crypto: boolean) => (crypto ? Math.round(n).toLocaleString("en-US") : compactIndian(n));
function compactIndian(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// ---- the strip as items a picture can draw (the picture has no page to copy, so it draws the same reading itself) ----

export type OiTone = "up" | "dn" | "warn" | "dim";
export type OiItem =
  | { t: "text"; text: string; tone?: OiTone; bold?: boolean; attach?: boolean }
  | { t: "pill"; text: string; tone: OiTone }
  | { t: "spark"; window: "5m" | "15m"; bars: { h: number; tone: "up" | "dn" | "flat"; major: boolean }[]; value: string; tone: OiTone; flag: string | null }
  | { t: "skew"; fill: number; leader: "CE" | "PE"; tone: "up" | "dn"; label: string };

/** The OI strip as drawable items, in the strip's own order and with its own wording: PCR and volume PCR, CE/PE OI with their 15m/5m change,
 * resistance and support (unless the chart already draws them), buildup pills, the flow-skew bar and the OI-trend sparklines. Null when
 * there is no option-chain reading. `levels` are the strip's support/resistance lines (price and kind, with the shown ones already solid). */
export function oiStripItems(
  s: OiSummary | null,
  sentiment: SentimentHistoryPoint[],
  levels: { kind: "resistance" | "support"; rank: number; forming: boolean; price: number }[],
  onChartLevelsOn: boolean,
  fmtPrice: (n: number) => string,
): OiItem[] | null {
  if (!s) return null;
  const crypto = s.underlying_exchange === "CRYPTO";
  const items: OiItem[] = [];
  const kv = (label: string, value: string, tone?: OiTone) => {
    items.push({ t: "text", text: label, tone: "dim" });
    items.push({ t: "text", text: value, bold: true, tone, attach: true });
  };
  const vp = volumePcr(s.strikes);
  kv("PCR", s.pcr != null ? s.pcr.toFixed(2) : "–");
  kv(pcrDiverges(s.pcr, vp) ? "Vol PCR ⇄" : "Vol PCR", vp != null ? vp.toFixed(2) : "–", pcrDiverges(s.pcr, vp) ? "warn" : undefined);
  const chg = (c: number | null, t: number): OiItem => {
    const d = deltaPct(c, t);
    return d ? { t: "text", text: `${d.up ? "▲" : "▼"}${d.pct.toFixed(1)}%`, tone: d.up ? "up" : "dn", attach: true } : { t: "text", text: "–", tone: "dim", attach: true };
  };
  const side = (name: string, total: number, c15: number | null, c5: number | null) => {
    items.push({ t: "text", text: `${name} OI ${fmtOi(total, crypto)}` });
    items.push(chg(c15, total), { t: "text", text: "/15m", tone: "dim", attach: true }, chg(c5, total), { t: "text", text: "/5m", tone: "dim", attach: true });
  };
  side("CE", s.total_call_oi, s.total_call_oi_change_15m, s.total_call_oi_change_5m);
  side("PE", s.total_put_oi, s.total_put_oi_change_15m, s.total_put_oi_change_5m);
  const solid = onChartLevelsOn ? [] : levels.filter((l) => !l.forming);
  for (const [tag, kind] of [["R", "resistance"], ["S", "support"]] as const) {
    const ls = solid.filter((l) => l.kind === kind).sort((a, b) => a.rank - b.rank);
    if (ls.length) kv(tag, ls.map((l) => fmtPrice(l.price)).join(" · "));
  }
  if (s.total_call_buildup) items.push({ t: "pill", text: `${BUILDUP_ICON[s.total_call_buildup]} CE ${BUILDUP_ABBR[s.total_call_buildup]}`, tone: buildupTone(s.total_call_buildup, "CE") });
  if (s.total_put_buildup) items.push({ t: "pill", text: `${BUILDUP_ICON[s.total_put_buildup]} PE ${BUILDUP_ABBR[s.total_put_buildup]}`, tone: buildupTone(s.total_put_buildup, "PE") });
  const k = flowSkew(s.total_call_oi_change_5m, s.total_call_oi, s.total_put_oi_change_5m, s.total_put_oi);
  if (k) {
    const v = skewView(k);
    items.push({ t: "skew", fill: v.fill, leader: v.leader, tone: v.tone, label: `${v.leader} +${k.pct.toFixed(1)}%` });
  }
  if (hasSentimentTrend(sentiment)) items.push({ t: "text", text: "OI trend", tone: "dim" });
  for (const window of ["15m", "5m"] as const) {
    const steps = sentimentSteps(sentiment, window);
    if (steps.length < 2) continue;
    const maxAbs = Math.max(0.2, ...steps.map((x) => Math.abs(x.score)));
    const last = steps[steps.length - 1];
    const prev = steps[steps.length - 2];
    const tone = (x: number) => (x > 0.02 ? "up" : x < -0.02 ? "dn" : "flat");
    items.push({
      t: "spark",
      window,
      bars: steps.map((x) => ({ h: Math.max(0.08, Math.abs(x.score) / maxAbs), tone: tone(x.score), major: x.major })),
      value: `${last.score >= 0 ? "+" : ""}${last.score.toFixed(2)}%`,
      tone: tone(last.score) === "flat" ? "dim" : (tone(last.score) as "up" | "dn"),
      flag: last.major ? `⚡ ${last.score - prev.score >= 0 ? "+" : ""}${(last.score - prev.score).toFixed(2)}` : null,
    });
  }
  return items;
}

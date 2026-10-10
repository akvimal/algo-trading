import type { IdeaAnalysis } from "../api/ideas";
import { wrapText } from "./snapshot";

// The picture a published AI analysis goes out as: the chart on top, then ONE verdict, then what the chart says and what the business says
// side by side, then where the price sits between its nearest support and resistance. Telegram shows it as a photo, so a person takes it in at
// a glance instead of reading a block of text, and the post's own text can stay a few lines. Drawn on a canvas, like the chart snapshots
// (chart/snapshot.ts), so it looks the same every time and never carries anything from the account.
//
// `layoutCard` works out every line and height from a text-measuring function and touches no canvas, so it is tested on its own;
// `composeAnalysisCard` draws what it laid out.

const BG = "#0f1216";
const PANEL = "#171c22";
const TEXT = "#e6e9ee";
const DIM = "#93a1b1";
const LINE = "rgba(255, 255, 255, 0.12)";
const UP = "#3ddc97";
const DN = "#ff6b6b";
const WARN = "#f5b74a";
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const CARD_WIDTH = 900;
const PAD = 24;
const GAP = 16;
const LH = 21; // body line height
const BODY = `15px ${FONT}`;
const BODY_BOLD = `bold 15px ${FONT}`;
const HEAD = `bold 26px ${FONT}`;
const CHIP = `bold 13px ${FONT}`;
const TITLE = `bold 12px ${FONT}`;
const SMALL = `12px ${FONT}`;

export type Measure = (text: string, font: string) => number;
type Tone = "up" | "dn" | "warn" | "dim";
export const toneColor = (t: Tone): string => (t === "up" ? UP : t === "dn" ? DN : t === "warn" ? WARN : DIM);

const ARROW = { bullish: "▲", bearish: "▼", neutral: "◆" } as const;
const biasTone = (b: string | null): Tone => (b === "bullish" ? "up" : b === "bearish" ? "dn" : "dim");
const biasWord = (b: string) => b.charAt(0).toUpperCase() + b.slice(1);
const AGREEMENT: Record<IdeaAnalysis["agreement"], { text: string; tone: Tone }> = {
  aligned: { text: "Chart and business agree", tone: "up" },
  conflicting: { text: "Chart and business disagree", tone: "warn" },
  mixed: { text: "Only one side leans", tone: "dim" },
  technical_only: { text: "Chart only", tone: "dim" },
};

export type Chip = { text: string; tone: Tone; width: number };
export type Item = { kind: "bullet" | "good" | "bad" | "text" | "note"; lines: string[] };
export type Column = { title: string; chip: Chip | null; items: Item[]; contentHeight: number };
export type CardLayout = {
  width: number;
  /** Height of everything below the chart (or below the title strip when there is no chart). */
  height: number;
  verdict: { top: number; height: number; accent: string; headline: string[]; chips: Chip[] };
  columns: { top: number; height: number; colWidth: number; chart: Column; business: Column };
  levels: { top: number; height: number; left: string | null; centre: string; right: string | null; /** Too long to sit side by side: one per line. */ stacked: boolean } | null;
  footer: { top: number; height: number; lines: string[] };
};

const price = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const level = (label: string, l: { low: number; high: number; distance_pct: number }, sign: string) => `${label} ${price(l.low)} – ${price(l.high)}  (${sign}${Math.abs(l.distance_pct).toFixed(1)}%)`;

/** At most `max` lines; when there were more, the last one ends in an ellipsis and still fits `width`. */
export function limitLines(lines: string[], max: number, width: number, measure: (s: string) => number): string[] {
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  let last = out[max - 1].replace(/[\s.,;:–-]+$/, "");
  while (last.length > 1 && measure(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
  out[max - 1] = `${last}…`;
  return out;
}

function chip(text: string, tone: Tone, measure: Measure): Chip {
  return { text, tone, width: measure(text, CHIP) + 22 };
}

function column(title: string, chipValue: Chip | null, items: Item[]): Column {
  // a title row, then each item: its lines plus a little air after it
  const contentHeight = 44 + items.reduce((h, it) => h + it.lines.length * LH + 6, 0);
  return { title, chip: chipValue, items, contentHeight };
}

/** Everything the card says, wrapped to the widths it will be drawn at, with where each block starts. `top` is where the card's own part begins
 * (below the chart, or below the title strip). */
export function layoutCard(a: IdeaAnalysis, measure: Measure, top = 0): CardLayout {
  const width = CARD_WIDTH;
  const inner = width - PAD * 2;
  const colWidth = (inner - GAP) / 2;
  const textWidth = colWidth - 20; // inside a column's own padding
  const wrap = (text: string, font: string, w: number) => wrapText(text, w, (s) => measure(s, font));

  // ---- the verdict ----
  const headline = wrap(a.verdict, HEAD, inner - 16);
  const agreement = AGREEMENT[a.agreement];
  const chips: Chip[] = [chip(agreement.text, agreement.tone, measure)];
  chips.push(chip(`Overall ${ARROW[a.overall]} ${biasWord(a.overall)}${a.overall_strength ? ` · ${a.overall_strength}` : ""}`, biasTone(a.overall), measure));
  const verdictHeight = 16 + headline.length * 34 + 8 + 28 + 14;
  const verdictTop = top;

  // ---- the chart's side ----
  const m = (s: string) => measure(s, BODY);
  const chartItems: Item[] = a.chart_points.slice(0, 4).filter((p) => p.trim()).map((p) => ({ kind: "bullet", lines: limitLines(wrap(p, BODY, textWidth - 16), 2, textWidth - 16, m) }));
  const chartCol = column("THE CHART", chip(`${ARROW[a.chart_bias]} ${biasWord(a.chart_bias)}`, biasTone(a.chart_bias), measure), chartItems);

  // ---- the business's side ----
  const businessItems: Item[] = [];
  let businessChip: Chip | null = null;
  if (a.business_bias) {
    const sure = a.business_confidence != null ? ` · ${Math.round(a.business_confidence * 100)}% sure` : "";
    businessChip = chip(`${ARROW[a.business_bias]} ${biasWord(a.business_bias)}${sure}`, biasTone(a.business_bias), measure);
    if (a.business_summary) businessItems.push({ kind: "text", lines: limitLines(wrap(a.business_summary, BODY, textWidth), 5, textWidth, m) });
    for (const p of a.pros.slice(0, 2).filter((x) => x.trim())) businessItems.push({ kind: "good", lines: limitLines(wrap(p, BODY, textWidth - 18), 2, textWidth - 18, m) });
    for (const c of a.cons.slice(0, 2).filter((x) => x.trim())) businessItems.push({ kind: "bad", lines: limitLines(wrap(c, BODY, textWidth - 18), 2, textWidth - 18, m) });
  } else {
    businessItems.push({ kind: "note", lines: wrap("Not read for this stock yet.", BODY, textWidth) });
  }
  const businessCol = column("THE BUSINESS", businessChip, businessItems);

  const colsTop = verdictTop + verdictHeight + GAP;
  const colsHeight = Math.max(chartCol.contentHeight, businessCol.contentHeight) + 16;

  // ---- where the price sits ----
  const hasLevels = Boolean(a.support || a.resistance);
  const levelsTop = colsTop + colsHeight + GAP;
  const leftText = a.resistance ? `▲ ${level("Resistance", a.resistance, "+")}` : null;
  const centreText = a.price != null ? `● ${price(a.price)}` : "●";
  const rightText = a.support ? `▼ ${level("Support", a.support, "−")}` : null;
  const LEVEL_FONT = `bold 14px ${FONT}`;
  const sideBySide = [leftText, centreText, rightText].reduce((w, t) => w + (t ? measure(t, LEVEL_FONT) : 0), 0) + 48 <= inner - 24;
  const rows = [leftText, centreText, rightText].filter(Boolean).length;
  const levelsHeight = sideBySide ? 46 : rows * 24 + 22;
  const levels = hasLevels ? { top: levelsTop, height: levelsHeight, left: leftText, centre: centreText, right: rightText, stacked: !sideBySide } : null;

  // ---- the footer ----
  const footerTop = (levels ? levelsTop + levelsHeight : levelsTop - GAP) + GAP;
  const footerLines = wrap("Generated by AI and simple rules from public data. It can be wrong. Not advice.", SMALL, inner);

  return {
    width,
    height: footerTop + footerLines.length * 16 + 14 - top,
    // a disagreement is a caution whichever way the overall lean points, so its edge is amber rather than green or red
    verdict: { top: verdictTop, height: verdictHeight, accent: toneColor(a.agreement === "conflicting" ? "warn" : biasTone(a.overall)), headline, chips },
    columns: { top: colsTop, height: colsHeight, colWidth, chart: chartCol, business: businessCol },
    levels,
    footer: { top: footerTop, height: footerLines.length * 16 + 14, lines: footerLines },
  };
}

// ---- drawing ------------------------------------------------------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not read the chart image"));
    img.src = src;
  });
}

function drawChip(ctx: CanvasRenderingContext2D, c: Chip, x: number, y: number): number {
  ctx.strokeStyle = toneColor(c.tone);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, c.width - 1, 26, 13);
  ctx.stroke();
  ctx.font = CHIP;
  ctx.fillStyle = toneColor(c.tone);
  ctx.textBaseline = "alphabetic";
  ctx.fillText(c.text, x + 11, y + 18);
  return c.width;
}

function drawColumn(ctx: CanvasRenderingContext2D, col: Column, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = PANEL;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 8);
  ctx.stroke();
  ctx.font = TITLE;
  ctx.fillStyle = DIM;
  ctx.fillText(col.title, x + 10, y + 24);
  if (col.chip) drawChip(ctx, col.chip, x + w - col.chip.width - 10, y + 8);
  let cy = y + 44;
  for (const item of col.items) {
    item.lines.forEach((line, i) => {
      const baseline = cy + 15 + i * LH;
      if (i === 0 && item.kind === "bullet") {
        ctx.fillStyle = "#4cc2ff";
        ctx.font = BODY_BOLD;
        ctx.fillText("•", x + 10, baseline);
      } else if (i === 0 && item.kind === "good") {
        ctx.fillStyle = UP;
        ctx.font = BODY_BOLD;
        ctx.fillText("✓", x + 10, baseline);
      } else if (i === 0 && item.kind === "bad") {
        ctx.fillStyle = DN;
        ctx.font = BODY_BOLD;
        ctx.fillText("✕", x + 10, baseline);
      }
      ctx.font = BODY;
      ctx.fillStyle = item.kind === "note" ? DIM : TEXT;
      const indent = item.kind === "text" || item.kind === "note" ? 10 : item.kind === "bullet" ? 26 : 28;
      ctx.fillText(line, x + indent, baseline);
    });
    cy += item.lines.length * LH + 6;
  }
}

export type CardInput = {
  analysis: IdeaAnalysis;
  /** e.g. "RRKABEL · daily". */
  title: string;
  /** The chart as a PNG data URL (the chart-only picture, with its own header), or null for a card without one. */
  chart: string | null;
};

/** The finished card as a PNG data URL, or null when the browser cannot draw it (no canvas). */
export async function composeAnalysisCard(input: CardInput): Promise<string | null> {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  const measure: Measure = (text, font) => {
    probe.font = font;
    return probe.measureText(text).width;
  };
  const chart = input.chart ? await loadImage(input.chart) : null;
  const k = 2;
  const width = CARD_WIDTH;
  const chartH = chart ? Math.round((chart.height / chart.width) * width) : 0;
  const titleH = chart ? 0 : 62;
  const layout = layoutCard(input.analysis, measure, chartH + titleH);
  const totalH = chartH + titleH + layout.height;

  const canvas = document.createElement("canvas");
  canvas.width = width * k;
  canvas.height = Math.round(totalH * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(k, k);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, totalH);
  ctx.textBaseline = "alphabetic";

  if (chart) {
    ctx.drawImage(chart, 0, 0, width, chartH);
  } else {
    ctx.fillStyle = TEXT;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText(input.title, PAD, 34);
    ctx.fillStyle = DIM;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(input.analysis.price != null ? `AI analysis · ${price(input.analysis.price)}${input.analysis.as_of ? ` · ${input.analysis.as_of}` : ""}` : "AI analysis", PAD, 54);
  }

  // verdict: a coloured edge, the one-line headline, and what it rests on
  const v = layout.verdict;
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, v.top, width, v.height);
  ctx.fillStyle = v.accent;
  ctx.fillRect(0, v.top, 6, v.height);
  ctx.fillStyle = TEXT;
  ctx.font = HEAD;
  v.headline.forEach((line, i) => ctx.fillText(line, PAD + 4, v.top + 16 + 26 + i * 34));
  let cx = PAD + 4;
  const chipY = v.top + 16 + v.headline.length * 34 + 8;
  for (const c of v.chips) cx += drawChip(ctx, c, cx, chipY) + 10;

  // the two reads side by side
  const cols = layout.columns;
  drawColumn(ctx, cols.chart, PAD, cols.top, cols.colWidth, cols.height);
  drawColumn(ctx, cols.business, PAD + cols.colWidth + GAP, cols.top, cols.colWidth, cols.height);

  // where the price sits
  if (layout.levels) {
    const l = layout.levels;
    ctx.fillStyle = PANEL;
    ctx.beginPath();
    ctx.roundRect(PAD, l.top, width - PAD * 2, l.height, 8);
    ctx.fill();
    ctx.font = `bold 14px ${FONT}`;
    if (l.stacked) {
      // resistance above, the price, support below: the same order the chart reads
      let y = l.top + 28;
      for (const [text, colour] of [[l.left, DN], [l.centre, TEXT], [l.right, UP]] as const) {
        if (!text) continue;
        ctx.fillStyle = colour;
        ctx.fillText(text, PAD + 12, y);
        y += 24;
      }
    } else {
      const mid = l.top + 28;
      ctx.textAlign = "left";
      if (l.left) {
        ctx.fillStyle = DN;
        ctx.fillText(l.left, PAD + 12, mid);
      }
      ctx.textAlign = "right";
      if (l.right) {
        ctx.fillStyle = UP;
        ctx.fillText(l.right, width - PAD - 12, mid);
      }
      ctx.textAlign = "center";
      ctx.fillStyle = TEXT;
      ctx.fillText(l.centre, width / 2, mid);
      ctx.textAlign = "left";
    }
  }

  // the notice that it is machine-made
  ctx.fillStyle = DIM;
  ctx.font = SMALL;
  layout.footer.lines.forEach((line, i) => ctx.fillText(line, PAD, layout.footer.top + 14 + i * 16));
  return canvas.toDataURL("image/png");
}

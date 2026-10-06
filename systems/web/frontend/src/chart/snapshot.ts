import type { OiItem, OiTone } from "./oiStripModel";

// A shareable picture of the chart together with what the person wrote about it: the chart image the library
// exports, with a header above it (what and when) and the note, its tag and the AI read's one-liner below.
// Composed on a canvas ourselves rather than screenshotting the page, so it looks the same every time, never
// includes account figures, and does not depend on a DOM-to-image library.

const BG = "#0f1216";
const PANEL = "#171c22";
const TEXT = "#e6e9ee";
const DIM = "#93a1b1";
const LINE = "rgba(255, 255, 255, 0.12)";
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type SnapshotInput = {
  /** The chart as a PNG data URL, from the chart library. */
  chart: string;
  /** e.g. "NIFTY · 5m". */
  title: string;
  /** e.g. "1 Oct 2026, 12:10 · 22,550.50". */
  subtitle: string;
  /** What the person wrote; may be empty (a chart-only snapshot). */
  note: string;
  tag: string | null;
  /** The latest AI read's one-liner, when the person has run one. */
  aiLine: string | null;
  /** The option-chain OI strip as drawable items, when the chart has one: drawn as a band between the chart and the note. */
  oiItems?: OiItem[] | null;
  /** How many pixels per layout pixel the chart image was exported at (2 = twice as sharp); the picture is composed at that scale. */
  scale?: number;
};

/** Breaks `text` into lines no wider than `maxWidth`, by words, honouring the person's own line breaks. A word
 * wider than the line is split mid-word rather than overflowing. `measure` is the text width in pixels. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (measure(w) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut)) > maxWidth) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxWidth) {
        out.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/** A file name like "NIFTY-5min-2026-10-01-1210.png" - safe on any system, sortable, and says what it is. */
export function snapshotFileName(symbol: string, interval: string, when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "chart";
  return `${safe(symbol)}-${safe(interval)}-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}.png`;
}

/** Runs `fn` with the page reporting a device pixel ratio of `ratio`, then puts the real one back (even if `fn`
 * throws). The chart library sizes its export canvas as the chart's size times this ratio, so on a large chart or a
 * high-density screen the canvas can exceed what the browser allows and come back as an empty "data:," - asking for a
 * ratio of 1 makes it a fraction of the size. */
export function withDevicePixelRatio<T>(ratio: number, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  try {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio });
  } catch {
    return fn(); // the browser will not let the page change it: try at the real ratio
  }
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(window, "devicePixelRatio", original);
    else delete (window as unknown as Record<string, unknown>).devicePixelRatio;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not read the chart image"));
    img.src = src;
  });
}

const UP = "#3ddc97";
const DN = "#ff6b6b";
const WARN = "#f5b74a";
const toneColor = (t: OiTone | "flat" | undefined) => (t === "up" ? UP : t === "dn" ? DN : t === "warn" ? WARN : t === "dim" || t === "flat" ? DIM : TEXT);
const OI_ROW_H = 24;
/** The widest a chart picture gets: 2.2:1, and 900 layout pixels. */
export const MAX_ASPECT = 2.2;
export const MAX_WIDTH = 900;

type Placed = { x: number; item: OiItem; w: number };

/** Lays the strip's items out left to right, wrapping to a new row at `maxWidth`. `font` sets the canvas font before measuring. */
export function layoutOi(items: OiItem[], maxWidth: number, measure: (text: string, bold: boolean) => number): Placed[][] {
  const rows: Placed[][] = [[]];
  let x = 0;
  const widthOf = (it: OiItem): number => {
    if (it.t === "text") return measure(it.text, !!it.bold);
    if (it.t === "pill") return measure(it.text, true) + 16;
    if (it.t === "skew") return 52 + 6 + measure(it.label, true);
    return it.bars.length * 5 + 6 + measure(it.value, true) + 4 + measure(it.window, false) + (it.flag ? 8 + measure(it.flag, true) + 14 : 0);
  };
  for (const item of items) {
    const w = widthOf(item);
    const gap = item.t === "text" && item.attach ? 3 : 16;
    const start = x === 0 ? 0 : x + gap;
    if (start > 0 && start + w > maxWidth) {
      rows.push([]);
      x = 0;
      rows[rows.length - 1].push({ x: 0, item, w });
      x = w;
    } else {
      rows[rows.length - 1].push({ x: start, item, w });
      x = start + w;
    }
  }
  return rows;
}

function drawOi(ctx: CanvasRenderingContext2D, rows: Placed[][], left: number, top: number): void {
  rows.forEach((row, r) => {
    const base = top + r * OI_ROW_H + 16;
    for (const { x, item, w } of row) {
      const px = left + x;
      if (item.t === "text") {
        ctx.font = `${item.bold ? "bold " : ""}13px ${FONT}`;
        ctx.fillStyle = toneColor(item.tone);
        ctx.fillText(item.text, px, base);
      } else if (item.t === "pill") {
        ctx.strokeStyle = toneColor(item.tone);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(px + 0.5, base - 14, w - 1, 20, 10);
        ctx.stroke();
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillStyle = DIM;
        ctx.fillText(item.text, px + 8, base);
      } else if (item.t === "skew") {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(px, base - 8, 52, 6);
        ctx.fillStyle = toneColor(item.tone);
        const half = 26 * item.fill;
        ctx.fillRect(item.leader === "PE" ? px + 26 : px + 26 - half, base - 8, half, 6);
        ctx.font = `bold 13px ${FONT}`;
        ctx.fillStyle = TEXT;
        ctx.fillText(item.label, px + 58, base);
      } else {
        let bx = px;
        for (const b of item.bars) {
          ctx.fillStyle = toneColor(b.tone);
          const h = Math.max(2, b.h * 14);
          ctx.fillRect(bx, base - h, 3, h);
          bx += 5;
        }
        bx += 6;
        ctx.font = `bold 13px ${FONT}`;
        ctx.fillStyle = toneColor(item.tone);
        ctx.fillText(item.value, bx, base);
        bx += ctx.measureText(item.value).width + 4;
        ctx.font = `13px ${FONT}`;
        ctx.fillStyle = DIM;
        ctx.fillText(item.window, bx, base);
        if (item.flag) {
          bx += ctx.measureText(item.window).width + 8;
          ctx.font = `bold 12px ${FONT}`;
          ctx.fillStyle = WARN;
          ctx.fillText(item.flag, bx, base);
        }
      }
    }
  });
}

/** The finished picture as a PNG data URL, or null when the browser cannot draw it (no canvas). */
export async function composeSnapshot(input: SnapshotInput): Promise<string | null> {
  const chart = await loadImage(input.chart);
  const k = input.scale && input.scale > 0 ? input.scale : 1;
  // A wide, short chart pane makes a picture that Telegram shrinks until the text is unreadable: keep the latest candles and the price axis
  // (the right-hand side), drop the oldest part when it is wider than MAX_ASPECT, and fit it to MAX_WIDTH layout pixels.
  const srcH = chart.height;
  const srcW = Math.min(chart.width, Math.round(srcH * MAX_ASPECT));
  const srcX = chart.width - srcW;
  const fit = Math.min(1, MAX_WIDTH / (srcW / k));
  const chartW = (srcW / k) * fit;
  const chartH = (srcH / k) * fit;
  const width = Math.max(chartW, 720);
  const pad = 20;
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;

  probe.font = `15px ${FONT}`;
  const noteLines = input.note.trim() ? wrapText(input.note.trim(), width - pad * 2, (s) => probe.measureText(s).width) : [];
  probe.font = `13px ${FONT}`;
  const aiLines = input.aiLine ? wrapText(`AI read: ${input.aiLine}`, width - pad * 2, (s) => probe.measureText(s).width) : [];

  const oiRows = input.oiItems?.length
    ? layoutOi(input.oiItems, width - pad * 2, (text, bold) => {
        probe.font = `${bold ? "bold " : ""}13px ${FONT}`;
        return probe.measureText(text).width;
      })
    : [];
  const oiH = oiRows.length ? 12 + oiRows.length * OI_ROW_H : 0;

  const headerH = 60;
  const noteH = noteLines.length ? pad + (input.tag ? 26 : 0) + noteLines.length * 22 : 0;
  const aiH = aiLines.length ? 10 + aiLines.length * 18 : 0;
  const footerH = noteLines.length || aiLines.length ? noteH + aiH + pad : 0;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * k);
  canvas.height = Math.round((headerH + chartH + oiH + footerH) * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(k, k);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, headerH + chartH + oiH + footerH);

  // header
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TEXT;
  ctx.font = `bold 20px ${FONT}`;
  ctx.fillText(input.title, pad, 28);
  ctx.fillStyle = DIM;
  ctx.font = `13px ${FONT}`;
  ctx.fillText(input.subtitle, pad, 48);
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(width, headerH - 0.5);
  ctx.stroke();

  // chart, centred when the minimum width made the canvas wider than it
  ctx.drawImage(chart, srcX, 0, srcW, srcH, Math.round((width - chartW) / 2), headerH, chartW, chartH);

  if (oiH > 0) {
    const oiTop = headerH + chartH;
    ctx.fillStyle = PANEL;
    ctx.fillRect(0, oiTop, width, oiH);
    drawOi(ctx, oiRows, pad, oiTop + 6);
  }

  // note, tag, AI line
  if (footerH > 0) {
    const top = headerH + chartH + oiH;
    ctx.fillStyle = PANEL;
    ctx.fillRect(0, top, width, footerH);
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(width, top + 0.5);
    ctx.stroke();
    let y = top + pad;
    if (noteLines.length) {
      if (input.tag) {
        ctx.fillStyle = DIM;
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillText(input.tag.toUpperCase(), pad, y + 8);
        y += 26;
      }
      ctx.fillStyle = TEXT;
      ctx.font = `15px ${FONT}`;
      for (const line of noteLines) {
        ctx.fillText(line, pad, y + 14);
        y += 22;
      }
    }
    if (aiLines.length) {
      y += 10;
      ctx.fillStyle = "#c4b5fd";
      ctx.font = `13px ${FONT}`;
      for (const line of aiLines) {
        ctx.fillText(line, pad, y + 10);
        y += 18;
      }
    }
  }
  return canvas.toDataURL("image/png");
}

/** Saves the picture as a file. */
export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Puts the picture on the clipboard, ready to paste into a chat. Not every browser lets a page do this. */
export async function copyDataUrl(dataUrl: string): Promise<"copied" | "unsupported" | "failed"> {
  const nav = navigator as Navigator & { clipboard?: { write?: (items: unknown[]) => Promise<void> } };
  const Item = (window as unknown as { ClipboardItem?: new (items: Record<string, Blob>) => unknown }).ClipboardItem;
  if (!nav.clipboard?.write || !Item) return "unsupported";
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await nav.clipboard.write([new Item({ [blob.type || "image/png"]: blob })]);
    return "copied";
  } catch {
    return "failed";
  }
}

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

/** The finished picture as a PNG data URL, or null when the browser cannot draw it (no canvas). */
export async function composeSnapshot(input: SnapshotInput): Promise<string | null> {
  const chart = await loadImage(input.chart);
  const width = Math.max(chart.width, 720);
  const pad = 20;
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;

  probe.font = `15px ${FONT}`;
  const noteLines = input.note.trim() ? wrapText(input.note.trim(), width - pad * 2, (s) => probe.measureText(s).width) : [];
  probe.font = `13px ${FONT}`;
  const aiLines = input.aiLine ? wrapText(`AI read: ${input.aiLine}`, width - pad * 2, (s) => probe.measureText(s).width) : [];

  const headerH = 60;
  const noteH = noteLines.length ? pad + (input.tag ? 26 : 0) + noteLines.length * 22 : 0;
  const aiH = aiLines.length ? 10 + aiLines.length * 18 : 0;
  const footerH = noteLines.length || aiLines.length ? noteH + aiH + pad : 0;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = headerH + chart.height + footerH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

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
  ctx.drawImage(chart, Math.round((width - chart.width) / 2), headerH);

  // note, tag, AI line
  if (footerH > 0) {
    const top = headerH + chart.height;
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

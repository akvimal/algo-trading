// How a drawing looks - colour, thickness, solid or dashed, a zone's fill, a label's size - kept as plain data with the
// drawing, and turned into the chart library's own style objects. Nothing here touches the chart: the saved shape,
// its clean-up, and the translation are all testable without a canvas.

export type DashStyle = "solid" | "dashed" | "dotted";

/** What a person can change about one drawing. Every field is optional: unset means the chart's own look. */
export type DrawingStyle = {
  color?: string; // "#rrggbb"
  width?: 1 | 2 | 3 | 4; // line thickness; a zone's border
  dash?: DashStyle;
  fill?: 0.15 | 0.3 | 0.5; // a zone's fill opacity
  textSize?: 11 | 13 | 16 | 20; // a text label
  bold?: boolean; // a text label
};

/** Which controls make sense for a drawing: lines (and ray, channel, fib, price level), zones, or text. */
export type StyleKind = "line" | "zone" | "text";
export const styleKindOf = (name: string): StyleKind => (name === "rect" ? "zone" : name === "textNote" ? "text" : "line");

export const SWATCHES: { value: string; label: string }[] = [
  { value: "#ffffff", label: "White" },
  { value: "#ffc83d", label: "Yellow" },
  { value: "#ff9f43", label: "Orange" },
  { value: "#e8586a", label: "Red" },
  { value: "#3ecf8e", label: "Green" },
  { value: "#4cc2ff", label: "Blue" },
  { value: "#a78bfa", label: "Purple" },
  { value: "#93a1b1", label: "Grey" },
];
export const WIDTHS = [1, 2, 3, 4] as const;
export const DASHES: { value: DashStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];
export const FILLS: { value: 0.15 | 0.3 | 0.5; label: string }[] = [
  { value: 0.15, label: "Light" },
  { value: 0.3, label: "Medium" },
  { value: 0.5, label: "Strong" },
];
export const TEXT_SIZES: { value: 11 | 13 | 16 | 20; label: string }[] = [
  { value: 11, label: "Small" },
  { value: 13, label: "Medium" },
  { value: 16, label: "Large" },
  { value: 20, label: "Huge" },
];

const HEX = /^#[0-9a-f]{6}$/i;
const oneOf = <T,>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);

/** A saved style made safe: unknown fields and out-of-range values are dropped, never trusted. Undefined when nothing is left. */
export function sanitizeStyle(raw: unknown): DrawingStyle | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: DrawingStyle = {};
  if (typeof r.color === "string" && HEX.test(r.color)) out.color = r.color.toLowerCase();
  const width = oneOf(r.width, WIDTHS);
  if (width) out.width = width;
  const dash = oneOf(r.dash, ["solid", "dashed", "dotted"] as const);
  if (dash) out.dash = dash;
  const fill = oneOf(r.fill, [0.15, 0.3, 0.5] as const);
  if (fill) out.fill = fill;
  const size = oneOf(r.textSize, [11, 13, 16, 20] as const);
  if (size) out.textSize = size;
  if (typeof r.bold === "boolean") out.bold = r.bold;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `base` with `patch` on top; a field set to undefined in the patch is removed. Empty result is undefined. */
export function mergeStyle(base: DrawingStyle | undefined, patch: DrawingStyle): DrawingStyle | undefined {
  const merged: Record<string, unknown> = { ...(base ?? {}), ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return sanitizeStyle(merged);
}

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Dark or white ink, whichever reads on `hex`. */
export function contrastInk(hex: string): "#0f1216" | "#ffffff" {
  const n = parseInt(hex.slice(1), 16);
  const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150 ? "#0f1216" : "#ffffff";
}

const dashed = (d: DashStyle | undefined) => (d === "solid" ? { style: "solid", dashedValue: [] as number[] } : d === "dashed" ? { style: "dashed", dashedValue: [6, 4] } : d === "dotted" ? { style: "dashed", dashedValue: [2, 3] } : {});

/** The chart library's `styles` for an overlay: only what the person set, so an unset drawing keeps the chart's own look.
 * A text label is drawn by our own code (see textLook), so it needs no library styles. */
export function toOverlayStyles(name: string, style: DrawingStyle | undefined): Record<string, unknown> | undefined {
  if (!style) return undefined;
  const kind = styleKindOf(name);
  if (kind === "text") return undefined;
  if (kind === "zone") {
    const color = style.color ?? "#4cc2ff";
    const border = dashed(style.dash);
    return {
      polygon: {
        style: "stroke_fill",
        color: hexToRgba(color, style.fill ?? 0.15),
        borderColor: color,
        ...(style.width ? { borderSize: style.width } : {}),
        ...(border.style ? { borderStyle: border.style, borderDashedValue: border.dashedValue } : {}),
      },
    };
  }
  const line = { ...(style.color ? { color: style.color } : {}), ...(style.width ? { size: style.width } : {}), ...dashed(style.dash) };
  return { line, ...(style.color ? { text: { color: style.color } } : {}) };
}

export const DEFAULT_TEXT_FILL = "#f4f6f8";

/** How a text label is drawn: its fill, the ink on it, size and weight. */
export function textLook(style: DrawingStyle | undefined): { background: string; ink: string; size: number; weight: "bold" | "normal" } {
  const background = style?.color ?? DEFAULT_TEXT_FILL;
  return { background, ink: contrastInk(background), size: style?.textSize ?? 12, weight: style?.bold === false ? "normal" : "bold" };
}

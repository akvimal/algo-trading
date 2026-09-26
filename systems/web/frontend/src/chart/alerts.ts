import { formatPrice } from "../format";
import type { StoredDrawing } from "./config";

// Alerts on drawings: the person marks a line or a zone on the chart, arms it, and is told when the
// price crosses it. Plain logic and no chart library, so it can be tested without a screen.
//
// These alerts are watched by the open page, not by a server: they only fire while this page is open
// and the price is arriving. That is said wherever the person arms one.

/** The drawings an alert can watch: a level (a horizontal line or a price level), a diagonal line or
 * ray (its price now is a straight-line projection of its two anchors), or a zone (a price band). */
export const ALERTABLE = new Set(["horizontalStraightLine", "priceLine", "segment", "rayLine", "rect"]);

export type Trigger = "cross" | "close";
export type Side = "above" | "inside" | "below";
export type Zone = { lo: number; hi: number };

export const TRIGGER_WORDS: Record<Trigger, string> = { cross: "as soon as it crosses", close: "when a candle closes across" };

export const isTrigger = (v: unknown): v is Trigger => v === "cross" || v === "close";

/** The price band a drawing occupies at `now`: a zero-width band for a line, the two edges of a zone.
 * Null when it cannot be worked out (missing anchors, a vertical diagonal line). */
export function alertZone(d: Pick<StoredDrawing, "name" | "points">, now: number = Date.now()): Zone | null {
  const pts = d.points;
  if (d.name === "horizontalStraightLine" || d.name === "priceLine") {
    const v = pts[0]?.value;
    return typeof v === "number" && Number.isFinite(v) ? { lo: v, hi: v } : null;
  }
  if (d.name === "rect") {
    const a = pts[0]?.value;
    const b = pts[1]?.value;
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  if (d.name === "segment" || d.name === "rayLine") {
    const [p0, p1] = pts;
    if (!p0 || !p1 || typeof p0.value !== "number" || typeof p1.value !== "number" || typeof p0.timestamp !== "number" || typeof p1.timestamp !== "number" || p1.timestamp === p0.timestamp) return null;
    const v = p0.value + ((p1.value - p0.value) * (now - p0.timestamp)) / (p1.timestamp - p0.timestamp);
    return Number.isFinite(v) ? { lo: v, hi: v } : null;
  }
  return null;
}

/** Which side of the drawing the price is on. A line has only two sides (sitting exactly on it counts
 * as above); a zone has three, and being inside it is a state of its own. */
export function sideOf(price: number, z: Zone): Side {
  if (z.lo === z.hi) return price >= z.lo ? "above" : "below";
  if (price > z.hi) return "above";
  if (price < z.lo) return "below";
  return "inside";
}

/** The message when the price moves from `prev` to `next` (which differ). */
export function alertMessage(symbol: string, z: Zone, next: Side, prev: Side | null, trigger: Trigger): string {
  const arrow = next === "above" ? "▲" : "▼";
  if (z.lo === z.hi) return `${symbol} ${arrow} ${trigger === "close" ? "closed" : "crossed"} ${next} ${formatPrice(z.hi)}`;
  const band = `${formatPrice(z.lo)}–${formatPrice(z.hi)}`;
  if (next === "inside") return `${symbol} entered the zone ${band}`;
  if (prev === "inside") return `${symbol} left the zone ${arrow} ${band}`;
  return `${symbol} ${arrow} crossed the zone ${band}`;
}

/** One check of one armed drawing. `last` is the side it was on at the previous check (null the first
 * time, when there is nothing to have crossed yet): the answer is the side now, and a message only when
 * the side changed. */
export function checkAlert(symbol: string, d: Pick<StoredDrawing, "name" | "points">, trigger: Trigger, last: Side | null, price: number, now: number = Date.now()): { side: Side; message: string | null } | null {
  const z = alertZone(d, now);
  if (!z) return null;
  const side = sideOf(price, z);
  return { side, message: last && last !== side ? alertMessage(symbol, z, side, last, trigger) : null };
}

/** How the level is read out to the person: "23,140.50" for a line, "23,100.00 to 23,200.00" for a zone. */
export function levelText(d: Pick<StoredDrawing, "name" | "points">, now: number = Date.now()): string | null {
  const z = alertZone(d, now);
  if (!z) return null;
  return z.lo === z.hi ? formatPrice(z.hi) : `${formatPrice(z.lo)} to ${formatPrice(z.hi)}`;
}

/** What the page needs to know about the selected drawing to offer an alert on it. */
export type SelectionInfo = { alertable: boolean; trigger: Trigger | null; level: string | null };

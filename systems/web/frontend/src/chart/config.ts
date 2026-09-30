import type { Candle } from "../api/types";

// Everything about the chart that is plain data: which candle sizes exist, which indicators can be
// added, what the person has switched on. Kept apart from the chart component so it can be tested
// without a canvas. Settings live in localStorage under one prefix: they are per-browser
// conveniences, and every read and write is guarded because storage can be blocked.

const PREFIX = "web.chart.";

function read<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage blocked: the choice simply lasts this session */
  }
}

export type IntervalDef = { label: string; value: string; minutes: number; lookbackDays: number; source?: string };

/** Candle sizes, in the vocabulary market-data speaks. `lookbackDays` keeps the first download to a
 * few hundred bars whatever the size. Daily and weekly come from a different provider (Yahoo, NSE
 * only), so they work even when a Dhan token has lapsed; every intraday size needs Dhan. */
export const INTERVALS: IntervalDef[] = [
  { label: "1m", value: "1min", minutes: 1, lookbackDays: 3 },
  { label: "3m", value: "3min", minutes: 3, lookbackDays: 6 },
  { label: "5m", value: "5min", minutes: 5, lookbackDays: 10 },
  { label: "15m", value: "15min", minutes: 15, lookbackDays: 30 },
  { label: "30m", value: "30min", minutes: 30, lookbackDays: 45 },
  { label: "1h", value: "60min", minutes: 60, lookbackDays: 75 },
  { label: "1d", value: "daily", minutes: 1440, lookbackDays: 365, source: "yahoo" },
  { label: "1w", value: "weekly", minutes: 10080, lookbackDays: 1095, source: "yahoo" },
];

export const DEFAULT_INTERVAL = "15min";
export const intervalDef = (value: string): IntervalDef => INTERVALS.find((i) => i.value === value) ?? INTERVALS.find((i) => i.value === DEFAULT_INTERVAL)!;

export type IndicatorDef = { name: string; label: string; overlay: boolean; params?: number[] };

/** The indicators offered. `overlay` ones draw on the price pane; the others each get a pane of their
 * own. `params` is the default list AND marks an indicator whose settings are a plain list of numbers
 * the person can edit (periods, or Supertrend's period and multiplier). */
export const INDICATORS: IndicatorDef[] = [
  { name: "MA", label: "Moving average", overlay: true, params: [5, 10, 30, 60] },
  { name: "EMA", label: "Exponential moving average", overlay: true, params: [6, 12, 20] },
  { name: "SUPERTREND", label: "Supertrend (ATR period, multiplier)", overlay: true, params: [10, 3] },
  { name: "BOLL", label: "Bollinger Bands", overlay: true },
  { name: "SAR", label: "Parabolic SAR", overlay: true },
  { name: "VOL", label: "Volume", overlay: false, params: [5, 10, 20] },
  { name: "MACD", label: "MACD", overlay: false, params: [12, 26, 9] },
  { name: "RSI", label: "RSI (period, overbought, oversold)", overlay: false, params: [14, 70, 30] },
  { name: "KDJ", label: "Stochastic (KDJ)", overlay: false, params: [9, 3, 3] },
  { name: "CCI", label: "CCI", overlay: false, params: [13] },
  { name: "DMI", label: "DMI / ADX", overlay: false, params: [14, 6] },
  { name: "OBV", label: "On-balance volume", overlay: false, params: [30] },
];

export const INDICATOR_BY_NAME = new Map(INDICATORS.map((i) => [i.name, i]));
export const DEFAULT_INDICATORS = ["MA", "VOL"];

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const loadIndicators = (): string[] => read("indicators", DEFAULT_INDICATORS, isStringArray).filter((n) => INDICATOR_BY_NAME.has(n));
export const saveIndicators = (names: string[]) => write("indicators", names);

const isParamMap = (v: unknown): v is Record<string, number[]> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => Array.isArray(x) && x.every((n) => typeof n === "number"));

/** Only the indicators whose numbers the person changed are stored. An EMPTY list is a real choice
 * ("no moving-average lines"), not a missing value. */
export const loadIndicatorParams = (): Record<string, number[]> => {
  const all = read("indicatorParams", {} as Record<string, number[]>, isParamMap);
  return Object.fromEntries(Object.entries(all).filter(([k]) => INDICATOR_BY_NAME.get(k)?.params));
};
export const saveIndicatorParams = (p: Record<string, number[]>) => write("indicatorParams", p);

/** "5, 10, 20" becomes [5, 10, 20]; a blank field becomes [] (drop the lines). Fractions are allowed
 * (a Supertrend multiplier is often 2.5); nothing non-positive or absurd gets through. */
export function parseParamList(text: string): number[] {
  return text
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 500)
    .map((n) => Math.round(n * 100) / 100);
}

export function effectiveParams(name: string, overrides: Record<string, number[]>): number[] | undefined {
  if (name in overrides) return overrides[name];
  return INDICATOR_BY_NAME.get(name)?.params;
}

/** Detection timeframes for the structure layer, chosen independently of the candle size on screen.
 * Each has its own, wider look-back so a coarse timeframe has enough bars to find structure. */
export const STRUCTURE_TIMEFRAMES: { label: string; value: string; lookbackDays: number; source?: string }[] = [
  { label: "1m", value: "1min", lookbackDays: 4 },
  { label: "3m", value: "3min", lookbackDays: 8 },
  { label: "5m", value: "5min", lookbackDays: 12 },
  { label: "15m", value: "15min", lookbackDays: 30 },
  { label: "30m", value: "30min", lookbackDays: 50 },
  { label: "1h", value: "60min", lookbackDays: 90 },
  { label: "1d", value: "daily", lookbackDays: 365, source: "yahoo" },
];
const STRUCTURE_TF_VALUES = new Set(STRUCTURE_TIMEFRAMES.map((t) => t.value));

export type StructureConfig = {
  tfs: string[];
  breakers: boolean;
  fvg: boolean;
  breaks: boolean;
  trendMarks: boolean;
  setups: boolean;
};
export const EMPTY_STRUCTURE: StructureConfig = { tfs: [], breakers: false, fvg: false, breaks: false, trendMarks: false, setups: false };

/** Off by default: an opt-in analytical layer, and each timeframe costs one extra download. */
export function loadStructure(): StructureConfig {
  const raw = read<Record<string, unknown>>("structure", {}, (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
  return {
    tfs: Array.isArray(raw.tfs) ? raw.tfs.filter((t): t is string => typeof t === "string" && STRUCTURE_TF_VALUES.has(t)) : [],
    breakers: raw.breakers === true,
    fvg: raw.fvg === true,
    breaks: raw.breaks === true,
    trendMarks: raw.trendMarks === true,
    setups: raw.setups === true,
  };
}
export const saveStructure = (s: StructureConfig) => write("structure", s);

export const structureIsOn = (s: StructureConfig) => s.tfs.length > 0;

const structureMinutesOf = (v: string): number => INTERVALS.find((i) => i.value === v)?.minutes ?? 0;

/** After the chart's own candle size changes, the structure layer's selected detection timeframes
 * reset to match: anything finer than the new size is dropped (a 1-minute structure read makes
 * little sense once the chart itself is on 1-hour candles), anything coarser stays (still a
 * meaningful "zoom out" read), and the new size itself joins the selection if it's a valid
 * structure timeframe. STRUCTURE_TIMEFRAMES has no "weekly" entry (order-block detection doesn't
 * go that coarse), so switching to weekly candles adds nothing - and drops every other selected
 * timeframe too, daily included, since daily is itself finer than a week. A no-op while the layer
 * is off (tfs empty): this never turns it on by itself, since it is opt-in by design (see
 * loadStructure's own comment). */
export function resetStructureForInterval(tfs: string[], newInterval: string): string[] {
  if (tfs.length === 0) return tfs;
  const newMinutes = structureMinutesOf(newInterval);
  const kept = tfs.filter((tf) => structureMinutesOf(tf) >= newMinutes);
  if (STRUCTURE_TF_VALUES.has(newInterval) && !kept.includes(newInterval)) {
    return [...kept, newInterval].sort((a, b) => structureMinutesOf(a) - structureMinutesOf(b));
  }
  return kept;
}

/** The Indicators menu's own quick "Structure" switch, alongside "Hide all indicators" - since
 * ticking/unticking every "Detect on" timeframe by hand is the only way there was to turn the
 * whole layer off before this existed. Off clears every ticked timeframe (which is also what hides
 * the Structure dropdown itself - see structureIsOn); on seeds a single fresh one - the active
 * chart's own candle size, or the coarsest structure timeframe available if that size has none
 * (weekly candles, same gap resetStructureForInterval's own comment notes). Never restores
 * whatever mix was ticked before switching off - a clean slate is the whole point of a quick
 * toggle, not resurrecting an accumulated list. */
export function toggleStructureOn(on: boolean, activeInterval: string): string[] {
  if (!on) return [];
  return STRUCTURE_TF_VALUES.has(activeInterval) ? [activeInterval] : [STRUCTURE_TIMEFRAMES[STRUCTURE_TIMEFRAMES.length - 1].value];
}

export type ToolSettings = { magnet: boolean; drawingsHidden: boolean; indicatorsHidden: boolean; tradesOn: boolean; oiLevelsOn: boolean; priceHidden: boolean };
export const loadTools = (): ToolSettings => {
  const raw = read<Record<string, unknown>>("tools", {}, (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
  return {
    magnet: raw.magnet === true, drawingsHidden: raw.drawingsHidden === true, indicatorsHidden: raw.indicatorsHidden === true,
    tradesOn: raw.tradesOn !== false, oiLevelsOn: raw.oiLevelsOn === true, priceHidden: raw.priceHidden === true,
  };
};
export const saveTools = (t: ToolSettings) => write("tools", t);

/** klinecharts wants epoch-millisecond timestamps and its own field names. */
export function toKLine(c: Candle): { timestamp: number; open: number; high: number; low: number; close: number; volume: number } {
  return { timestamp: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

/** Enough decimals to tell adjacent ticks apart: two for indices and stocks, more for sub-rupee or
 * (at the other extreme) large crypto quotes reported finely. */
export function pricePrecision(p: number): number {
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  return 6;
}

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** The date range to download for a candle size, ending today. */
export function lookbackRange(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: ymd(new Date(now.getTime() - days * 86_400_000)), to: ymd(now) };
}

/** Drawings are anchored in price and time, so they belong to the instrument, not the candle size:
 * one saved set per (exchange, symbol), shared by every interval. */
export const drawingsKey = (exchange: string, symbol: string) => `drawings:${exchange}:${symbol}`;

export type StoredPoint = { timestamp?: number; value?: number };
/** A drawing as saved. `alert`, when set, means the page tells the person when the price crosses it. */
export type StoredDrawing = { name: string; points: StoredPoint[]; color?: string; alert?: { trigger: "cross" | "close" } };

const isDrawings = (v: unknown): v is StoredDrawing[] =>
  Array.isArray(v) && v.every((d) => d && typeof d.name === "string" && Array.isArray(d.points));

/** What was saved, made safe: an alert setting that is not a known trigger is dropped. */
export const loadDrawings = (exchange: string, symbol: string): StoredDrawing[] =>
  read(drawingsKey(exchange, symbol), [], isDrawings).map((d) => {
    const { alert, ...rest } = d;
    return alert && (alert.trigger === "cross" || alert.trigger === "close") ? { ...rest, alert: { trigger: alert.trigger } } : rest;
  });

// Saving is the only signal a SIBLING ChartPane showing the same instrument (a two-chart layout,
// same symbol at two different candle sizes) has that it needs to re-read and redraw - drawings
// are keyed only by (exchange, symbol), deliberately shared across every interval (see
// drawingsKey's own comment), but writing to localStorage from one pane does not by itself notify
// another still-mounted pane reading the same key in the same document: the browser's own
// `storage` event only fires in OTHER tabs/windows, never the one that made the write. `origin`
// (each ChartPane's own instance id) lets a pane recognise and skip its OWN write - reacting to it
// too would wipe and rebuild its own overlays on every draw/move/delete, losing whatever was
// selected for no reason, not just resync a peer.
export const DRAWINGS_CHANGED_EVENT = "web:chart:drawings-changed";
export type DrawingsChangedDetail = { exchange: string; symbol: string; origin: string };

export function saveDrawings(exchange: string, symbol: string, d: StoredDrawing[], origin = ""): void {
  write(drawingsKey(exchange, symbol), d);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<DrawingsChangedDetail>(DRAWINGS_CHANGED_EVENT, { detail: { exchange, symbol, origin } }));
  }
}

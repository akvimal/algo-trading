import { useEffect, useRef, useState } from "react";

import {
  dispose,
  init,
  registerOverlay,
  type Chart,
  type DeepPartial,
  type KLineData,
  type Overlay,
  type OverlayEvent,
  type Styles,
} from "klinecharts";

import {
  type Candle,
  type ChartStructure,
  type ResolvedUnderlying,
  fetchCandleHistory,
  fetchChartStructure,
  fetchLtp,
  resolveUnderlying,
} from "./api";

// klinecharts 9.x ships only line-family overlays - no rectangle - so
// register a minimal one for supply/demand zones: click two opposite
// corners, get a filled box. Styled via `overlay.polygon` in DARK_STYLES
// (translucent fill so candles read through it). Global + idempotent -
// re-registering under the same name just overwrites, fine under HMR.
registerOverlay({
  name: "rect",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: a.x, y: a.y },
            { x: b.x, y: a.y },
            { x: b.x, y: b.y },
            { x: a.x, y: b.y },
          ],
        },
        styles: { style: "stroke_fill" },
      },
    ];
  },
});

// Auto-generated higher-timeframe SMC structure (from market-data's GET
// /order-blocks): order blocks, breakers, and fair value gaps. Not
// user-drawn: created programmatically with one anchor point (the origin
// bar) + `extendData` carrying the price band and metadata. The figures
// span from that anchor's x to the pane's current right edge, recomputed
// every frame, so a zone auto-extends as the live bar advances and
// survives pan/zoom. Deliberately faint and tagged, so it reads as
// distinct from the solid accent-blue user-drawn `rect` above.
const OB_GROUP_ID = "order-blocks";
type ObExtendData = {
  tf: string;
  kind: "demand" | "supply";
  role: "orderblock" | "breaker";
  proximal: number;
  distal: number;
  mitigated: boolean;
  counterTrend: boolean;
};
type FvgExtendData = { kind: "bullish" | "bearish"; top: number; bottom: number; filled: boolean };
type BreakExtendData = { tf: string; kind: "bos" | "choch"; direction: "up" | "down"; price: number };
type SetupExtendData = {
  tf: string;
  direction: "long" | "short";
  status: "confirmed" | "triggered" | "hit_target" | "hit_sl" | "invalidated";
  entry: number;
  stop: number;
  target: number;
  rr: number;
};

registerOverlay({
  name: "htfOrderBlock",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 1 || !yAxis) return [];
    const d = overlay.extendData as ObExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    const rightX = bounding.width;
    if (rightX <= leftX) return [];
    const yA = yAxis.convertToPixel(d.proximal);
    const yB = yAxis.convertToPixel(d.distal);
    const top = Math.min(yA, yB);
    const height = Math.max(1, Math.abs(yA - yB));
    const breaker = d.role === "breaker";
    // Counter-trend zones (opposing the structure trend) are dimmed to
    // ~40% so the with-trend zones you'd actually trade from stand out.
    const dim = d.counterTrend ? 0.4 : 1;
    const rgb = d.kind === "demand" ? "62, 207, 142" : "232, 88, 106";
    const stroke = `rgba(${rgb}, ${0.6 * dim})`;
    const fill = `rgba(${rgb}, ${(breaker ? 0.17 : 0.13) * dim})`;
    const label =
      `${d.tf} ${breaker ? "breaker" : d.kind}` + (d.mitigated ? " · tested" : "") + (d.counterTrend ? " · counter" : "");
    return [
      {
        type: "rect",
        attrs: { x: leftX, y: top, width: rightX - leftX, height },
        styles: {
          style: "stroke_fill",
          color: fill,
          borderColor: stroke,
          borderSize: breaker ? 2 : 1,
          borderStyle: d.mitigated ? "dashed" : "solid",
        },
        ignoreEvent: true,
      },
      {
        type: "text",
        attrs: { x: leftX + 4, y: top + 2, text: label, baseline: "top" },
        styles: { color: stroke, size: 10 },
        ignoreEvent: true,
      },
    ];
  },
});

// BOS / CHoCH structure breaks - a thin horizontal line at the swing
// level that broke, from the break candle to the right edge. Green up /
// red down; CHoCH dashed (it flipped the trend), BOS solid.
registerOverlay({
  name: "htfStructureBreak",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 1 || !yAxis) return [];
    const d = overlay.extendData as BreakExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    const rightX = bounding.width;
    if (rightX <= leftX) return [];
    const y = yAxis.convertToPixel(d.price);
    const color = d.direction === "up" ? "rgba(62, 207, 142, 0.75)" : "rgba(232, 88, 106, 0.75)";
    return [
      {
        type: "line",
        attrs: { coordinates: [{ x: leftX, y }, { x: rightX, y }] },
        styles: { color, size: 1, style: d.kind === "choch" ? "dashed" : "solid" },
        ignoreEvent: true,
      },
      {
        type: "text",
        attrs: { x: leftX + 4, y: y - 12, text: `${d.tf} ${d.kind.toUpperCase()} ${d.direction === "up" ? "▲" : "▼"}`, baseline: "top" },
        styles: { color, size: 10 },
        ignoreEvent: true,
      },
    ];
  },
});

// Rejection-confirmed trade setups (Phase 3c) - entry / stop / target
// lines + a translucent red risk box (entry↔stop) and green reward box
// (entry↔target), from the confirmation candle to where the setup
// resolved (or the right edge while live). Resolved setups are drawn
// faded. A 2-point overlay: point 0 = confirmation candle, point 1 = the
// resolution bar (or now).
registerOverlay({
  name: "htfSetup",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, yAxis }) => {
    if (coordinates.length < 2 || !yAxis) return [];
    const d = overlay.extendData as SetupExtendData | undefined;
    if (!d) return [];
    const x0 = coordinates[0].x;
    const x1 = Math.max(coordinates[1].x, x0 + 2);
    const yE = yAxis.convertToPixel(d.entry);
    const yS = yAxis.convertToPixel(d.stop);
    const yT = yAxis.convertToPixel(d.target);
    const live = d.status === "confirmed" || d.status === "triggered";
    const a = live ? 1 : 0.34;
    const red = `rgba(232, 88, 106, ${0.7 * a})`;
    const green = `rgba(62, 207, 142, ${0.7 * a})`;
    const neutral = `rgba(230, 233, 238, ${(d.status === "triggered" ? 0.85 : 0.6) * a})`;
    const label = `${d.tf} ${d.direction} · ${d.status} · ${d.rr.toFixed(1)}R`;
    return [
      {
        type: "rect",
        attrs: { x: x0, y: Math.min(yE, yS), width: x1 - x0, height: Math.max(1, Math.abs(yE - yS)) },
        styles: { style: "fill", color: `rgba(232, 88, 106, ${0.1 * a})` },
        ignoreEvent: true,
      },
      {
        type: "rect",
        attrs: { x: x0, y: Math.min(yE, yT), width: x1 - x0, height: Math.max(1, Math.abs(yE - yT)) },
        styles: { style: "fill", color: `rgba(62, 207, 142, ${0.1 * a})` },
        ignoreEvent: true,
      },
      {
        type: "line",
        attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] },
        styles: { color: neutral, size: 1, style: d.status === "triggered" ? "solid" : "dashed" },
        ignoreEvent: true,
      },
      { type: "line", attrs: { coordinates: [{ x: x0, y: yS }, { x: x1, y: yS }] }, styles: { color: red, size: 1 }, ignoreEvent: true },
      { type: "line", attrs: { coordinates: [{ x: x0, y: yT }, { x: x1, y: yT }] }, styles: { color: green, size: 1 }, ignoreEvent: true },
      {
        type: "text",
        attrs: { x: x0 + 4, y: Math.min(yE, yS, yT) - 12, text: label, baseline: "top" },
        styles: { color: neutral, size: 10 },
        ignoreEvent: true,
      },
    ];
  },
});

// Fair value gaps - a thin amber band, no label (they're small and
// frequent); `filled` ones drawn fainter. Same anchor+extend mechanism.
registerOverlay({
  name: "htfFvg",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 1 || !yAxis) return [];
    const d = overlay.extendData as FvgExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    const rightX = bounding.width;
    if (rightX <= leftX) return [];
    const yTop = yAxis.convertToPixel(d.top);
    const yBottom = yAxis.convertToPixel(d.bottom);
    const top = Math.min(yTop, yBottom);
    const height = Math.max(1, Math.abs(yTop - yBottom));
    return [
      {
        type: "rect",
        attrs: { x: leftX, y: top, width: rightX - leftX, height },
        styles: {
          style: "stroke_fill",
          color: `rgba(224, 176, 88, ${d.filled ? 0.07 : 0.2})`,
          borderColor: `rgba(224, 176, 88, ${d.filled ? 0.25 : 0.55})`,
          borderSize: 1,
          borderStyle: d.filled ? "dashed" : "solid",
        },
        ignoreEvent: true,
      },
    ];
  },
});

// The live chart (see docs/architecture.md § "Why the live chart uses a
// library"). A candlestick view of one underlying's own spot/chart price,
// from market-data's GET /candles/history, kept current by polling GET
// /quotes/ltp for the still-forming bar. klinecharts is the first real
// charting dependency in this repo - every other chart here (OiBarChart,
// SentimentHistoryChart, execution's PnlChart) is hand-rolled SVG, but a
// pan/zoom/crosshair candlestick chart with drawable line/zone overlays
// is well past the point where hand-rolling pays off.
//
// Phase 1: candles + live-polled trailing bar. Phase 2: the klinecharts
// overlay toolbar below - trend lines, horizontal levels, rectangles
// (supply/demand zones), fib - persisted per symbol to localStorage.
// Phase 2 also: the Indicators menu - klinecharts' built-in indicators
// added/removed on the fly (MA/EMA/BOLL/SAR overlay the candles; VOL/
// MACD/RSI/... each get a lower pane), the active set remembered in
// localStorage. Phase 3 (auto zone detection) is still just scoped.

type IntervalDef = { label: string; value: string; minutes: number; lookbackDays: number };

// value = market-data's own interval vocabulary (1/5/15/60min native to
// Dhan, 3min/30min locally aggregated from 1min bars - see its
// providers/dhan.py + candle_aggregation.py). lookback keeps the initial
// series to a few hundred bars regardless of interval; panning further
// back (klinecharts' setLoadDataCallback) is a later phase, not wired here.
const INTERVALS: IntervalDef[] = [
  { label: "1m", value: "1min", minutes: 1, lookbackDays: 3 },
  { label: "3m", value: "3min", minutes: 3, lookbackDays: 6 },
  { label: "5m", value: "5min", minutes: 5, lookbackDays: 10 },
  { label: "15m", value: "15min", minutes: 15, lookbackDays: 30 },
  { label: "30m", value: "30min", minutes: 30, lookbackDays: 45 },
  { label: "1h", value: "60min", minutes: 60, lookbackDays: 75 },
];

const INTERVAL_STORAGE_KEY = "manualLiveChartInterval";
const INDICATORS_STORAGE_KEY = "manualLiveChartIndicators";

// klinecharts' own built-in indicator names. `overlay: true` draws on the
// candle pane (stacked, so several can coexist); the rest each get their
// own lower pane. This is a curated subset of the ~25 klinecharts ships -
// the ones a discretionary trader actually reaches for.
const INDICATORS: { name: string; label: string; overlay: boolean }[] = [
  { name: "MA", label: "MA · moving average", overlay: true },
  { name: "EMA", label: "EMA · exp. moving average", overlay: true },
  { name: "BOLL", label: "Bollinger Bands", overlay: true },
  { name: "SAR", label: "Parabolic SAR", overlay: true },
  { name: "BBI", label: "BBI", overlay: true },
  { name: "VOL", label: "Volume", overlay: false },
  { name: "MACD", label: "MACD", overlay: false },
  { name: "RSI", label: "RSI", overlay: false },
  { name: "KDJ", label: "KDJ · stochastic", overlay: false },
  { name: "CCI", label: "CCI", overlay: false },
  { name: "DMI", label: "DMI / ADX", overlay: false },
  { name: "WR", label: "Williams %R", overlay: false },
  { name: "OBV", label: "OBV", overlay: false },
];

const INDICATOR_BY_NAME = new Map(INDICATORS.map((i) => [i.name, i]));

// Matches what was hardcoded before this became configurable.
const DEFAULT_INDICATORS = ["MA", "VOL"];

function loadIndicators(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDICATORS_STORAGE_KEY) ?? "null");
    if (Array.isArray(raw)) return raw.filter((n): n is string => typeof n === "string" && INDICATOR_BY_NAME.has(n));
  } catch {
    // fall through to the default
  }
  return DEFAULT_INDICATORS;
}

const ORDER_BLOCKS_STORAGE_KEY = "manualLiveChartOrderBlocks";

// Detection timeframes for the order-block overlay - independent of the
// chart's display interval. Each needs its OWN (wider) lookback so a
// coarse timeframe has enough bars to find structure, regardless of how
// little history the displayed chart pulled.
const OB_TIMEFRAMES: { label: string; value: string; lookbackDays: number }[] = [
  { label: "1m", value: "1min", lookbackDays: 4 },
  { label: "3m", value: "3min", lookbackDays: 8 },
  { label: "5m", value: "5min", lookbackDays: 12 },
  { label: "15m", value: "15min", lookbackDays: 30 },
  { label: "30m", value: "30min", lookbackDays: 50 },
  { label: "1h", value: "60min", lookbackDays: 90 },
];

const OB_TF_VALUES = new Set(OB_TIMEFRAMES.map((t) => t.value));

// Re-fetch order blocks on this cadence to catch zones that formed as
// detection-timeframe bars closed. Coarse on purpose - zones change
// slowly, and market-data's per-tuple candle cache makes a same-day
// re-fetch nearly free anyway.
const OB_REFRESH_MS = 2 * 60_000;

// Persisted config for the structure overlays. `tfs` are the detection
// timeframes; `breakers`/`fvg`/`breaks` are global modifiers over every
// enabled timeframe. Off by default - it's an opt-in analytical layer
// that costs one extra fetch per timeframe.
type StructureConfig = { tfs: string[]; breakers: boolean; fvg: boolean; breaks: boolean; setups: boolean };
const EMPTY_STRUCTURE_CONFIG: StructureConfig = { tfs: [], breakers: false, fvg: false, breaks: false, setups: false };

function loadStructureConfig(): StructureConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_BLOCKS_STORAGE_KEY) ?? "null");
    // Migration: the pre-3a shape was a bare string[] of timeframes.
    const tfsSource = Array.isArray(raw) ? raw : raw?.tfs;
    const tfs = Array.isArray(tfsSource)
      ? tfsSource.filter((v): v is string => typeof v === "string" && OB_TF_VALUES.has(v))
      : [];
    return {
      tfs,
      breakers: raw?.breakers === true,
      fvg: raw?.fvg === true,
      breaks: raw?.breaks === true,
      setups: raw?.setups === true,
    };
  } catch {
    return EMPTY_STRUCTURE_CONFIG;
  }
}

// LTP poll cadence for the still-forming bar - matches WorkspacePage's
// own 5s watch loop; market-data's LTP cache is short-lived, so polling
// faster than this just re-reads the same number.
const LTP_POLL_MS = 5000;

// Dark palette lifted straight from index.css's :root (this frontend is
// dark-only - single :root, no theme toggle, no prefers-color-scheme), so
// the canvas chart matches the rest of the app. Kept as literals rather
// than getComputedStyle plumbing since the values never change at runtime.
const BUY = "#3ecf8e";
const SELL = "#e8586a";
const DIM = "#8b93a1";
const TEXT = "#e6e9ee";
const BORDER = "#262c35";
const RAISED = "#1d222a";
const BG = "#0f1216";
const ACCENT = "#4c8bf5";

const DARK_STYLES: DeepPartial<Styles> = {
  grid: {
    horizontal: { color: BORDER },
    vertical: { color: BORDER },
  },
  candle: {
    bar: {
      upColor: BUY,
      downColor: SELL,
      noChangeColor: DIM,
      upBorderColor: BUY,
      downBorderColor: SELL,
      noChangeBorderColor: DIM,
      upWickColor: BUY,
      downWickColor: SELL,
      noChangeWickColor: DIM,
    },
    priceMark: {
      high: { color: DIM },
      low: { color: DIM },
      last: {
        upColor: BUY,
        downColor: SELL,
        noChangeColor: DIM,
        // The pill line/background follow the up/down color; only the
        // text on the pill is ours to set (dark, for contrast on green/red).
        text: { color: BG },
      },
    },
    tooltip: { text: { color: TEXT } },
  },
  indicator: {
    tooltip: { text: { color: DIM } },
    lastValueMark: { show: false },
  },
  xAxis: {
    axisLine: { color: BORDER },
    tickLine: { color: BORDER },
    tickText: { color: DIM },
  },
  yAxis: {
    axisLine: { color: BORDER },
    tickLine: { color: BORDER },
    tickText: { color: DIM },
  },
  separator: { color: BORDER },
  crosshair: {
    horizontal: {
      line: { color: DIM },
      text: { backgroundColor: RAISED, borderColor: BORDER, color: TEXT },
    },
    vertical: {
      line: { color: DIM },
      text: { backgroundColor: RAISED, borderColor: BORDER, color: TEXT },
    },
  },
  // Drawn overlays (the toolbar below) - accent-blue lines, and a
  // translucent-fill rect so a supply/demand zone doesn't black out the
  // candles underneath it.
  overlay: {
    line: { color: ACCENT },
    rect: { color: "rgba(76, 139, 245, 0.16)", borderColor: ACCENT, borderSize: 1.5 },
    polygon: { color: "rgba(76, 139, 245, 0.16)", borderColor: ACCENT },
    text: { color: TEXT, backgroundColor: RAISED, borderColor: BORDER },
    point: { color: ACCENT, borderColor: BG, activeColor: ACCENT, activeBorderColor: TEXT },
  },
};

// klinecharts' own built-in overlay templates (no registration needed).
// Kept to the handful that matter for reading price structure and marking
// supply/demand zones - the full set (channels, vertical lines, tags, ...)
// is a longer list than a trading chart's toolbar wants.
const DRAW_TOOLS: { label: string; overlay: string; title: string }[] = [
  { label: "Trend", overlay: "segment", title: "Trend line - click two points" },
  { label: "Ray", overlay: "rayLine", title: "Ray - anchor, then direction" },
  { label: "H-line", overlay: "horizontalStraightLine", title: "Horizontal price line" },
  { label: "Zone", overlay: "rect", title: "Rectangle - mark a supply/demand zone" },
  { label: "Price", overlay: "priceLine", title: "Horizontal line with a price label" },
  { label: "Fib", overlay: "fibonacciLine", title: "Fibonacci retracement" },
];

// What we persist per drawn overlay - just the template name and its
// time/price anchor points (dataIndex is re-derived by klinecharts from
// the timestamp when we recreate it, so it's not stored).
type StoredOverlay = { name: string; points: Array<{ timestamp?: number; value?: number }> };

// Drawings are price/time anchored, so they belong to the instrument, not
// the timeframe - one key per resolved chart symbol, shared across every
// interval.
function overlayStorageKey(exchange: string, symbol: string): string {
  return `manualLiveChartDrawings:${exchange}:${symbol}`;
}

function serializeOverlay(o: Overlay): StoredOverlay {
  return { name: o.name, points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })) };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toKLine(c: Candle): KLineData {
  return { timestamp: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

// Enough decimals to tell adjacent ticks apart across the instruments
// this app trades - 2dp for equities/indices, more for sub-rupee or (the
// other extreme) already-large crypto quotes that Delta reports finely.
function pricePrecision(p: number): number {
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  return 6;
}

type Status = "loading" | "ready" | "error";

export function LiveChartPanel({ segment, symbol }: { segment: string; symbol: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  const [resolved, setResolved] = useState<ResolvedUnderlying | null>(null);
  const [interval, setInterval_] = useState<string>(() => localStorage.getItem(INTERVAL_STORAGE_KEY) ?? "5min");
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<string[]>(loadIndicators);
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const indicatorMenuRef = useRef<HTMLDivElement | null>(null);
  // Indicator name -> the pane id klinecharts created it on, so we can
  // remove exactly that one later (candle-pane overlays share "candle_pane").
  const indicatorPanesRef = useRef<Map<string, string>>(new Map());

  const [structure, setStructure] = useState<StructureConfig>(loadStructureConfig);
  const [trendByTf, setTrendByTf] = useState<Record<string, "up" | "down" | "range">>({});
  const [obMenuOpen, setObMenuOpen] = useState(false);
  const obMenuRef = useRef<HTMLDivElement | null>(null);
  // Bumped after every applyNewData (initial load + each interval switch)
  // - the order-block effect keys off this so its overlays are (re)added
  // only once the new series is actually on the chart, never racing
  // applyNewData. 0 = no data loaded yet.
  const [dataEpoch, setDataEpoch] = useState(0);

  // Drawn-overlay bookkeeping: id -> its serialized form, the storage key
  // for the current instrument, and a flag that silences the onRemoved
  // handler while WE are the ones clearing overlays (see loadDrawings).
  const overlaysRef = useRef<Map<string, StoredOverlay>>(new Map());
  const storageKeyRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  // The overlay klinecharts currently has selected (single-clicked) - the
  // target of the Delete/Backspace key handler wired in the lifecycle effect.
  const selectedOverlayRef = useRef<string | null>(null);

  function pickInterval(value: string) {
    localStorage.setItem(INTERVAL_STORAGE_KEY, value);
    setInterval_(value);
  }

  function toggleIndicator(name: string) {
    setIndicators((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      try {
        localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage disabled - the toggle still applies this session
      }
      return next;
    });
  }

  function updateStructure(patch: Partial<StructureConfig>) {
    setStructure((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(ORDER_BLOCKS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage disabled - the change still applies this session
      }
      return next;
    });
  }

  function toggleStructureTf(tf: string) {
    updateStructure({
      tfs: structure.tfs.includes(tf) ? structure.tfs.filter((t) => t !== tf) : [...structure.tfs, tf],
    });
  }

  function persistOverlays() {
    const key = storageKeyRef.current;
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify([...overlaysRef.current.values()]));
    } catch {
      // quota exceeded / storage disabled - drawings just won't survive a reload
    }
  }

  // The same callback set is attached to every overlay, whether freshly
  // drawn or restored from storage: keep our id->points map in sync on
  // draw-end and drag-end, drop it on removal, track selection for the
  // Delete-key handler, and let a right-click delete outright (klinecharts
  // ships no delete affordance of its own).
  function overlayHandlers() {
    return {
      onDrawEnd: (e: OverlayEvent) => {
        overlaysRef.current.set(e.overlay.id, serializeOverlay(e.overlay));
        persistOverlays();
        setActiveTool(null);
        return false;
      },
      onPressedMoveEnd: (e: OverlayEvent) => {
        overlaysRef.current.set(e.overlay.id, serializeOverlay(e.overlay));
        persistOverlays();
        return false;
      },
      onRemoved: (e: OverlayEvent) => {
        if (selectedOverlayRef.current === e.overlay.id) selectedOverlayRef.current = null;
        if (restoringRef.current) return false;
        overlaysRef.current.delete(e.overlay.id);
        persistOverlays();
        return false;
      },
      onSelected: (e: OverlayEvent) => {
        selectedOverlayRef.current = e.overlay.id;
        return false;
      },
      onDeselected: (e: OverlayEvent) => {
        if (selectedOverlayRef.current === e.overlay.id) selectedOverlayRef.current = null;
        return false;
      },
      onRightClick: (e: OverlayEvent) => {
        chartRef.current?.removeOverlay(e.overlay.id);
        return true;
      },
    };
  }

  function startDrawing(name: string) {
    const chart = chartRef.current;
    if (!chart) return;
    setActiveTool(name);
    chart.createOverlay({ name, ...overlayHandlers() });
  }

  function clearDrawings() {
    const chart = chartRef.current;
    if (!chart) return;
    restoringRef.current = true;
    chart.removeOverlay();
    restoringRef.current = false;
    overlaysRef.current.clear();
    persistOverlays();
    setActiveTool(null);
  }

  // Re-sync the drawn overlays from storage for the current instrument -
  // called on the initial load and again on every interval switch (which
  // reloads the series), so it clears first and is idempotent regardless
  // of whether klinecharts keeps overlays across applyNewData.
  function loadDrawings(exchange: string, sym: string) {
    const chart = chartRef.current;
    if (!chart) return;
    storageKeyRef.current = overlayStorageKey(exchange, sym);
    restoringRef.current = true;
    chart.removeOverlay();
    overlaysRef.current.clear();
    let stored: unknown;
    try {
      stored = JSON.parse(localStorage.getItem(storageKeyRef.current) ?? "[]");
    } catch {
      stored = [];
    }
    if (Array.isArray(stored)) {
      for (const s of stored as StoredOverlay[]) {
        if (!s || typeof s.name !== "string" || !Array.isArray(s.points)) continue;
        const id = chart.createOverlay({ name: s.name, points: s.points, ...overlayHandlers() });
        if (typeof id === "string") overlaysRef.current.set(id, s);
      }
    }
    restoringRef.current = false;
  }

  // --- Chart lifecycle: create once, dispose on unmount. The panel is
  // remounted (via a `key` on segment/symbol upstream) when the
  // instrument changes, so this effect never has to swap symbols. ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = init(el, { styles: DARK_STYLES, timezone: "Asia/Kolkata", locale: "en-US" });
    chartRef.current = chart;
    // Indicators are applied by the reconcile effect below, which runs
    // right after this one on mount (chartRef is already set by then).

    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(el);

    // Delete / Backspace removes the selected overlay - the conventional
    // charting gesture, and more reliable than pixel-hunting for a
    // right-click on a 1px line. Ignored while typing in a field.
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const id = selectedOverlayRef.current;
      if (!id) return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      ev.preventDefault();
      chart?.removeOverlay(id);
      selectedOverlayRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      dispose(el);
      chartRef.current = null;
      indicatorPanesRef.current.clear();
    };
  }, []);

  // --- Reconcile the chart's indicators against `indicators`: this runs
  // on mount (applying the remembered set) and on every toggle. Overlay
  // indicators stack on the candle pane; the rest each get their own
  // lower pane (a stable id per name, so a remove targets exactly it). ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const desired = new Set(indicators);

    for (const [name, paneId] of [...indicatorPanesRef.current]) {
      if (!desired.has(name)) {
        chart.removeIndicator(paneId, name);
        indicatorPanesRef.current.delete(name);
      }
    }
    for (const name of indicators) {
      if (indicatorPanesRef.current.has(name)) continue;
      const def = INDICATOR_BY_NAME.get(name);
      if (!def) continue;
      const paneId = chart.createIndicator(
        name,
        def.overlay,
        def.overlay ? { id: "candle_pane" } : { id: `${name.toLowerCase()}_pane` },
      );
      if (typeof paneId === "string") indicatorPanesRef.current.set(name, paneId);
    }
  }, [indicators]);

  // Close whichever dropdown menu is open on an outside click / Escape.
  useEffect(() => {
    if (!indicatorMenuOpen && !obMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (!indicatorMenuRef.current?.contains(ev.target as Node)) setIndicatorMenuOpen(false);
      if (!obMenuRef.current?.contains(ev.target as Node)) setObMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setIndicatorMenuOpen(false);
        setObMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [indicatorMenuOpen, obMenuOpen]);

  // --- Structure overlays: fetch the auto-detected order blocks / breakers
  // / FVGs for each enabled detection timeframe and (re)draw them as one
  // klinecharts overlay group. Keyed on dataEpoch so it (re)draws only
  // after applyNewData has put the current series on the chart - covers
  // the initial load and every interval switch - plus config changes and
  // a slow timer to pick up newly-formed structure. Everything for the
  // symbol lives under one groupId so a refresh is a clean remove-then-add. ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !resolved || dataEpoch === 0) return;
    let cancelled = false;
    const ex = resolved.chart_exchange;
    const sym = resolved.chart_symbol;
    const { tfs, breakers, fvg, breaks, setups } = structure;

    if (tfs.length === 0) {
      chart.removeOverlay({ groupId: OB_GROUP_ID });
      setTrendByTf({});
      return;
    }

    async function refresh() {
      const batches: { label: string; tf: string; data: ChartStructure }[] = [];
      for (const tf of tfs) {
        const def = OB_TIMEFRAMES.find((t) => t.value === tf);
        if (!def) continue;
        const to = new Date();
        const from = new Date(to.getTime() - def.lookbackDays * 86_400_000);
        try {
          const data = await fetchChartStructure(ex, sym, tf, ymd(from), ymd(to), { breakers, fvg, setups });
          if (cancelled) return;
          batches.push({ label: def.label, tf, data });
        } catch {
          // this timeframe failed this round - keep the others, retry next refresh
        }
      }
      if (cancelled) return;
      setTrendByTf(Object.fromEntries(batches.map((b) => [b.tf, b.data.trend])));
      chart!.removeOverlay({ groupId: OB_GROUP_ID });
      for (const { label, data } of batches) {
        for (const f of data.fvgs) {
          const anchor = Date.parse(f.origin_timestamp);
          if (!Number.isFinite(anchor)) continue;
          chart!.createOverlay({
            name: "htfFvg",
            groupId: OB_GROUP_ID,
            points: [{ timestamp: anchor, value: f.top }],
            extendData: { kind: f.kind, top: f.top, bottom: f.bottom, filled: f.filled },
          });
        }
        for (const z of data.order_blocks) {
          const anchor = Date.parse(z.origin_timestamp);
          if (!Number.isFinite(anchor)) continue;
          chart!.createOverlay({
            name: "htfOrderBlock",
            groupId: OB_GROUP_ID,
            points: [{ timestamp: anchor, value: z.proximal }],
            extendData: {
              tf: label,
              kind: z.kind,
              role: z.role,
              proximal: z.proximal,
              distal: z.distal,
              mitigated: z.mitigated,
              counterTrend: z.counter_trend,
            },
          });
        }
        if (breaks) {
          for (const e of data.events) {
            const anchor = Date.parse(e.timestamp);
            if (!Number.isFinite(anchor)) continue;
            chart!.createOverlay({
              name: "htfStructureBreak",
              groupId: OB_GROUP_ID,
              points: [{ timestamp: anchor, value: e.price }],
              extendData: { tf: label, kind: e.kind, direction: e.direction, price: e.price },
            });
          }
        }
        for (const s of data.setups) {
          const left = Date.parse(s.confirmed_timestamp);
          if (!Number.isFinite(left)) continue;
          const right = s.resolved_timestamp ? Date.parse(s.resolved_timestamp) : Date.now();
          chart!.createOverlay({
            name: "htfSetup",
            groupId: OB_GROUP_ID,
            points: [
              { timestamp: left, value: s.entry },
              { timestamp: Number.isFinite(right) ? right : Date.now(), value: s.entry },
            ],
            extendData: {
              tf: label,
              direction: s.direction,
              status: s.status,
              entry: s.entry,
              stop: s.stop_loss,
              target: s.target,
              rr: s.risk_reward,
            },
          });
        }
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), OB_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [resolved, structure, dataEpoch]);

  // --- Resolve the typed underlying to a quotable chart symbol/exchange
  // (an MCX commodity or NSE index future doesn't quote under its bare
  // name - same resolveUnderlying every other watch path here uses). ---
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setStatus("loading");
    setErrorMsg(null);
    resolveUnderlying(segment, symbol.trim().toUpperCase())
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [segment, symbol]);

  // --- Load history, then keep the trailing edge live: poll LTP into a
  // synthetic still-forming bar, and refetch the completed series once
  // per interval (market-data caches a today-touching range for exactly
  // that long, so this mostly serves from cache). ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !resolved) return;

    const def = INTERVALS.find((i) => i.value === interval) ?? INTERVALS[1];
    const intervalMs = def.minutes * 60_000;
    const ex = resolved.chart_exchange;
    const sym = resolved.chart_symbol;

    let cancelled = false;
    // The newest completed bar already fed to the chart, and the
    // synthetic bar we roll from LTP ticks until the provider has the
    // real one. Anchored off real data (last completed ts + one
    // interval), never off epoch-floored wall clock - NSE 30m/60m bars
    // don't align to epoch-hour boundaries.
    let lastCompletedTs = 0;
    let liveBar: KLineData | null = null;

    async function loadHistory(initial: boolean) {
      const to = new Date();
      const from = new Date(to.getTime() - def.lookbackDays * 86_400_000);
      let candles: Candle[];
      try {
        candles = await fetchCandleHistory(ex, sym, interval, ymd(from), ymd(to));
      } catch (e) {
        if (!cancelled && initial) {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      if (cancelled) return;

      const bars = candles.map(toKLine).filter((b) => Number.isFinite(b.timestamp));
      if (bars.length === 0) {
        if (initial) {
          setStatus("error");
          setErrorMsg(`No candle history for ${sym} at ${def.label} - the market may be closed or the symbol unsupported.`);
        }
        return;
      }

      const newestClose = bars[bars.length - 1].close;
      if (initial) {
        chart!.setPriceVolumePrecision(pricePrecision(newestClose), 0);
        chart!.applyNewData(bars);
        loadDrawings(ex, sym);
        setStatus("ready");
        setErrorMsg(null);
        setDataEpoch((e) => e + 1);
      } else {
        // updateData appends when the timestamp is newer than the last
        // bar, replaces when equal - so a synthetic bar becomes its real
        // self here once the provider catches up.
        for (const b of bars) {
          if (b.timestamp >= lastCompletedTs) chart!.updateData(b);
        }
      }
      lastCompletedTs = bars[bars.length - 1].timestamp;

      // Re-arm the synthetic bar just past the newest completed one -
      // unless that anchor is already stale (market closed, or a data
      // gap like the lunch break), in which case show no phantom bar.
      if (Date.now() - lastCompletedTs < 2 * intervalMs) {
        liveBar = {
          timestamp: lastCompletedTs + intervalMs,
          open: newestClose,
          high: newestClose,
          low: newestClose,
          close: newestClose,
          volume: 0,
        };
        chart!.updateData(liveBar);
      } else {
        liveBar = null;
      }
    }

    async function tickLtp() {
      if (cancelled || !liveBar) return;
      let ltp: number;
      try {
        ltp = await fetchLtp(ex, sym);
      } catch {
        return; // transient - retry next tick
      }
      if (cancelled || !liveBar) return;
      setLastPrice(ltp);

      if (Date.now() >= liveBar.timestamp + intervalMs) {
        // This synthetic bar's window has elapsed - pull the real one
        // (and re-arm the next synthetic bar) instead of stretching it.
        void loadHistory(false);
        return;
      }
      liveBar = {
        ...liveBar,
        high: Math.max(liveBar.high, ltp),
        low: Math.min(liveBar.low, ltp),
        close: ltp,
      };
      chart!.updateData(liveBar);
    }

    void loadHistory(true);
    const ltpTimer = window.setInterval(tickLtp, LTP_POLL_MS);
    // Floor at 60s so a 1m chart doesn't hammer the provider on every
    // tick (the server cache's TTL for a today-touching range is the
    // interval's own minutes anyway).
    const histTimer = window.setInterval(() => void loadHistory(false), Math.max(intervalMs, 60_000));

    return () => {
      cancelled = true;
      window.clearInterval(ltpTimer);
      window.clearInterval(histTimer);
    };
  }, [resolved, interval]);

  return (
    <div className="live-chart-panel">
      <div className="live-chart-toolbar">
        <div className="live-chart-toolbar-left">
          <div className="live-chart-intervals">
            {INTERVALS.map((i) => (
              <button
                key={i.value}
                type="button"
                className={i.value === interval ? "active" : ""}
                onClick={() => pickInterval(i.value)}
              >
                {i.label}
              </button>
            ))}
          </div>

          <div className="live-chart-indicators" ref={indicatorMenuRef}>
            <button
              type="button"
              className={indicatorMenuOpen ? "active" : ""}
              onClick={() => setIndicatorMenuOpen((o) => !o)}
            >
              Indicators{indicators.length > 0 ? ` (${indicators.length})` : ""} ▾
            </button>
            {indicatorMenuOpen && (
              <div className="live-chart-indicators-menu">
                <div className="live-chart-indicators-group">On price</div>
                {INDICATORS.filter((i) => i.overlay).map((i) => (
                  <label key={i.name}>
                    <input type="checkbox" checked={indicators.includes(i.name)} onChange={() => toggleIndicator(i.name)} />
                    {i.label}
                  </label>
                ))}
                <div className="live-chart-indicators-group">Lower pane</div>
                {INDICATORS.filter((i) => !i.overlay).map((i) => (
                  <label key={i.name}>
                    <input type="checkbox" checked={indicators.includes(i.name)} onChange={() => toggleIndicator(i.name)} />
                    {i.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="live-chart-indicators" ref={obMenuRef}>
            <button type="button" className={obMenuOpen ? "active" : ""} onClick={() => setObMenuOpen((o) => !o)}>
              Structure{structure.tfs.length > 0 ? ` (${structure.tfs.length})` : ""} ▾
            </button>
            {obMenuOpen && (
              <div className="live-chart-indicators-menu">
                <div className="live-chart-indicators-group">Detection timeframe</div>
                {OB_TIMEFRAMES.map((t) => {
                  const on = structure.tfs.includes(t.value);
                  const tr = on ? trendByTf[t.value] : undefined;
                  return (
                    <label key={t.value}>
                      <input type="checkbox" checked={on} onChange={() => toggleStructureTf(t.value)} />
                      {t.label} order blocks
                      {tr && (
                        <span className={`live-chart-trend live-chart-trend-${tr}`}>
                          {tr === "up" ? "▲ up" : tr === "down" ? "▼ down" : "– range"}
                        </span>
                      )}
                    </label>
                  );
                })}
                <div className="live-chart-indicators-group">Also show</div>
                <label>
                  <input
                    type="checkbox"
                    checked={structure.breakers}
                    onChange={() => updateStructure({ breakers: !structure.breakers })}
                  />
                  Breaker blocks
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={structure.fvg}
                    onChange={() => updateStructure({ fvg: !structure.fvg })}
                  />
                  Fair value gaps
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={structure.breaks}
                    onChange={() => updateStructure({ breaks: !structure.breaks })}
                  />
                  Structure breaks (BOS / CHoCH)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={structure.setups}
                    onChange={() => updateStructure({ setups: !structure.setups })}
                  />
                  Trade setups (entry / SL / target)
                </label>
                <div className="live-chart-indicators-hint">
                  Auto-detected structure — drawn at the chosen timeframe regardless of the chart's interval. Dashed
                  border = tested; thick border = breaker; amber band = FVG; faded = counter-trend or a resolved setup.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="live-chart-meta">
          {resolved && <span className="live-chart-symbol">{resolved.chart_exchange}:{resolved.chart_symbol}</span>}
          {lastPrice != null && <span className="live-chart-ltp">{lastPrice.toFixed(pricePrecision(lastPrice))}</span>}
        </div>
      </div>

      <div className="live-chart-drawtools">
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.overlay}
            type="button"
            title={t.title}
            className={activeTool === t.overlay ? "active" : ""}
            disabled={status !== "ready"}
            onClick={() => startDrawing(t.overlay)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="live-chart-drawtools-clear"
          title="Remove all drawings on this symbol"
          disabled={status !== "ready"}
          onClick={clearDrawings}
        >
          Clear
        </button>
        <span className="live-chart-drawtools-hint">click a drawing then Delete, or right-click it</span>
      </div>

      <div className="live-chart-canvas-wrap">
        <div ref={containerRef} className="live-chart-canvas" />
        {status !== "ready" && (
          <div className="live-chart-overlay">
            {status === "error" ? (
              <p className="error">{errorMsg ?? "Could not load the chart."}</p>
            ) : (
              <p className="muted">Loading {symbol}...</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

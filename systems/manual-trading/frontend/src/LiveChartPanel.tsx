import { useEffect, useRef, useState } from "react";

import {
  IndicatorSeries,
  dispose,
  init,
  registerIndicator,
  registerOverlay,
  type Chart,
  type DeepPartial,
  type KLineData,
  type Overlay,
  type OverlayEvent,
  type Styles,
} from "klinecharts";

import { TrashIcon } from "./Icons";
import { BUILDUP_META } from "./OiSummaryPage";
import {
  type Candle,
  type ChartStructure,
  type FutureContract,
  type OiBuildup,
  type OiSummary,
  type ResolvedUnderlying,
  type SentimentHistoryPoint,
  fetchCandleHistory,
  fetchChartStructure,
  fetchFutureContracts,
  fetchLtp,
  fetchOiSummary,
  fetchOptionExpiries,
  fetchSentimentHistory,
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
// A horizontal line at an option strike where OI has accumulated -
// resistance from call OI above spot, support from put OI below. `rank` 1
// = the biggest wall on that side (drawn bold), 2 = the next (lighter).
// `forming` = the strike where OI is *building fastest* right now (largest
// positive 15m OI change), drawn dashed as an in-progress level.
const OI_GROUP_ID = "oi-levels";
type OiLevelExtendData = {
  kind: "resistance" | "support";
  rank: 1 | 2;
  forming: boolean;
  price: number;
  label: string;
};

registerOverlay({
  name: "htfOrderBlock",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
    const d = overlay.extendData as ObExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    if (!Number.isFinite(leftX)) return [];
    const rightX = bounding.width;
    if (rightX <= leftX) return [];
    const yA = yAxis.convertToPixel(d.proximal);
    const yB = yAxis.convertToPixel(d.distal);
    const top = Math.min(yA, yB);
    const height = Math.max(1, Math.abs(yA - yB));
    const breaker = d.role === "breaker";
    // Counter-trend zones (opposing the structure trend) are dimmed so
    // the with-trend zones you'd actually trade from stand out.
    const dim = d.counterTrend ? 0.45 : 1;
    const rgb = d.kind === "demand" ? "62, 207, 142" : "232, 88, 106";
    const stroke = `rgba(${rgb}, ${0.85 * dim})`;
    const fill = `rgba(${rgb}, ${(breaker ? 0.22 : 0.16) * dim})`;
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
        // Label right-aligned against the price axis, not at the origin
        // bar (which for an HTF zone sits days off the left edge, dumping
        // the text on top of the oldest candles). The band already
        // extends to `rightX` every frame, so the label rides that edge.
        type: "text",
        attrs: { x: rightX - 4, y: top + 2, text: label, baseline: "top", align: "right" },
        styles: {
          color: `rgba(${rgb}, 1)`,
          size: 10,
          backgroundColor: "rgba(15, 18, 22, 0.78)",
          paddingLeft: 3,
          paddingRight: 3,
          paddingTop: 1,
          paddingBottom: 1,
          borderRadius: 2,
        },
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
    if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
    const d = overlay.extendData as BreakExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    if (!Number.isFinite(leftX)) return [];
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
        attrs: { x: rightX - 4, y: y - 13, text: `${d.tf} ${d.kind.toUpperCase()} ${d.direction === "up" ? "▲" : "▼"}`, baseline: "top", align: "right" },
        styles: {
          color,
          size: 10,
          backgroundColor: "rgba(15, 18, 22, 0.78)",
          paddingLeft: 3,
          paddingRight: 3,
          paddingTop: 1,
          paddingBottom: 1,
          borderRadius: 2,
        },
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
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    // Defensive: a live setup is a 1-point overlay that extends to the
    // pane's right edge (like htfOrderBlock); a resolved one has a real
    // 2nd anchor. Bail on anything non-finite - a throw here breaks
    // klinecharts' whole render loop (candles included).
    if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
    const d = overlay.extendData as SetupExtendData | undefined;
    if (!d) return [];
    const x0 = coordinates[0].x;
    if (!Number.isFinite(x0)) return [];
    const x1raw =
      coordinates.length >= 2 && coordinates[1] && Number.isFinite(coordinates[1].x)
        ? coordinates[1].x
        : bounding.width;
    const x1 = Math.max(x1raw, x0 + 2);
    const yE = yAxis.convertToPixel(d.entry);
    const yS = yAxis.convertToPixel(d.stop);
    const yT = yAxis.convertToPixel(d.target);
    if (!Number.isFinite(yE) || !Number.isFinite(yS) || !Number.isFinite(yT)) return [];
    const live = d.status === "confirmed" || d.status === "triggered";
    const a = live ? 1 : 0.55;
    const red = `rgba(232, 88, 106, ${0.9 * a})`;
    const green = `rgba(62, 207, 142, ${0.9 * a})`;
    const neutral = `rgba(230, 233, 238, ${a})`;
    const label = `${d.tf} ${d.direction} · ${d.status} · ${Number.isFinite(d.rr) ? d.rr.toFixed(1) : "?"}R`;
    return [
      {
        type: "rect",
        attrs: { x: x0, y: Math.min(yE, yS), width: x1 - x0, height: Math.max(1, Math.abs(yE - yS)) },
        styles: { style: "fill", color: `rgba(232, 88, 106, ${0.16 * a})` },
        ignoreEvent: true,
      },
      {
        type: "rect",
        attrs: { x: x0, y: Math.min(yE, yT), width: x1 - x0, height: Math.max(1, Math.abs(yE - yT)) },
        styles: { style: "fill", color: `rgba(62, 207, 142, ${0.16 * a})` },
        ignoreEvent: true,
      },
      {
        type: "line",
        attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] },
        styles: { color: neutral, size: 1.5, style: d.status === "triggered" ? "solid" : "dashed" },
        ignoreEvent: true,
      },
      { type: "line", attrs: { coordinates: [{ x: x0, y: yS }, { x: x1, y: yS }] }, styles: { color: red, size: 1.5 }, ignoreEvent: true },
      { type: "line", attrs: { coordinates: [{ x: x0, y: yT }, { x: x1, y: yT }] }, styles: { color: green, size: 1.5 }, ignoreEvent: true },
      {
        type: "text",
        // Right-aligned to the end of the setup's own span (the
        // resolution bar, or the axis edge while live), clear of the
        // entry/stop/target lines on the left.
        attrs: { x: x1 - 3, y: Math.min(yE, yS, yT) - 15, text: label, baseline: "top", align: "right" },
        styles: {
          color: neutral,
          size: 11,
          weight: "bold",
          backgroundColor: "rgba(15, 18, 22, 0.82)",
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 1,
          paddingBottom: 1,
          borderRadius: 3,
          borderColor: neutral,
          borderSize: 1,
        },
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
    if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
    const d = overlay.extendData as FvgExtendData | undefined;
    if (!d) return [];
    const leftX = coordinates[0].x;
    if (!Number.isFinite(leftX)) return [];
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

// OI-derived support / resistance - a full-width horizontal line at the
// strike, redrawn each OI poll. Resistance red, support green. The rank-1
// wall on each side is drawn bold (3px + a translucent glow band); rank-2
// is a thinner line. A `forming` level is dashed.
registerOverlay({
  name: "htfOiLevel",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, bounding, yAxis }) => {
    if (!yAxis) return [];
    const d = overlay.extendData as OiLevelExtendData | undefined;
    if (!d) return [];
    const y = yAxis.convertToPixel(d.price);
    const rgb = d.kind === "resistance" ? "232, 88, 106" : "62, 207, 142";
    const primary = d.rank === 1 && !d.forming;
    const lineAlpha = d.forming ? 0.55 : d.rank === 1 ? 1 : 0.7;
    return [
      // A soft glow band behind the rank-1 wall so it reads at a glance.
      ...(primary
        ? [
            {
              type: "rect",
              attrs: { x: 0, y: y - 3, width: bounding.width, height: 6 },
              styles: { style: "fill", color: `rgba(${rgb}, 0.14)` },
              ignoreEvent: true,
            },
          ]
        : []),
      {
        type: "line",
        attrs: {
          coordinates: [
            { x: 0, y },
            { x: bounding.width, y },
          ],
        },
        styles: {
          color: `rgba(${rgb}, ${lineAlpha})`,
          size: d.forming ? 1 : d.rank === 1 ? 3 : 1.5,
          style: d.forming ? "dashed" : "solid",
        },
        ignoreEvent: true,
      },
      {
        type: "text",
        attrs: { x: bounding.width - 4, y: y - (primary ? 16 : 13), text: d.label, baseline: "top", align: "right" },
        styles: {
          color: `rgba(${rgb}, 1)`,
          size: primary ? 12 : 10,
          weight: primary ? "bold" : "normal",
          backgroundColor: "rgba(15, 18, 22, 0.82)",
          borderColor: `rgba(${rgb}, ${primary ? 0.9 : 0})`,
          borderSize: primary ? 1 : 0,
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 1,
          paddingBottom: 1,
          borderRadius: 3,
        },
        ignoreEvent: true,
      },
    ];
  },
});

// Supertrend - not a klinecharts built-in, registered here. calcParams
// are [ATR period, multiplier]; both editable via the Indicators menu's
// params box. Drawn as two lines on the candle pane - a green one while
// price is above the trend (uptrend) and a red one while below - so the
// trend flip reads as the colour handing off. ATR is Wilder-smoothed.
type SupertrendPoint = { up?: number; down?: number };
registerIndicator<SupertrendPoint>({
  name: "SUPERTREND",
  shortName: "Supertrend",
  series: IndicatorSeries.Price,
  calcParams: [10, 3],
  precision: 2,
  shouldOhlc: true,
  figures: [
    { key: "up", title: "up: ", type: "line", styles: () => ({ color: BUY }) },
    { key: "down", title: "down: ", type: "line", styles: () => ({ color: SELL }) },
  ],
  regenerateFigures: null,
  calc: (dataList, indicator) => {
    const [rawPeriod, rawMult] = indicator.calcParams as number[];
    const period = Math.max(1, Math.round(rawPeriod || 10));
    const mult = rawMult > 0 ? rawMult : 3;
    const n = dataList.length;
    const out: SupertrendPoint[] = new Array(n);
    if (n === 0) return out;

    // Wilder ATR.
    const atr: number[] = new Array(n);
    let trSum = 0;
    let prevAtr = 0;
    for (let i = 0; i < n; i++) {
      const k = dataList[i];
      const prevClose = i > 0 ? dataList[i - 1].close : k.close;
      const tr = Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
      if (i < period) {
        trSum += tr;
        atr[i] = trSum / (i + 1);
        prevAtr = atr[i];
      } else {
        prevAtr = (prevAtr * (period - 1) + tr) / period;
        atr[i] = prevAtr;
      }
    }

    let upperBand = 0;
    let lowerBand = 0;
    let uptrend = true;
    for (let i = 0; i < n; i++) {
      const k = dataList[i];
      const hl2 = (k.high + k.low) / 2;
      const basicUpper = hl2 + mult * atr[i];
      const basicLower = hl2 - mult * atr[i];
      const prevClose = i > 0 ? dataList[i - 1].close : k.close;

      upperBand = i === 0 || basicUpper < upperBand || prevClose > upperBand ? basicUpper : upperBand;
      lowerBand = i === 0 || basicLower > lowerBand || prevClose < lowerBand ? basicLower : lowerBand;

      if (i === 0) {
        uptrend = k.close >= hl2;
      } else if (k.close > upperBand) {
        uptrend = true;
      } else if (k.close < lowerBand) {
        uptrend = false;
      }

      const value = uptrend ? lowerBand : upperBand;
      out[i] = uptrend ? { up: value } : { down: value };
    }
    return out;
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
// Picked future contract, per underlying: `${CONTRACT_STORAGE_KEY}:NIFTY`
// -> the trading symbol. Only a non-default pick is stored (the default -
// spot for an index, near contract for a commodity - is the absence of a
// key).
const CONTRACT_STORAGE_KEY = "manualLiveChartContract";
const INDICATORS_STORAGE_KEY = "manualLiveChartIndicators";
const INDICATOR_PARAMS_STORAGE_KEY = "manualLiveChartIndicatorParams";
// Palette eye-toggles: hide the drawn overlays / the indicators without
// forgetting which ones are on (the menu checkboxes stay set). Global,
// like the interval - a "clean chart" preference, not per-symbol.
const DRAWINGS_HIDDEN_STORAGE_KEY = "manualLiveChartDrawingsHidden";
const INDICATORS_HIDDEN_STORAGE_KEY = "manualLiveChartIndicatorsHidden";

// klinecharts' own built-in indicator names. `overlay: true` draws on the
// candle pane (stacked, so several can coexist); the rest each get their
// own lower pane. This is a curated subset of the ~25 klinecharts ships -
// the ones a discretionary trader actually reaches for. `params` (where
// present) is klinecharts' own default calcParams AND marks the indicator
// as having an editable period list in the menu - a plain comma-list of
// lookback lengths (VOL's MA overlays, MA/EMA periods, RSI windows, ...);
// clearing it to empty drops those lines (VOL then shows bare bars).
// BOLL/SAR are left out - their params aren't a period list (period +
// multiplier / accel factors), editing them raw would just confuse.
// SUPERTREND is our own (registerIndicator below), not a klinecharts
// built-in - its params are [ATR period, multiplier], the multiplier is
// commonly fractional (2.5 / 3).
const INDICATORS: { name: string; label: string; overlay: boolean; params?: number[] }[] = [
  { name: "MA", label: "MA · moving average", overlay: true, params: [5, 10, 30, 60] },
  { name: "EMA", label: "EMA · exp. moving average", overlay: true, params: [6, 12, 20] },
  { name: "SUPERTREND", label: "Supertrend · ATR period, multiplier", overlay: true, params: [10, 3] },
  { name: "BOLL", label: "Bollinger Bands", overlay: true },
  { name: "SAR", label: "Parabolic SAR", overlay: true },
  { name: "BBI", label: "BBI", overlay: true, params: [3, 6, 12, 24] },
  { name: "VOL", label: "Volume", overlay: false, params: [5, 10, 20] },
  { name: "MACD", label: "MACD", overlay: false, params: [12, 26, 9] },
  { name: "RSI", label: "RSI", overlay: false, params: [6, 12, 24] },
  { name: "KDJ", label: "KDJ · stochastic", overlay: false, params: [9, 3, 3] },
  { name: "CCI", label: "CCI", overlay: false, params: [13] },
  { name: "DMI", label: "DMI / ADX", overlay: false, params: [14, 6] },
  { name: "WR", label: "Williams %R", overlay: false, params: [6, 10] },
  { name: "OBV", label: "OBV", overlay: false, params: [30] },
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

// Per-indicator calcParams overrides - only names that differ from the
// klinecharts default are stored (an empty array IS a meaningful override:
// "no MA lines").
function loadIndicatorParams(): Record<string, number[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(INDICATOR_PARAMS_STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const out: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (INDICATOR_BY_NAME.get(k)?.params && Array.isArray(v) && v.every((n) => typeof n === "number")) {
          out[k] = v as number[];
        }
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

// "5, 10, 20" -> [5, 10, 20]; a blank field -> [] (drop the lines).
function parseParamList(s: string): number[] {
  // Floats allowed - Supertrend's multiplier is routinely 2.5 / 3.5;
  // period-style params are just typed as whole numbers anyway.
  return s
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 500)
    .map((n) => Math.round(n * 100) / 100);
}

// The calcParams to actually hand klinecharts for an indicator: the
// override if one is stored (empty array included), else its own default.
function effectiveParams(name: string, overrides: Record<string, number[]>): number[] | undefined {
  if (name in overrides) return overrides[name];
  return INDICATOR_BY_NAME.get(name)?.params;
}

const ORDER_BLOCKS_STORAGE_KEY = "manualLiveChartOrderBlocks";

// The assets OiSummaryPage (the shell's "OI" tab) actually has a preset
// for - only these four get an "OI Analysis" jump link in the chart
// header (crypto has no option-chain / OI feed). Keep in sync with
// OiSummaryPage's PRESETS.
const OI_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "GOLDM", "CRUDEOILM"]);

// Ask the shell to switch to its "OI" tab, pre-selected to this asset -
// same jump the header sentiment badges do (shell's goToOiTab), just
// requested from inside the Intraday iframe. No-op when not embedded.
function openOiAnalysis(symbol: string) {
  if (window.parent === window) return;
  window.parent.postMessage(
    { source: "algo-trading-app", type: "navigate-oi", symbol: symbol.trim().toUpperCase() },
    "*",
  );
}

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

// --- Setup alerts. When a structure refresh surfaces a new planned
// (`confirmed`) or live (`triggered`) setup, we show a strip above the
// chart and - if the user opted in - play a tune + fire a desktop
// notification. Opt-in is persisted; default on. The tune is a 4-note
// ascending arpeggio, synthesized with a Web Audio oscillator the same
// way the shell's signal/sentiment chimes are (2 and 3 notes there, 4
// here, so which one fired is obvious by note count alone). Deliberately
// a self-contained copy rather than a shared dependency on the shell -
// same call the repo already makes for its duplicated SignalNotifier. ---
const ALERTS_STORAGE_KEY = "manualLiveChartSetupAlerts";
const SETUP_TUNE_HZ = [587.33, 784.0, 987.77, 1174.66]; // D5 - G5 - B5 - D6
const MAX_ALERT_ROWS = 4;

type LiveSetup = {
  // Stable across a confirmed -> triggered transition (no `status`), so
  // the strip keeps one row for the setup as it advances.
  key: string;
  tf: string;
  direction: "long" | "short";
  status: "confirmed" | "triggered";
  entry: number;
  stop: number;
  target: number;
  rr: number;
};

function loadAlertsOn(): boolean {
  return localStorage.getItem(ALERTS_STORAGE_KEY) !== "false";
}

// --- OI strip. Only the 4 SENTIMENT_UNDERLYINGS carry an option chain on
// this platform's providers (same 4 OiSummaryPage hardcodes); for every
// other symbol - all of CRYPTO included - the strip just doesn't render.
// Reuses the panel's existing `resolved` (chart_symbol/chart_exchange is
// exactly what GET /options/expiries + /oi-summary want - an index
// resolves to itself, an MCX commodity to its active-month future, same
// as OiSummaryPage). No 1h history - PCR + the 5m/15m deltas market-data
// already tracks in memory, polled on the OI cadence. ---
const OI_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "GOLDM", "CRUDEOILM"]);
const OI_POLL_MS = 60_000;

const OI_BUILDUP_LABEL: Record<OiBuildup, string> = {
  long_buildup: "long buildup",
  short_buildup: "short buildup",
  short_covering: "short covering",
  long_unwinding: "long unwinding",
};

// Indian-numbering compact form (K/L/Cr) - a NIFTY total-OI figure runs
// to several crore; a wall of digits otherwise. Copy of OiSummaryPage's
// fmtCompactIndian (small enough to duplicate, same call the repo makes
// for SignalNotifier).
function fmtCompactIndian(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// A signed OI delta as a rough % of the current total, e.g. "▲0.8%".
function fmtOiDeltaPct(change: number | null, total: number): string {
  if (change == null || total <= 0) return "–";
  const pct = (change / total) * 100;
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "·";
  return `${arrow}${Math.abs(pct).toFixed(1)}%`;
}

// OI-derived support / resistance. Resistance = the biggest call-OI
// strikes AT OR ABOVE spot (call writers defend them - a big call-OI
// strike *below* spot is already breached, not resistance); support = the
// biggest put-OI strikes at or below spot. Constraining each side to its
// own half of the chain is what stops both from collapsing onto the same
// near-ATM round strike (which routinely carries the chain's largest OI
// on BOTH sides). The two biggest on each side are returned (`rank` 1/2).
// `forming` is the strike where OI is accumulating fastest right now
// (largest positive 15m OI change on that side) - a level building, not
// yet a standing wall; null until change data warms up.
type OiLevel = {
  kind: "resistance" | "support";
  rank: 1 | 2;
  forming: boolean;
  strike: number;
  oi: number;
  oiChange: number | null;
};

function computeOiLevels(oi: OiSummary): OiLevel[] {
  const spot = oi.underlying_last_price;
  const calls: { strike: number; oi: number }[] = [];
  const puts: { strike: number; oi: number }[] = [];
  let resForm: { strike: number; chg: number } | null = null;
  let supForm: { strike: number; chg: number } | null = null;
  for (const s of oi.strikes) {
    if (s.call && s.strike >= spot) {
      calls.push({ strike: s.strike, oi: s.call.oi });
      const c = s.call.oi_change_15m ?? 0;
      if (c > 0 && (!resForm || c > resForm.chg)) resForm = { strike: s.strike, chg: c };
    }
    if (s.put && s.strike <= spot) {
      puts.push({ strike: s.strike, oi: s.put.oi });
      const c = s.put.oi_change_15m ?? 0;
      if (c > 0 && (!supForm || c > supForm.chg)) supForm = { strike: s.strike, chg: c };
    }
  }
  calls.sort((a, b) => b.oi - a.oi);
  puts.sort((a, b) => b.oi - a.oi);

  const out: OiLevel[] = [];
  calls.slice(0, 2).forEach((c, i) =>
    out.push({ kind: "resistance", rank: (i + 1) as 1 | 2, forming: false, strike: c.strike, oi: c.oi, oiChange: null }),
  );
  puts.slice(0, 2).forEach((p, i) =>
    out.push({ kind: "support", rank: (i + 1) as 1 | 2, forming: false, strike: p.strike, oi: p.oi, oiChange: null }),
  );
  const resStrikes = new Set(calls.slice(0, 2).map((c) => c.strike));
  const supStrikes = new Set(puts.slice(0, 2).map((p) => p.strike));
  if (resForm && !resStrikes.has(resForm.strike))
    out.push({ kind: "resistance", rank: 2, forming: true, strike: resForm.strike, oi: 0, oiChange: resForm.chg });
  if (supForm && !supStrikes.has(supForm.strike))
    out.push({ kind: "support", rank: 2, forming: true, strike: supForm.strike, oi: 0, oiChange: supForm.chg });
  return out;
}

const OI_LEVELS_STORAGE_KEY = "manualLiveChartOiLevels";

// How many recent sentiment-history points the OI strip's mini-trend
// shows (5-min cadence, so ~10 covers the last ~50 min).
const SENT_HIST_WINDOW = 10;

// Whether the step INTO point i (vs point i-1) is a "major" OI-shift move:
// the score crossed zero (positioning flipped side), or the jump is both
// absolute-large and large relative to the window's typical step.
// `score` prefers the 15m OI-shift but falls back to 5m - the 15m figure
// goes null whenever market-data's OI-history buffer can't reach back a
// full 15 min (a fresh backend, or a thin-history session), and without
// the fallback the strip would just freeze on the last 15m reading.
type SentStep = { pt: SentimentHistoryPoint; score: number; win: "15m" | "5m"; major: boolean };

function sentimentSteps(points: SentimentHistoryPoint[]): SentStep[] {
  const scored = points
    .map((p) => {
      const s = p.score_15m ?? p.score_5m;
      return s == null ? null : { pt: p, score: s, win: (p.score_15m != null ? "15m" : "5m") as "15m" | "5m" };
    })
    .filter((x): x is { pt: SentimentHistoryPoint; score: number; win: "15m" | "5m" } => x != null)
    .slice(-SENT_HIST_WINDOW);
  const deltas: number[] = [];
  for (let i = 1; i < scored.length; i++) deltas.push(Math.abs(scored[i].score - scored[i - 1].score));
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return scored.map((p, i) => {
    if (i === 0) return { ...p, major: false };
    const prev = scored[i - 1].score;
    const jump = Math.abs(p.score - prev);
    const flipped = Math.sign(p.score) !== Math.sign(prev) && Math.abs(p.score) > 0.05 && Math.abs(prev) > 0.05;
    const big = jump >= Math.max(0.15, 2 * median);
    return { ...p, major: flipped || big };
  });
}

function scoreColor(score: number): string {
  if (Math.abs(score) < 0.02) return "var(--text-dim)";
  return score > 0 ? "var(--buy)" : "var(--sell)";
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

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

// Drawing-tool glyphs for the vertical palette down the left edge of the
// chart - line-diagram icons, same stroke convention as Icons.tsx /
// WorkspacePage's own inline icons but a touch larger (18px) since
// they're the button's only content (labels are on title/aria-label).
// Plain function components, not a JSX-object const, matching the
// PlusIcon/ReviewIcon pattern already used across this codebase.
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 18,
  height: 18,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function TrendLineIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="4" y1="19" x2="20" y2="5" />
      <circle cx="4" cy="19" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="20" cy="5" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}
function RayIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="4" cy="20" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="20" x2="20" y2="4" />
      <polyline points="13 4 20 4 20 11" />
    </svg>
  );
}
function HLineIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="7" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ZoneIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="4" y="7" width="16" height="10" rx="1.5" />
    </svg>
  );
}
function PriceLineIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="3" y1="12" x2="12" y2="12" />
      <rect x="12" y="8.5" width="9" height="7" rx="1.5" />
    </svg>
  );
}
function FibIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}
// Palette visibility toggles (not draw tools) - a scribble for "drawings"
// and a plot line for "indicators". The CSS `.is-hidden` state adds a
// slash + dims, so one glyph covers both shown/hidden.
function ScribbleIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 16c2 0 2-8 4-8s2 10 4 10 2-12 4-12 2 6 4 6 2-2 2-2" />
    </svg>
  );
}
function PlotLineIcon() {
  return (
    <svg {...ICON_PROPS}>
      <polyline points="3 13 8 13 11 5 14 19 17 11 21 11" />
    </svg>
  );
}
// klinecharts' own built-in overlay templates (no registration needed).
// Kept to the handful that matter for reading price structure and marking
// supply/demand zones - the full set (channels, vertical lines, tags, ...)
// is a longer list than a trading chart's toolbar wants. Rendered as an
// icon-only vertical palette down the left edge of the chart; each tool
// toggles (click again to cancel).
const DRAW_TOOLS: { overlay: string; title: string; Icon: () => JSX.Element }[] = [
  { overlay: "segment", title: "Trend line - click two points", Icon: TrendLineIcon },
  { overlay: "rayLine", title: "Ray - anchor, then direction", Icon: RayIcon },
  { overlay: "horizontalStraightLine", title: "Horizontal price line", Icon: HLineIcon },
  { overlay: "rect", title: "Rectangle - mark a supply/demand zone", Icon: ZoneIcon },
  { overlay: "priceLine", title: "Horizontal line with a price label", Icon: PriceLineIcon },
  { overlay: "fibonacciLine", title: "Fibonacci retracement", Icon: FibIcon },
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

// A future contract's expiry as a compact "Sep '26" for the picker.
function contractExpiryLabel(f: FutureContract): string {
  const d = new Date(f.expiry_date);
  if (Number.isNaN(d.getTime())) return f.trading_symbol;
  return `${d.toLocaleDateString(undefined, { month: "short" })} '${String(d.getFullYear()).slice(-2)}`;
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

function fmtPrice(p: number): string {
  return p.toFixed(pricePrecision(p));
}

type Status = "loading" | "ready" | "error";

export type IntervalTrend = { trend: "up" | "down" | "range" | null; interval: string };

export function LiveChartPanel({
  segment,
  symbol,
  onTrendChange,
}: {
  segment: string;
  symbol: string;
  // Fired with the confirmed structure trend for the *chart's own
  // interval* (null when structure detection isn't running on that
  // timeframe) - the trade panel uses it to optionally lock direction.
  onTrendChange?: (info: IntervalTrend) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  const [resolved, setResolved] = useState<ResolvedUnderlying | null>(null);
  // Future-contract picker (MCX commodities, NSE index futures). `futures`
  // is every not-yet-expired contract; `contract` is a user-picked
  // override of resolveUnderlying's default (null = the default - spot for
  // an index, active-month future for a commodity).
  const [futures, setFutures] = useState<FutureContract[]>([]);
  const [contract, setContract] = useState<FutureContract | null>(null);
  const [interval, setInterval_] = useState<string>(() => localStorage.getItem(INTERVAL_STORAGE_KEY) ?? "5min");
  // The exchange/symbol the CHART is on - a user-picked future contract
  // overrides resolveUnderlying's default (spot for an index, active-month
  // future for a commodity). OI / sentiment still key off the underlying
  // (`resolved`), not this.
  const chartExchange = contract?.exchange ?? resolved?.chart_exchange ?? null;
  const chartSymbol = contract?.trading_symbol ?? resolved?.chart_symbol ?? null;
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  // Palette eye-toggles - hide the drawings / indicators without clearing
  // them (see the two buttons at the foot of the drawing palette).
  const [drawingsHidden, setDrawingsHidden] = useState<boolean>(
    () => localStorage.getItem(DRAWINGS_HIDDEN_STORAGE_KEY) === "true",
  );
  const [indicatorsHidden, setIndicatorsHidden] = useState<boolean>(
    () => localStorage.getItem(INDICATORS_HIDDEN_STORAGE_KEY) === "true",
  );
  const [indicators, setIndicators] = useState<string[]>(loadIndicators);
  const [indicatorParams, setIndicatorParams] = useState<Record<string, number[]>>(loadIndicatorParams);
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const indicatorMenuRef = useRef<HTMLDivElement | null>(null);
  // Indicator name -> the pane id klinecharts created it on, so we can
  // remove exactly that one later (candle-pane overlays share "candle_pane").
  const indicatorPanesRef = useRef<Map<string, string>>(new Map());
  // Indicator name -> the calcParams last pushed to klinecharts, so the
  // reconcile effect only calls overrideIndicator when they actually change.
  const indicatorParamsAppliedRef = useRef<Map<string, string>>(new Map());
  // The live text in each params input, so a half-typed "5,1" doesn't get
  // parsed+applied on every keystroke - committed on blur / Enter.
  const [paramDrafts, setParamDrafts] = useState<Record<string, string>>({});

  const [structure, setStructure] = useState<StructureConfig>(loadStructureConfig);
  const [trendByTf, setTrendByTf] = useState<Record<string, "up" | "down" | "range">>({});
  const [obMenuOpen, setObMenuOpen] = useState(false);
  const obMenuRef = useRef<HTMLDivElement | null>(null);

  // OI summary for the strip under the chart - null unless the symbol is
  // one of the 4 OI underlyings and a reading has come back. `oiAt` is
  // when THIS client last got a fresh reading (the chain itself is
  // server-cached 30s and NSE only re-disseminates OI every ~3 min, so
  // this is a freshness upper bound, not a change timestamp).
  const [oi, setOi] = useState<OiSummary | null>(null);
  const [oiAt, setOiAt] = useState<number | null>(null);
  // Today's recent OI-sentiment history for the same underlying - the
  // strip's mini-trend of the last few 15m shift readings.
  const [sentHist, setSentHist] = useState<SentimentHistoryPoint[]>([]);
  // Draw the OI support/resistance levels on the price pane (opt-in).
  const [oiLevelsOn, setOiLevelsOn] = useState<boolean>(() => localStorage.getItem(OI_LEVELS_STORAGE_KEY) === "true");

  // Planned/live setups currently on the chart, for the strip above it.
  const [activeSetups, setActiveSetups] = useState<LiveSetup[]>([]);
  const [alertsOn, setAlertsOn] = useState<boolean>(loadAlertsOn);
  // The structure effect's closure captures alertsOn at creation and isn't
  // keyed on it, so read the live value through a ref.
  const alertsOnRef = useRef(alertsOn);
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  // Toggling the setups layer off then on shouldn't chime for every setup
  // that was already there - re-seed the diff on the next refresh.
  useEffect(() => {
    if (!structure.setups) seedSetupsRef.current = true;
  }, [structure.setups]);
  // `${key}|${status}` of every setup we've already chimed for. Reset when
  // the symbol changes or the setups layer is (re)enabled - the next
  // refresh then seeds this silently so we don't blast an alert per
  // pre-existing setup.
  const seenSetupsRef = useRef<Set<string>>(new Set());
  const seedSetupsRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
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
  // The id of an overlay that's mid-draw (tool armed, first point maybe
  // placed, not finished) - so re-clicking the same tool, or picking a
  // different one, can cancel it. Cleared once the draw completes.
  const pendingOverlayRef = useRef<string | null>(null);

  function pickInterval(value: string) {
    localStorage.setItem(INTERVAL_STORAGE_KEY, value);
    setInterval_(value);
    // Keep order-block detection pointed at the chart's own interval:
    // switching the chart timeframe re-detects structure at that same
    // timeframe rather than leaving an unrelated one selected. Only while
    // structure is actually on - an interval change never switches the
    // layer on by itself. INTERVALS and OB_TIMEFRAMES share one value
    // vocabulary, so `value` is always a valid detection timeframe.
    setStructure((prev) => {
      if (prev.tfs.length === 0) return prev;
      if (prev.tfs.length === 1 && prev.tfs[0] === value) return prev;
      const next = { ...prev, tfs: [value] };
      try {
        localStorage.setItem(ORDER_BLOCKS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage disabled - the change still applies this session
      }
      return next;
    });
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

  // Commit a params input (blur / Enter): parse it, and store an override
  // only when it differs from the indicator's own default - so resetting
  // to the default cleans the override out again.
  function commitIndicatorParam(name: string, text: string) {
    const def = INDICATOR_BY_NAME.get(name)?.params;
    if (!def) return;
    const parsed = parseParamList(text);
    setIndicatorParams((prev) => {
      const next = { ...prev };
      if (parsed.join(",") === def.join(",")) delete next[name];
      else next[name] = parsed;
      try {
        localStorage.setItem(INDICATOR_PARAMS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage disabled - still applies this session
      }
      return next;
    });
    setParamDrafts((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function renderIndicatorRow(i: (typeof INDICATORS)[number]) {
    const on = indicators.includes(i.name);
    const current = effectiveParams(i.name, indicatorParams) ?? [];
    const draft = paramDrafts[i.name];
    return (
      <div className="live-chart-indicator-row" key={i.name}>
        <label>
          <input type="checkbox" checked={on} onChange={() => toggleIndicator(i.name)} />
          {i.label}
        </label>
        {on && i.params && (
          <input
            className="live-chart-indicator-params"
            type="text"
            inputMode="numeric"
            title="Period list (comma-separated) - clear for no MA/period lines"
            placeholder={i.params.join(", ")}
            value={draft ?? current.join(", ")}
            onChange={(e) => setParamDrafts((prev) => ({ ...prev, [i.name]: e.target.value }))}
            onBlur={(e) => commitIndicatorParam(i.name, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        )}
      </div>
    );
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

  function toggleSetupAlerts() {
    setAlertsOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ALERTS_STORAGE_KEY, String(next));
      } catch {
        // storage disabled - the toggle still applies this session
      }
      if (next) {
        // This click is the user gesture that unlocks audio + lets us ask
        // for notification permission (the poll loop later has neither).
        try {
          const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Ctor) {
            audioCtxRef.current ??= new Ctor();
            void audioCtxRef.current.resume();
          }
        } catch {
          // audio unavailable - notifications/strip still work
        }
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission();
        }
      }
      return next;
    });
  }

  function playSetupTune() {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = (audioCtxRef.current ??= new Ctor());
      const now = ctx.currentTime;
      SETUP_TUNE_HZ.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = now + i * 0.13;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.13);
      });
    } catch {
      // audio blocked/unsupported - the strip (and any notification) still fired
    }
  }

  function notifySetup(s: LiveSetup) {
    playSetupTune();
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const n = new Notification(
          `${s.tf} ${s.direction.toUpperCase()} setup ${s.status === "triggered" ? "triggered" : "planned"}`,
          {
            body: `${resolved?.chart_symbol ?? symbol} · entry ${fmtPrice(s.entry)} · SL ${fmtPrice(s.stop)} · TP ${fmtPrice(s.target)} · ${s.rr.toFixed(1)}R`,
            tag: `setup-${s.key}`,
          },
        );
        n.onclick = () => window.focus();
      }
    } catch {
      // notifications unavailable in this context
    }
  }

  // Diff the just-fetched planned/live setups against what we've already
  // chimed for; alert on the genuinely new ones (a confirmed -> triggered
  // transition counts as new). The first pass after a symbol change or a
  // setups-layer (re)enable only seeds the seen-set, silently.
  function reconcileSetupAlerts(setups: LiveSetup[]) {
    const nextSeen = new Set(setups.map((s) => `${s.key}|${s.status}`));
    if (seedSetupsRef.current) {
      seedSetupsRef.current = false;
      seenSetupsRef.current = nextSeen;
      return;
    }
    const fresh = setups.filter((s) => !seenSetupsRef.current.has(`${s.key}|${s.status}`));
    seenSetupsRef.current = nextSeen;
    if (!alertsOnRef.current) return;
    for (const s of fresh) notifySetup(s);
  }

  function toggleOiLevels() {
    setOiLevelsOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OI_LEVELS_STORAGE_KEY, String(next));
      } catch {
        // storage disabled - still applies this session
      }
      return next;
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
        pendingOverlayRef.current = null;
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
        if (pendingOverlayRef.current === e.overlay.id) pendingOverlayRef.current = null;
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
    // Cancel whatever draw is currently armed (same tool re-clicked, or a
    // different one picked) - klinecharts leaves a half-placed overlay
    // otherwise.
    if (pendingOverlayRef.current) {
      chart.removeOverlay(pendingOverlayRef.current);
      pendingOverlayRef.current = null;
    }
    if (activeTool === name) {
      setActiveTool(null); // toggle off
      return;
    }
    setActiveTool(name);
    const id = chart.createOverlay({ name, ...overlayHandlers() });
    pendingOverlayRef.current = typeof id === "string" ? id : null;
  }

  function toggleDrawingsHidden() {
    setDrawingsHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(DRAWINGS_HIDDEN_STORAGE_KEY, String(next));
      } catch {
        /* private mode / quota - the toggle still works this session */
      }
      if (next) {
        // Can't draw onto a hidden layer - disarm any active tool and
        // drop a half-placed overlay.
        const chart = chartRef.current;
        if (chart && pendingOverlayRef.current) {
          chart.removeOverlay(pendingOverlayRef.current);
          pendingOverlayRef.current = null;
        }
        setActiveTool(null);
      }
      return next;
    });
  }

  function toggleIndicatorsHidden() {
    setIndicatorsHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(INDICATORS_HIDDEN_STORAGE_KEY, String(next));
      } catch {
        /* private mode / quota - the toggle still works this session */
      }
      return next;
    });
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
    // `indicatorsHidden` keeps the remembered set (the menu checkboxes
    // stay ticked) but pulls every pane off the chart; unhiding re-adds
    // them with their params. Simpler and cleaner than an empty pane.
    const wanted = indicatorsHidden ? [] : indicators;
    const desired = new Set(wanted);

    for (const [name, paneId] of [...indicatorPanesRef.current]) {
      if (!desired.has(name)) {
        chart.removeIndicator(paneId, name);
        indicatorPanesRef.current.delete(name);
        indicatorParamsAppliedRef.current.delete(name);
      }
    }
    for (const name of wanted) {
      const def = INDICATOR_BY_NAME.get(name);
      if (!def) continue;
      const calcParams = effectiveParams(name, indicatorParams);
      const paramKey = calcParams ? calcParams.join(",") : "";

      if (indicatorPanesRef.current.has(name)) {
        // Already on the chart - re-push calcParams only if they changed.
        if (calcParams && indicatorParamsAppliedRef.current.get(name) !== paramKey) {
          chart.overrideIndicator({ name, calcParams }, indicatorPanesRef.current.get(name));
          indicatorParamsAppliedRef.current.set(name, paramKey);
        }
        continue;
      }

      const paneId = chart.createIndicator(
        calcParams ? { name, calcParams } : name,
        def.overlay,
        def.overlay ? { id: "candle_pane" } : { id: `${name.toLowerCase()}_pane` },
      );
      if (typeof paneId === "string") {
        indicatorPanesRef.current.set(name, paneId);
        indicatorParamsAppliedRef.current.set(name, paramKey);
      }
    }
  }, [indicators, indicatorParams, indicatorsHidden]);

  // --- Show/hide the user's drawn overlays (the palette eye toggle)
  // without deleting them. Re-applied on every series (re)load
  // (dataEpoch) since loadDrawings recreates them visible. Structure /
  // OI overlays are their own groups and unaffected - they have their
  // own menu toggles. ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const id of overlaysRef.current.keys()) {
      chart.overrideOverlay({ id, visible: !drawingsHidden });
    }
  }, [drawingsHidden, dataEpoch]);

  // --- Publish the chart-interval's structure trend upward (for the
  // trade panel's optional "trade with the trend only" lock). Null when
  // structure detection isn't enabled for this exact timeframe. ---
  useEffect(() => {
    onTrendChange?.({ trend: trendByTf[interval] ?? null, interval });
  }, [trendByTf, interval, onTrendChange]);

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
    if (!chart || !resolved || !chartExchange || !chartSymbol || dataEpoch === 0) return;
    let cancelled = false;
    const ex = chartExchange;
    const sym = chartSymbol;
    const { tfs, breakers, fvg, breaks, setups } = structure;

    if (tfs.length === 0) {
      chart.removeOverlay({ groupId: OB_GROUP_ID });
      setTrendByTf({});
      setActiveSetups([]);
      seedSetupsRef.current = true;
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
          // Resolved setup: a real 2nd anchor at the resolution bar.
          // Live/planned setup: ONE anchor - the overlay extends itself
          // to the pane's right edge every frame (htfOrderBlock pattern).
          // Never anchor a point at Date.now(): a future/edge timestamp
          // klinecharts can't always resolve to a coordinate, and a throw
          // in createPointFigures freezes the whole chart.
          const resolvedTs = s.resolved_timestamp ? Date.parse(s.resolved_timestamp) : NaN;
          const points =
            Number.isFinite(resolvedTs) && resolvedTs > left
              ? [
                  { timestamp: left, value: s.entry },
                  { timestamp: resolvedTs, value: s.entry },
                ]
              : [{ timestamp: left, value: s.entry }];
          chart!.createOverlay({
            name: "htfSetup",
            groupId: OB_GROUP_ID,
            points,
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

      // Planned/live setups across every timeframe -> the strip + alerts.
      const live: LiveSetup[] = [];
      for (const { label, data } of batches) {
        for (const s of data.setups) {
          if (s.status !== "confirmed" && s.status !== "triggered") continue;
          live.push({
            key: `${label}|${s.direction}|${s.confirmed_timestamp}`,
            tf: label,
            direction: s.direction,
            status: s.status,
            entry: s.entry,
            stop: s.stop_loss,
            target: s.target,
            rr: s.risk_reward,
          });
        }
      }
      live.sort((a, b) => (a.status === b.status ? 0 : a.status === "triggered" ? -1 : 1));
      setActiveSetups(live.slice(0, MAX_ALERT_ROWS));
      reconcileSetupAlerts(live);
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), OB_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [resolved, chartExchange, chartSymbol, structure, dataEpoch]);

  // --- OI strip: for an OI underlying, poll today's sentiment history
  // (the "OI shift" mini-trend) and GET /options/oi-summary. The two run
  // INDEPENDENTLY - /options/expiries can be slow/hang (see its api.ts
  // note), and it must never block the OI-shift refresh. The expiry is
  // resolved once and cached across polls, re-resolved only if a summary
  // fetch fails. Keeps the last good reading on a failed tick. ---
  useEffect(() => {
    const base = symbol.trim().toUpperCase();
    if (!resolved || !OI_UNDERLYINGS.has(base)) {
      setOi(null);
      setOiAt(null);
      setSentHist([]);
      return;
    }
    const ex = resolved.chart_exchange;
    const sym = resolved.chart_symbol;
    let cancelled = false;
    let expiry: string | null = null;

    async function loadShift() {
      try {
        // sentiment_history is keyed by the bare underlying, not the
        // resolved contract (market_data.sentiment_history.symbol).
        const day = await fetchSentimentHistory(base);
        if (!cancelled) setSentHist(day.points);
      } catch {
        // keep the last series
      }
    }

    async function loadSummary() {
      try {
        if (!expiry) {
          const expiries = await fetchOptionExpiries(ex, sym);
          if (cancelled || expiries.length === 0) return;
          expiry = expiries[0];
        }
        const summary = await fetchOiSummary(ex, sym, expiry);
        if (!cancelled) {
          setOi(summary);
          setOiAt(Date.now());
        }
      } catch {
        expiry = null; // re-resolve next tick
      }
    }

    void loadShift();
    void loadSummary();
    const t = window.setInterval(() => {
      void loadShift();
      void loadSummary();
    }, OI_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [resolved, symbol]);

  // --- Draw the OI support/resistance levels on the price pane. Redrawn
  // whenever the OI reading updates (60s poll) or the series changes
  // (dataEpoch), all under one group id for a clean remove-then-add. ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ groupId: OI_GROUP_ID });
    if (!oiLevelsOn || !oi || dataEpoch === 0) return;
    for (const lvl of computeOiLevels(oi)) {
      const tag = lvl.kind === "resistance" ? "R" : "S";
      const label = lvl.forming
        ? `${tag} forming ${lvl.strike}${lvl.oiChange != null ? ` · +${fmtCompactIndian(lvl.oiChange)}/15m` : ""}`
        : `${tag}${lvl.rank} ${lvl.strike}${lvl.oi ? ` · ${fmtCompactIndian(lvl.oi)} OI` : ""}`;
      const extendData: OiLevelExtendData = {
        kind: lvl.kind,
        rank: lvl.rank,
        forming: lvl.forming,
        price: lvl.strike,
        label,
      };
      chart.createOverlay({
        name: "htfOiLevel",
        groupId: OI_GROUP_ID,
        points: [{ timestamp: Date.now(), value: lvl.strike }],
        extendData,
      });
    }
  }, [oi, oiLevelsOn, dataEpoch]);

  // --- Resolve the typed underlying to a quotable chart symbol/exchange
  // (an MCX commodity or NSE index future doesn't quote under its bare
  // name - same resolveUnderlying every other watch path here uses). ---
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setStatus("loading");
    setErrorMsg(null);
    // New instrument - drop the strip, the contract override + list, and
    // re-seed the alert diff so the first structure refresh chimes for
    // nothing.
    setActiveSetups([]);
    setContract(null);
    setFutures([]);
    seedSetupsRef.current = true;
    const bare = symbol.trim().toUpperCase();
    resolveUnderlying(segment, bare)
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      });
    fetchFutureContracts(segment, bare)
      .then((f) => {
        if (cancelled) return;
        setFutures(f);
        // Restore a previously-picked contract for this underlying.
        const saved = localStorage.getItem(`${CONTRACT_STORAGE_KEY}:${bare}`);
        const match = saved ? f.find((c) => c.trading_symbol === saved) : null;
        if (match) setContract(match);
      })
      .catch(() => {
        // no picker - fine
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
    if (!chart || !chartExchange || !chartSymbol) return;

    const def = INTERVALS.find((i) => i.value === interval) ?? INTERVALS[1];
    const intervalMs = def.minutes * 60_000;
    const ex = chartExchange;
    const sym = chartSymbol;

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
  }, [chartExchange, chartSymbol, interval]);

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
                {INDICATORS.filter((i) => i.overlay).map(renderIndicatorRow)}
                <div className="live-chart-indicators-group">Lower pane</div>
                {INDICATORS.filter((i) => !i.overlay).map(renderIndicatorRow)}
                <div className="live-chart-indicators-hint">
                  For an indicator with a period list, the box sets its lengths (e.g. Volume MAs) — comma-separated;
                  clear it for none.
                </div>
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
                {structure.setups && (
                  <label className="live-chart-indicators-suboption">
                    <input type="checkbox" checked={alertsOn} onChange={toggleSetupAlerts} />
                    🔔 Sound + desktop alert on a new setup
                  </label>
                )}
                <div className="live-chart-indicators-hint">
                  Auto-detected structure. Detection follows the chart's interval — changing the interval resets it to
                  that timeframe; tick extra timeframes here to overlay them as well. Dashed border = tested; thick
                  border = breaker; amber band = FVG; faded = counter-trend or a resolved setup.
                </div>
              </div>
            )}
          </div>

          {structure.tfs.length > 0 && (
            <div className="live-chart-structure-trends" title="Structure trend per enabled detection timeframe">
              {structure.tfs.map((tf) => {
                const def = OB_TIMEFRAMES.find((t) => t.value === tf);
                if (!def) return null;
                const tr = trendByTf[tf] ?? "range";
                return (
                  <span key={tf} className={`live-chart-trend live-chart-trend-${tr}`}>
                    {def.label} {tr === "up" ? "▲" : tr === "down" ? "▼" : "–"}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="live-chart-meta">
          {resolved &&
            (futures.length > 0 ? (
              <select
                className="live-chart-contract"
                title="Chart a different future contract"
                value={contract?.trading_symbol ?? resolved.chart_symbol}
                onChange={(e) => {
                  const picked = futures.find((f) => f.trading_symbol === e.target.value) ?? null;
                  const override = picked && picked.trading_symbol !== resolved.chart_symbol ? picked : null;
                  setContract(override);
                  const key = `${CONTRACT_STORAGE_KEY}:${symbol.trim().toUpperCase()}`;
                  try {
                    if (override) localStorage.setItem(key, override.trading_symbol);
                    else localStorage.removeItem(key);
                  } catch {
                    // storage disabled - the pick still applies this session
                  }
                }}
              >
                {!futures.some((f) => f.trading_symbol === resolved.chart_symbol) && (
                  <option value={resolved.chart_symbol}>
                    {resolved.chart_exchange}:{resolved.chart_symbol} · spot
                  </option>
                )}
                {futures.map((f, i) => (
                  <option key={f.trading_symbol} value={f.trading_symbol}>
                    {f.exchange}:{symbol.trim().toUpperCase()} {contractExpiryLabel(f)}
                    {i === 0 ? " · near" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="live-chart-symbol">
                {resolved.chart_exchange}:{resolved.chart_symbol}
              </span>
            ))}
          {lastPrice != null && <span className="live-chart-ltp">{lastPrice.toFixed(pricePrecision(lastPrice))}</span>}
          {OI_SYMBOLS.has(symbol.trim().toUpperCase()) && (
            <button
              type="button"
              className="live-chart-oi-link"
              title={`Open ${symbol.trim().toUpperCase()} options OI analysis`}
              onClick={() => openOiAnalysis(symbol)}
            >
              OI Analysis ↗
            </button>
          )}
        </div>
      </div>

      {activeSetups.length > 0 && (
        <div className="live-chart-setup-alerts">
          {activeSetups.map((s) => (
            <span
              key={s.key}
              className={`live-chart-setup-alert live-chart-setup-alert-${s.direction} ${
                s.status === "triggered" ? "is-live" : "is-planned"
              }`}
              title={`${s.tf} detection timeframe · ${s.status === "triggered" ? "entry hit, running" : "confirmed, waiting for entry"}`}
            >
              <b>{s.status === "triggered" ? "▶ LIVE" : "⚡ PLANNED"}</b>
              <span>
                {s.tf} {s.direction.toUpperCase()} · entry {fmtPrice(s.entry)} · SL {fmtPrice(s.stop)} · TP{" "}
                {fmtPrice(s.target)} · {s.rr.toFixed(1)}R
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="live-chart-body">
        <div className="live-chart-drawtools">
          {DRAW_TOOLS.map(({ overlay, title, Icon }) => (
            <button
              key={overlay}
              type="button"
              title={`${title}${activeTool === overlay ? " (click to cancel)" : ""}`}
              aria-label={title}
              aria-pressed={activeTool === overlay}
              className={activeTool === overlay ? "active" : ""}
              disabled={status !== "ready" || drawingsHidden}
              onClick={() => startDrawing(overlay)}
            >
              <Icon />
            </button>
          ))}

          <span className="live-chart-drawtools-sep" />

          <button
            type="button"
            className={drawingsHidden ? "is-hidden" : ""}
            title={drawingsHidden ? "Show drawings" : "Hide drawings"}
            aria-label={drawingsHidden ? "Show drawings" : "Hide drawings"}
            aria-pressed={drawingsHidden}
            disabled={status !== "ready"}
            onClick={toggleDrawingsHidden}
          >
            <ScribbleIcon />
          </button>
          <button
            type="button"
            className={indicatorsHidden ? "is-hidden" : ""}
            title={indicatorsHidden ? "Show indicators" : "Hide indicators"}
            aria-label={indicatorsHidden ? "Show indicators" : "Hide indicators"}
            aria-pressed={indicatorsHidden}
            disabled={status !== "ready"}
            onClick={toggleIndicatorsHidden}
          >
            <PlotLineIcon />
          </button>

          <span className="live-chart-drawtools-sep" />

          <button
            type="button"
            className="live-chart-drawtools-clear"
            title="Remove all drawings on this symbol"
            aria-label="Clear all drawings"
            disabled={status !== "ready" || drawingsHidden}
            onClick={clearDrawings}
          >
            <TrashIcon />
          </button>
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

      {oi && (
        <div className="live-chart-oi-strip" title={`Nearest-expiry option OI for ${oi.underlying_symbol} · as of this poll`}>
          <span className="live-chart-oi-pcr">
            PCR <b>{oi.pcr != null ? oi.pcr.toFixed(2) : "–"}</b>
          </span>
          <span>
            CE OI {fmtCompactIndian(oi.total_call_oi)}
            {(oi.total_call_oi_change_5m != null || oi.total_call_oi_change_15m != null) && (
              <span className="live-chart-oi-delta">
                {" "}
                {fmtOiDeltaPct(oi.total_call_oi_change_5m, oi.total_call_oi)}/5m{" "}
                {fmtOiDeltaPct(oi.total_call_oi_change_15m, oi.total_call_oi)}/15m
              </span>
            )}
          </span>
          <span>
            PE OI {fmtCompactIndian(oi.total_put_oi)}
            {(oi.total_put_oi_change_5m != null || oi.total_put_oi_change_15m != null) && (
              <span className="live-chart-oi-delta">
                {" "}
                {fmtOiDeltaPct(oi.total_put_oi_change_5m, oi.total_put_oi)}/5m{" "}
                {fmtOiDeltaPct(oi.total_put_oi_change_15m, oi.total_put_oi)}/15m
              </span>
            )}
          </span>
          {(() => {
            const levels = computeOiLevels(oi).filter((l) => !l.forming);
            const res = levels.filter((l) => l.kind === "resistance").sort((a, b) => a.rank - b.rank);
            const sup = levels.filter((l) => l.kind === "support").sort((a, b) => a.rank - b.rank);
            return (
              <>
                {res.length > 0 && (
                  <span
                    className="live-chart-oi-sr live-chart-oi-sr-r"
                    title={res.map((l) => `R${l.rank} ${l.strike} · ${fmtCompactIndian(l.oi)} call OI`).join("  ")}
                  >
                    R <b>{res.map((l) => l.strike).join(" · ")}</b>
                  </span>
                )}
                {sup.length > 0 && (
                  <span
                    className="live-chart-oi-sr live-chart-oi-sr-s"
                    title={sup.map((l) => `S${l.rank} ${l.strike} · ${fmtCompactIndian(l.oi)} put OI`).join("  ")}
                  >
                    S <b>{sup.map((l) => l.strike).join(" · ")}</b>
                  </span>
                )}
              </>
            );
          })()}
          <label className="live-chart-oi-levels-toggle" title="Draw the OI support/resistance levels on the chart">
            <input type="checkbox" checked={oiLevelsOn} onChange={toggleOiLevels} />
            levels on chart
          </label>
          {(oi.total_call_buildup || oi.total_put_buildup) && (
            <span className="live-chart-oi-buildup-group">
              {oi.total_call_buildup && (
                <span
                  className={`oi-buildup-badge ${BUILDUP_META[oi.total_call_buildup].cls}`}
                  title={`Call OI: ${BUILDUP_META[oi.total_call_buildup].label}`}
                >
                  {BUILDUP_META[oi.total_call_buildup].icon} CE {OI_BUILDUP_LABEL[oi.total_call_buildup]}
                </span>
              )}
              {oi.total_put_buildup && (
                <span
                  className={`oi-buildup-badge ${BUILDUP_META[oi.total_put_buildup].cls}`}
                  title={`Put OI: ${BUILDUP_META[oi.total_put_buildup].label}`}
                >
                  {BUILDUP_META[oi.total_put_buildup].icon} PE {OI_BUILDUP_LABEL[oi.total_put_buildup]}
                </span>
              )}
            </span>
          )}
          {(() => {
            const steps = sentimentSteps(sentHist);
            if (steps.length < 2) return null;
            const maxAbs = Math.max(0.2, ...steps.map((s) => Math.abs(s.score)));
            const last = steps[steps.length - 1];
            const prev = steps[steps.length - 2];
            const ageMs = Date.now() - new Date(last.pt.recorded_at).getTime();
            const stale = ageMs > 12 * 60_000; // > 2 recording cycles behind
            return (
              <span
                className="live-chart-oi-sent"
                title={`OI shift % (${last.win}) over the last readings — bars are the reading, ⚡ marks a major move or a side flip. Source: sentiment_history, written every 5 min.`}
              >
                OI shift {last.win}
                <span className="live-chart-oi-spark">
                  {steps.map((s) => (
                    <span
                      key={s.pt.recorded_at}
                      className={`live-chart-oi-spark-bar${s.major ? " is-major" : ""}`}
                      style={{
                        height: `${Math.max(8, (Math.abs(s.score) / maxAbs) * 100)}%`,
                        background: scoreColor(s.score),
                      }}
                      title={`${hhmm(s.pt.recorded_at)} · ${s.win} · ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}%${s.major ? " · major move" : ""}`}
                    />
                  ))}
                </span>
                <b style={{ color: scoreColor(last.score) }}>
                  {last.score >= 0 ? "+" : ""}
                  {last.score.toFixed(2)}%
                </b>
                {last.major && (
                  <span className="live-chart-oi-sent-flag">
                    ⚡ {last.score - prev.score >= 0 ? "+" : ""}
                    {(last.score - prev.score).toFixed(2)} vs {hhmm(prev.pt.recorded_at)}
                  </span>
                )}
                <span className={`live-chart-oi-at${stale ? " is-stale" : ""}`}>
                  {hhmm(last.pt.recorded_at)}
                  {stale ? " (stale)" : ""}
                </span>
              </span>
            );
          })()}
          {oiAt != null && (
            <span
              className={`live-chart-oi-at${Date.now() - oiAt > 4 * 60_000 ? " is-stale" : ""}`}
              title="When this client last pulled a fresh option chain — server-cached 30s; NSE re-disseminates OI roughly every 3 min"
            >
              chain @ {new Date(oiAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

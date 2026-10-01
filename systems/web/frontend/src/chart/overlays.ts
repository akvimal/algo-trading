import { IndicatorSeries, LineType, registerIndicator, registerOverlay, type IndicatorFigureStyle, type OverlayFigure } from "klinecharts";
import { ACCENT, BUY, MARK_LOSS, MARK_OPEN, MARK_PROFIT, SELL } from "./colors";
import { computeSupertrend } from "./supertrend";
import type { OiLevelLine } from "./oiLevels";
import { textLook, type DrawingStyle } from "./drawingStyle";
import { compactPnl, pnlTone, type TradeMarkerExtend } from "./trades";

export { ACCENT, BUY, SELL };

// Custom drawings and indicators the chart library does not ship. They register globally and once
// (a second call is a no-op), so any number of chart panes can share them. Colours here are literal
// because the canvas cannot read CSS variables; they match the app's up/down/accent tokens.

const INK = "#0f1216";

export const STRUCTURE_GROUP = "structure";
export const PLAN_GROUP = "plan";
export const PEER_GROUP = "peer";
export const TIMEMARK_GROUP = "time-mark";
export const TRADES_GROUP = "trades";
export const OI_GROUP = "oi-levels";
export const LEVELS_GROUP = "open-levels";

export type ObExtend = { tf: string; kind: "demand" | "supply"; role: "orderblock" | "breaker"; proximal: number; distal: number; mitigated: boolean; counterTrend: boolean };
export type FvgExtend = { kind: "bullish" | "bearish"; top: number; bottom: number; filled: boolean };
export type BreakExtend = { tf: string; kind: "bos" | "choch"; direction: "up" | "down"; price: number };
export type TrendMarkExtend = { tf: string; trend: "up" | "down" | "range"; price: number };
export type SetupExtend = { tf: string; direction: "long" | "short"; status: "confirmed" | "triggered" | "hit_target" | "hit_sl" | "invalidated"; entry: number; stop: number; target: number; rr: number };
export type PlanLineExtend = { key: string; label: string; color: string; dashed: boolean };

const pill = (color: string, size = 10) => ({
  color,
  size,
  backgroundColor: "rgba(15, 18, 22, 0.78)",
  paddingLeft: 3,
  paddingRight: 3,
  paddingTop: 1,
  paddingBottom: 1,
  borderRadius: 2,
});

const NO_DEFAULTS = { needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false } as const;

let registered = false;

export function registerChartExtensions(): void {
  if (registered) return;
  registered = true;

  // klinecharts 9 has no rectangle: a supply/demand zone is two clicked corners and a translucent box.
  registerOverlay({
    name: "rect",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      return [
        {
          type: "polygon",
          attrs: { coordinates: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] },
          styles: { ...(overlay.styles?.polygon ?? {}), style: "stroke_fill" },
        },
      ];
    },
  });

  // A piece of text placed on the chart: one click, then the words are typed in (see ChartPane's text editor). A light
  // label with a dark outline so it reads over candles of either colour; selecting it shows the usual handle to move it.
  registerOverlay({
    name: "textNote",
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const c0 = coordinates[0];
      const d = overlay.extendData as { text?: string; style?: DrawingStyle } | undefined;
      const text = d?.text;
      if (!c0 || !text || !Number.isFinite(c0.x) || !Number.isFinite(c0.y)) return [];
      const look = textLook(d?.style);
      return [
        {
          type: "text",
          attrs: { x: c0.x + 8, y: c0.y, text, align: "left", baseline: "middle" },
          styles: { color: look.ink, size: look.size, weight: look.weight, backgroundColor: look.background, borderColor: INK, borderSize: 1, borderRadius: 4, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 },
        },
      ];
    },
  });

  // A level of the trade plan (entry, stop, target): a full-width line with a label at the price axis.
  // Its figures take pointer events, so the person can grab it and drag it to a new price; the chart
  // reports the new price when the drag ends (see ChartPane) and the ticket follows.
  registerOverlay({
    name: "planLine",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, bounding, yAxis }) => {
      const v = overlay.points[0]?.value;
      const d = overlay.extendData as PlanLineExtend | undefined;
      if (!yAxis || v == null || !d || !Number.isFinite(v)) return [];
      const y = yAxis.convertToPixel(v);
      if (!Number.isFinite(y)) return [];
      return [
        { type: "line", attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: d.color, size: 1.5, style: d.dashed ? "dashed" : "solid", dashedValue: [6, 4] } },
        {
          type: "text",
          attrs: { x: bounding.width - 4, y: y - 3, text: `${d.label} ${v.toFixed(2)}`, align: "right", baseline: "bottom" },
          styles: { color: INK, size: 11, weight: "bold", backgroundColor: d.color, paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1, borderRadius: 2 },
        },
      ];
    },
  });

  // The other chart's crosshair: a faint dashed vertical line at the time the person is pointing at over
  // there, so two charts read as one when they are linked.
  registerOverlay({
    name: "peerCursor",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      if (x == null || !Number.isFinite(x)) return [];
      return [{ type: "line", attrs: { coordinates: [{ x, y: 0 }, { x, y: bounding.height }] }, styles: { color: "rgba(147, 161, 177, 0.8)", size: 1, style: "dashed", dashedValue: [3, 3] }, ignoreEvent: true }];
    },
  });

  // The time the person clicked, on every linked chart: a solid vertical line with its time on a tag at the top.
  registerOverlay({
    name: "timeMark",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      if (x == null || !Number.isFinite(x)) return [];
      const label = (overlay.extendData as { label?: string } | undefined)?.label;
      const figures: OverlayFigure[] = [{ type: "line", attrs: { coordinates: [{ x, y: 0 }, { x, y: bounding.height }] }, styles: { color: ACCENT, size: 1.5, style: "solid" }, ignoreEvent: true }];
      if (label) {
        figures.push({
          type: "text",
          attrs: { x, y: 4, text: label, align: "center", baseline: "top" },
          styles: { color: INK, size: 11, weight: "bold", backgroundColor: ACCENT, borderRadius: 3, paddingLeft: 5, paddingRight: 5, paddingTop: 2, paddingBottom: 2 },
          ignoreEvent: true,
        });
      }
      return figures;
    },
  });

  // A support or resistance line from the option chain: full width at the strike, with a filled tag at
  // the right edge. Resistance is red and support green, brighter than the candles so they read across the
  // whole chart. The biggest wall on each side is heavy with a soft band behind it; the next is lighter; a
  // level still forming is dashed with a fainter band.
  registerOverlay({
    name: "oiLevel",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, bounding, yAxis }) => {
      const d = overlay.extendData as OiLevelLine | undefined;
      if (!d || !yAxis) return [];
      const y = yAxis.convertToPixel(d.price);
      if (!Number.isFinite(y)) return [];
      const rgb = d.kind === "resistance" ? "255, 107, 129" : "77, 227, 158";
      const primary = d.rank === 1 && !d.forming;
      const band = primary ? 0.16 : d.forming ? 0.1 : 0;
      const size = primary ? 13 : 11;
      const figs: OverlayFigure[] = [];
      if (band > 0) figs.push({ type: "rect", attrs: { x: 0, y: y - 3, width: bounding.width, height: 6 }, styles: { style: "fill", color: `rgba(${rgb}, ${band})` }, ignoreEvent: true });
      figs.push({ type: "line", attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: `rgba(${rgb}, ${d.forming ? 0.9 : 1})`, size: primary ? 3 : 2, style: d.forming ? "dashed" : "solid", dashedValue: [5, 4] }, ignoreEvent: true });
      figs.push({
        type: "text",
        attrs: { x: bounding.width - 4, y: y - (size + 6), text: d.label, baseline: "top", align: "right" },
        styles: { color: INK, size, weight: "bold", backgroundColor: `rgba(${rgb}, 0.95)`, borderColor: `rgba(${rgb}, 1)`, borderSize: 1, paddingLeft: 5, paddingRight: 5, paddingTop: 2, paddingBottom: 2, borderRadius: 3 },
        ignoreEvent: true,
      });
      return figs;
    },
  });

  // One of the person's own trades. A future or spot trade is an arrow at its entry; while open it also
  // runs a dashed line to the right edge with its live result, and once closed it joins the entry to the
  // exit with a line coloured by how it turned out. An option trade has no price of its own on this chart,
  // so it is a diamond at the underlying's price when it opened, with its result beside it.
  registerOverlay({
    name: "tradeMarker",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      const d = overlay.extendData as TradeMarkerExtend | undefined;
      const c0 = coordinates[0];
      if (!d || !c0 || !yAxis || !Number.isFinite(c0.x)) return [];
      const yE = yAxis.convertToPixel(d.entryPrice);
      if (!Number.isFinite(yE)) return [];
      const long = d.side === "long";
      const tone = pnlTone(d.pnl);
      // One colour per trade, by how it is doing (gold in profit, violet at a loss, sky with no result yet),
      // so the marker, its line and its tag read as one thing and stand out from the green and red candles.
      const result = tone === "up" ? MARK_PROFIT : tone === "dn" ? MARK_LOSS : MARK_OPEN;
      const dir = result;
      // A large badge with a thick white ring: the ring is what keeps it visible against any candle.
      const badge = (glyph: string, bg: string): OverlayFigure => ({
        type: "text",
        attrs: { x: 0, y: 0, text: glyph, align: "center", baseline: "middle" },
        styles: { color: INK, size: 14, weight: "bold", backgroundColor: bg, borderColor: "#ffffff", borderSize: 2.5, borderRadius: 10, paddingLeft: 5, paddingRight: 5, paddingTop: 5, paddingBottom: 5 },
        ignoreEvent: true,
      });
      const at = (f: OverlayFigure, x: number, y: number): OverlayFigure => ({ ...f, attrs: { ...(f.attrs as object), x, y } } as OverlayFigure);
      const label = (text: string, x: number, y: number, bg: string, align: "left" | "right", size = 10): OverlayFigure => ({
        type: "text",
        attrs: { x, y, text, align, baseline: "bottom" },
        styles: { color: INK, size, weight: "bold", backgroundColor: bg, borderRadius: 3, paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1 },
        ignoreEvent: true,
      });
      const entryGlyph = d.kind === "option" ? "◆" : long ? "▲" : "▼";
      const figs: OverlayFigure[] = [at(badge(entryGlyph, dir), c0.x, yE)];

      if (d.state === "open") {
        const right = bounding.width;
        figs.push({ type: "line", attrs: { coordinates: [{ x: c0.x, y: yE }, { x: right, y: yE }] }, styles: { color: dir, size: 2, style: "dashed", dashedValue: [5, 3] }, ignoreEvent: true });
        figs.push(label(`${d.label} · ${compactPnl(d.pnl)}`, right - 4, yE - 9, result, "right", 11));
        return figs;
      }

      const c1 = coordinates[1];
      const hasExit = d.exitPrice != null && !!c1 && Number.isFinite(c1.x);
      const x1 = hasExit ? c1!.x : c0.x;
      const yX = hasExit ? yAxis.convertToPixel(d.exitPrice as number) : yE;
      if (!Number.isFinite(yX)) return figs;
      if (hasExit) {
        figs.push({ type: "line", attrs: { coordinates: [{ x: c0.x, y: yE }, { x: x1, y: yX }] }, styles: { color: result, size: 2.5, style: "solid" }, ignoreEvent: true });
        figs.push(at(badge("✕", result), x1, yX));
      }
      figs.push(label(`${compactPnl(d.pnl)}${d.reason ? ` · ${d.reason.replace(/_/g, " ")}` : ""}`, x1 + 5, yX - 9, result, "left"));
      return figs;
    },
  });

  // Order blocks and breakers: a band from the origin candle to the right edge, redrawn every frame so
  // it extends as the live bar advances and survives pan and zoom. Counter-trend zones are dimmed.
  registerOverlay({
    name: "htfOrderBlock",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
      const d = overlay.extendData as ObExtend | undefined;
      if (!d) return [];
      const leftX = coordinates[0].x;
      const rightX = bounding.width;
      if (!Number.isFinite(leftX) || rightX <= leftX) return [];
      const yA = yAxis.convertToPixel(d.proximal);
      const yB = yAxis.convertToPixel(d.distal);
      const top = Math.min(yA, yB);
      const height = Math.max(1, Math.abs(yA - yB));
      const breaker = d.role === "breaker";
      const dim = d.counterTrend ? 0.45 : 1;
      const rgb = d.kind === "demand" ? "62, 207, 142" : "232, 88, 106";
      const label = `${d.tf} ${breaker ? "breaker" : d.kind}${d.mitigated ? " · tested" : ""}${d.counterTrend ? " · counter" : ""}`;
      return [
        {
          type: "rect",
          attrs: { x: leftX, y: top, width: rightX - leftX, height },
          styles: { style: "stroke_fill", color: `rgba(${rgb}, ${(breaker ? 0.22 : 0.16) * dim})`, borderColor: `rgba(${rgb}, ${0.85 * dim})`, borderSize: breaker ? 2 : 1, borderStyle: d.mitigated ? "dashed" : "solid" },
          ignoreEvent: true,
        },
        { type: "text", attrs: { x: rightX - 4, y: top + 2, text: label, baseline: "top", align: "right" }, styles: pill(`rgba(${rgb}, 1)`), ignoreEvent: true },
      ];
    },
  });

  // Break of structure / change of character: the swing level that broke, from the pivot candle to the
  // candle that closed through it. CHoCH (it flipped the trend) is dashed, BOS solid.
  registerOverlay({
    name: "htfStructureBreak",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, yAxis }) => {
      if (coordinates.length < 2 || !coordinates[0] || !coordinates[1] || !yAxis) return [];
      const d = overlay.extendData as BreakExtend | undefined;
      if (!d) return [];
      const leftX = coordinates[0].x;
      const rightX = coordinates[1].x;
      if (!Number.isFinite(leftX) || !Number.isFinite(rightX) || rightX <= leftX) return [];
      const y = yAxis.convertToPixel(d.price);
      const color = d.direction === "up" ? "rgba(62, 207, 142, 0.85)" : "rgba(232, 88, 106, 0.85)";
      return [
        { type: "line", attrs: { coordinates: [{ x: leftX, y }, { x: rightX, y }] }, styles: { color, size: 1, style: d.kind === "choch" ? "dashed" : "solid" }, ignoreEvent: true },
        { type: "circle", attrs: { x: rightX, y, r: 2.5 }, styles: { color, style: "fill" }, ignoreEvent: true },
        { type: "text", attrs: { x: rightX + 3, y: y - 13, text: `${d.tf} ${d.kind.toUpperCase()} ${d.direction === "up" ? "▲" : "▼"}`, baseline: "top", align: "left" }, styles: pill(color), ignoreEvent: true },
      ];
    },
  });

  // Trend-change marks: a dashed full-height line at the candle where the confirmed trend flipped.
  registerOverlay({
    name: "htfTrendMark",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      if (coordinates.length < 1 || !coordinates[0]) return [];
      const d = overlay.extendData as TrendMarkExtend | undefined;
      const x = coordinates[0].x;
      if (!d || !Number.isFinite(x)) return [];
      const color = d.trend === "up" ? "rgba(62, 207, 142, 0.95)" : d.trend === "down" ? "rgba(232, 88, 106, 0.95)" : "rgba(176, 180, 190, 0.85)";
      const glyph = d.trend === "up" ? "▲" : d.trend === "down" ? "▼" : "◆";
      const label = d.trend === "range" ? "TREND LOST" : d.trend === "up" ? "TREND UP" : "TREND DOWN";
      const figs: OverlayFigure[] = [
        { type: "line", attrs: { coordinates: [{ x, y: 0 }, { x, y: bounding.height }] }, styles: { color, size: 1.5, style: "dashed" }, ignoreEvent: true },
        { type: "text", attrs: { x: x + 3, y: 4, text: `${d.tf} ${glyph} ${label}`, baseline: "top", align: "left" }, styles: { ...pill("rgba(15, 18, 22, 0.95)"), backgroundColor: color }, ignoreEvent: true },
      ];
      if (yAxis) {
        const y = yAxis.convertToPixel(d.price);
        if (Number.isFinite(y)) figs.push({ type: "text", attrs: { x, y, text: glyph, align: "center", baseline: "middle" }, styles: { color, size: 13 }, ignoreEvent: true });
      }
      return figs;
    },
  });

  // A rejection-confirmed setup: entry, stop and target lines with a risk box and a reward box, from the
  // confirming candle to where it resolved (or the right edge while it is live). Resolved ones fade.
  // A throw in here would freeze the whole chart, so every coordinate is checked.
  registerOverlay({
    name: "htfSetup",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
      const d = overlay.extendData as SetupExtend | undefined;
      if (!d) return [];
      const x0 = coordinates[0].x;
      if (!Number.isFinite(x0)) return [];
      const x1raw = coordinates.length >= 2 && coordinates[1] && Number.isFinite(coordinates[1].x) ? coordinates[1].x : bounding.width;
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
        { type: "rect", attrs: { x: x0, y: Math.min(yE, yS), width: x1 - x0, height: Math.max(1, Math.abs(yE - yS)) }, styles: { style: "fill", color: `rgba(232, 88, 106, ${0.16 * a})` }, ignoreEvent: true },
        { type: "rect", attrs: { x: x0, y: Math.min(yE, yT), width: x1 - x0, height: Math.max(1, Math.abs(yE - yT)) }, styles: { style: "fill", color: `rgba(62, 207, 142, ${0.16 * a})` }, ignoreEvent: true },
        { type: "line", attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] }, styles: { color: neutral, size: 1.5, style: d.status === "triggered" ? "solid" : "dashed" }, ignoreEvent: true },
        { type: "line", attrs: { coordinates: [{ x: x0, y: yS }, { x: x1, y: yS }] }, styles: { color: red, size: 1.5 }, ignoreEvent: true },
        { type: "line", attrs: { coordinates: [{ x: x0, y: yT }, { x: x1, y: yT }] }, styles: { color: green, size: 1.5 }, ignoreEvent: true },
        {
          type: "text",
          attrs: { x: x1 - 3, y: Math.min(yE, yS, yT) - 15, text: label, baseline: "top", align: "right" },
          styles: { ...pill(neutral, 11), weight: "bold", backgroundColor: "rgba(15, 18, 22, 0.82)", borderColor: neutral, borderSize: 1 },
          ignoreEvent: true,
        },
      ];
    },
  });

  // Fair value gaps: a thin amber band, unlabelled (they are small and frequent); filled ones fainter.
  registerOverlay({
    name: "htfFvg",
    totalStep: 2,
    ...NO_DEFAULTS,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      if (coordinates.length < 1 || !coordinates[0] || !yAxis) return [];
      const d = overlay.extendData as FvgExtend | undefined;
      if (!d) return [];
      const leftX = coordinates[0].x;
      const rightX = bounding.width;
      if (!Number.isFinite(leftX) || rightX <= leftX) return [];
      const yTop = yAxis.convertToPixel(d.top);
      const yBottom = yAxis.convertToPixel(d.bottom);
      return [
        {
          type: "rect",
          attrs: { x: leftX, y: Math.min(yTop, yBottom), width: rightX - leftX, height: Math.max(1, Math.abs(yTop - yBottom)) },
          styles: { style: "stroke_fill", color: `rgba(224, 176, 88, ${d.filled ? 0.07 : 0.2})`, borderColor: `rgba(224, 176, 88, ${d.filled ? 0.25 : 0.55})`, borderSize: 1, borderStyle: d.filled ? "dashed" : "solid" },
          ignoreEvent: true,
        },
      ];
    },
  });

  // Supertrend: the trailing line that flips from below the price to above it.
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
      const [period, mult] = indicator.calcParams as number[];
      return computeSupertrend(dataList, period, mult).map((pt) => (pt.dir === "up" ? { up: pt.line } : { down: pt.line }));
    },
  });

  // RSI with the two reference bands configurable, replacing the built-in (whose parameters are three
  // separate periods and which has no overbought/oversold lines): [period, overbought, oversold].
  type RsiPoint = { rsi?: number; overbought?: number; oversold?: number };
  registerIndicator<RsiPoint>({
    name: "RSI",
    shortName: "RSI",
    series: IndicatorSeries.Normal,
    calcParams: [14, 70, 30],
    precision: 2,
    figures: [
      { key: "rsi", title: "RSI: ", type: "line" },
      { key: "overbought", title: "OB: ", type: "line", styles: () => ({ color: SELL, style: LineType.Dashed, size: 1 }) as unknown as IndicatorFigureStyle },
      { key: "oversold", title: "OS: ", type: "line", styles: () => ({ color: BUY, style: LineType.Dashed, size: 1 }) as unknown as IndicatorFigureStyle },
    ],
    regenerateFigures: null,
    calc: (dataList, indicator) => {
      const [rawPeriod, rawOb, rawOs] = indicator.calcParams as number[];
      const period = Math.max(1, Math.round(rawPeriod || 14));
      const overbought = rawOb ?? 70;
      const oversold = rawOs ?? 30;
      const out: RsiPoint[] = new Array(dataList.length);
      let sumUp = 0;
      let sumDown = 0;
      for (let i = 0; i < dataList.length; i++) {
        const k = dataList[i];
        const diff = k.close - (i > 0 ? dataList[i - 1].close : k.close);
        if (diff > 0) sumUp += diff;
        else sumDown += Math.abs(diff);
        let rsi: number | undefined;
        if (i >= period - 1) {
          rsi = sumDown !== 0 ? 100 - 100 / (1 + sumUp / sumDown) : 100;
          const ago = dataList[i - (period - 1)];
          const agoPrev = dataList[i - period] ?? ago;
          const agoDiff = ago.close - agoPrev.close;
          if (agoDiff > 0) sumUp -= agoDiff;
          else sumDown -= Math.abs(agoDiff);
        }
        out[i] = { rsi, overbought, oversold };
      }
      return out;
    },
  });
}

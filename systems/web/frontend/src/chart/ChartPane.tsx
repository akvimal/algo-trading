import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActionType, OverlayMode, dispose, init, type Chart, type Crosshair, type Overlay, type OverlayEvent } from "klinecharts";
import { candleAtOrBefore, levelWithOtherEnd, snapZoneCorner, zoneOnWick, type Wick } from "./snap";
import { getCandles } from "../api/trade";
import type { ChartStructure } from "../api/types";
import { formatPrice } from "../format";
import { ALERTABLE, SERVER_WATCHED, checkAlert, levelText, sideOf, alertZone, type SelectionInfo, type Side, type Trigger } from "./alerts";
import { toChartPoint, pointTimestamp, type BarAnchor } from "./anchor";
import {
  DRAWINGS_CHANGED_EVENT, INDICATOR_BY_NAME, effectiveParams, intervalDef, loadDrawingDefaults, loadDrawings, pricePrecision, saveDrawingDefault, saveDrawings, structureIsOn, toKLine,
  STRUCTURE_TIMEFRAMES, TEXT_DRAWING_MAX, type DrawingsChangedDetail, type StoredDrawing, type StructureConfig,
} from "./config";
import { ACCENT } from "./colors";
import { PEER_GROUP, PLAN_GROUP, OI_GROUP, LEVELS_GROUP, STRUCTURE_GROUP, TRADES_GROUP, registerChartExtensions, type DrawTagExtend, type PlanLineExtend } from "./overlays";
import { liveSetups, getStructure, structureOverlays, type TrendByTf } from "./structure";
import { averageTrueRange, rollLiveBar, type Bar } from "./liveBar";
import { mergeStyle, sanitizeStyle, toOverlayStyles, type DrawingStyle } from "./drawingStyle";
import { withDevicePixelRatio } from "./snapshot";
import { scheduleZoneSync } from "./zoneSync";
import { chartStyles, prefersLight } from "./theme";
import type { OiLevelLine } from "./oiLevels";
import type { ChartTrade, OpenLevel, TradeMarkerExtend } from "./trades";

export type DrawTool = "segment" | "rayLine" | "horizontalStraightLine" | "priceLine" | "rect" | "fibonacciLine" | "parallelStraightLine" | "textNote";

export type PlanLine = { key: PriceField; price: number; label: string; color: string; dashed?: boolean };

export type PriceField = "entry" | "stop" | "target";

export type ChartPaneHandle = {
  startDrawing: (tool: DrawTool) => void;
  cancelDrawing: () => void;
  clearDrawings: () => void;
  removeSelected: () => void;
  /** Arm the selected drawing (or, with null, disarm it). Only lines and zones can be armed. */
  setSelectedAlert: (trigger: Trigger | null) => void;
  /** Put a short label on the selected line, ray, level or zone (empty removes it). */
  setSelectedLabel: (text: string) => void;
  /** How far the instrument typically moves in one bar of this chart (null until enough bars have loaded) -
   * what a starting stop or target line is measured in, so it lands inside the part of the chart on screen. */
  typicalMove: () => number | null;
  /** Change the selected drawing's look (colour, thickness, dash, fill, text size). A field set to undefined goes back to the chart's own. */
  setSelectedStyle: (patch: DrawingStyle) => void;
  /** Put the selected drawing back to the chart's own look. */
  resetSelectedStyle: () => void;
  /** Make the selected drawing's look the default for new drawings of its kind (true), or clear that default (false). */
  setSelectedStyleAsDefault: (on: boolean) => void;
  /** The chart as it is on screen (candles, indicators, drawings, structure, trade markers) as a PNG data URL, or
   * the reason there is no picture to take (still loading, failed to load, the browser could not draw it).
   * `withoutTrades` takes the picture with the person's own trading hidden (the trade plan's entry/stop/target, their open trades'
   * levels with their profit label, and the entry/exit markers), then shows it again: the picture a published idea needs. */
  snapshot: (opts?: { withoutTrades?: boolean }) => ChartImage;
};

export type ChartImage = { url: string; scale?: number } | { problem: string };

/** The least height, in layout pixels, a chart is exported at: a short pane is made this tall for the capture. */
const SNAPSHOT_MIN_HEIGHT = 560;

/** The overlay groups that show the person's own trading. */
export const TRADE_GROUPS = [PLAN_GROUP, LEVELS_GROUP, TRADES_GROUP];

/** Draw the chart to a PNG with the library's own export (the chart's DOM canvases cannot be read back instead: it paints them off-screen,
 * so they come out blank). Everything on it first; then without overlays in case one of them cannot be drawn; then both again at a pixel
 * ratio of 1, for a chart too large (or a screen too dense) for the browser to allocate the full-size canvas, which makes it return an
 * empty "data:,". */
function exportChart(chart: Chart): ChartImage {
  const background = getComputedStyle(document.body).backgroundColor || "#0f1216";
  const tried: string[] = [];
  // Sharpest first: at least twice the screen's pixel ratio (a picture shared elsewhere is looked at bigger than the chart is on screen),
  // then the screen's own, then ratio 1 for a chart too large to allocate the bigger canvas.
  const dpr = window.devicePixelRatio || 1;
  const sharp = Math.max(2, dpr);
  const attempts: { overlays: boolean; ratio: number | null }[] = [
    { overlays: true, ratio: sharp },
    { overlays: true, ratio: null },
    { overlays: false, ratio: null },
    { overlays: true, ratio: 1 },
    { overlays: false, ratio: 1 },
  ];
  for (const a of attempts) {
    const label = `${a.overlays ? "with" : "without"} overlays${a.ratio != null ? ` at ratio ${a.ratio}` : ""}`;
    try {
      const run = () => chart.getConvertPictureUrl(a.overlays, "png", background);
      const url = a.ratio != null ? withDevicePixelRatio(a.ratio, run) : run();
      if (url && url.startsWith("data:image")) return { url, scale: a.ratio ?? dpr };
      tried.push(`export ${label} gave no image`);
    } catch (e) {
      console.warn(`chart snapshot ${label} failed`, e);
      tried.push(`export ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { problem: `the browser could not draw the chart as an image (${tried.join("; ")})` };
}

/** The visible window of a chart, in terms another chart can follow: the size of a bar and the time at the
 * right-hand edge. `seq` makes each message distinct. */
export type RangeMsg = { barSpace: number; rightTs: number; seq: number };

export type StructureReport = { trendByTf: TrendByTf; setups: ReturnType<typeof liveSetups> };

type Props = {
  /** The series to chart: the resolved chart exchange and symbol (e.g. NSE / NIFTY). */
  exchange: string;
  symbol: string;
  interval: string;
  /** The latest price from the socket or the poll; the newest bar follows it. */
  price: number | null;
  indicators: string[];
  indicatorParams: Record<string, number[]>;
  indicatorsHidden: boolean;
  structure: StructureConfig;
  plan: PlanLine[];
  /** The person's own trades on this instrument, drawn as markers (none by default). */
  trades?: ChartTrade[];
  /** The stop and target of open trades on this instrument, as lines the person can drag (none by default). */
  levels?: OpenLevel[];
  /** A level was dragged to a new price. Answer true if it was accepted; on false the line goes back. */
  onLevelMove?: (level: OpenLevel, price: number) => Promise<boolean> | boolean;
  /** The × on a waiting order's entry line was clicked: cancel that order. */
  onLevelCancel?: (level: OpenLevel) => void;
  /** Support and resistance lines read from the option chain (none by default). */
  oiLevels?: OiLevelLine[];
  magnet: boolean;
  /** Arm a zone with an alert the moment it is drawn (default true). It can still be switched off, and on, per zone afterwards. */
  zoneAlert?: boolean;
  drawingsHidden: boolean;
  /** Set while the person is choosing a price on the chart for a ticket field. */
  pickField: PriceField | null;
  onPick: (price: number) => void;
  /** The person dragged a plan line to a new price (reported once, when they let go). */
  onPlanMove?: (key: PriceField, price: number) => void;
  onDrawingChange?: (state: { drawing: boolean; selected: boolean; selection: SelectionInfo | null }) => void;
  /** An armed drawing was crossed: the words to tell the person. */
  onAlert?: (message: string) => void;
  /** How many drawings on this chart have an alert armed (reported whenever it changes). */
  onArmed?: (count: number) => void;
  onStructure?: (report: StructureReport) => void;
  /** Linking: this chart reports where the pointer is (a bar time, or null when it leaves) and the visible
   * window; it draws the other chart's pointer and follows the other chart's window. */
  onCursor?: (ts: number | null) => void;
  peerCursor?: number | null;
  onRange?: (r: RangeMsg) => void;
  peerRange?: RangeMsg | null;
  /** The person clicked the chart: the time of the bar under the pointer. Not reported while a drawing tool or a price pick is armed, or after a drag. */
  onTimeClick?: (ts: number) => void;
  /** Centre this chart on a time (a click on the linked chart); `seq` makes each request distinct, so clicking the same time again pans back. */
  panTo?: { ts: number; seq: number } | null;
};

type Status = "loading" | "ready" | "error";

const REFRESH_MS = 30_000;
const STRUCTURE_REFRESH_MS = 2 * 60_000;
const MAX_AUTO_RETRIES = 8;
const USER_DRAWINGS = "user-drawings";
const DRAW_TAGS = "draw-tags";

const magnetMode = (on: boolean): OverlayMode => (on ? OverlayMode.WeakMagnet : OverlayMode.Normal);

/** One chart. It draws the candles, follows the live price, and carries the person's indicators, their
 * drawings (saved per instrument) and the structure layer. It owns the library instance and nothing
 * about the screen around it: the toolbar and menus live in the workstation and steer it through props
 * and the imperative handle. */
export const ChartPane = forwardRef<ChartPaneHandle, Props>(function ChartPane(props, ref) {
  const { exchange, symbol, interval, price, indicators, indicatorParams, indicatorsHidden, structure, plan, magnet, drawingsHidden, pickField } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  // The imperative handle below is built once, so it reads the live status through a ref.
  const statusRef = useRef<Status>("loading");
  statusRef.current = status;
  const [message, setMessage] = useState<string | null>(null);
  // Bumped after every full (re)load of the series; later effects re-apply their overlays against it.
  const [epoch, setEpoch] = useState(0);
  // Bumped by the Retry button (and by the automatic retry) to run the download again.
  const [tick, setTick] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const triesRef = useRef(0);
  const seriesKey = useRef("");

  const propsRef = useRef(props);
  propsRef.current = props;
  const barsRef = useRef<Bar[]>([]);
  const anchorRef = useRef<BarAnchor>({ timestamps: [] });
  const drawnRef = useRef<Map<string, StoredDrawing>>(new Map());
  // The default look a drawing being drawn right now was started with (it has no saved entry until it is finished).
  const pendingStyleRef = useRef<DrawingStyle | undefined>(undefined);
  // A text drawing being typed (just placed, or double-clicked to change): where its box sits and what it says so far.
  const [textEdit, setTextEdit] = useState<{ id: string; x: number; y: number; value: string; isNew: boolean; draft: StoredDrawing } | null>(null);
  const textEditRef = useRef(textEdit);
  textEditRef.current = textEdit;
  const pendingRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  // This pane's own id, sent along with every drawings save so it can tell its OWN write apart
  // from a sibling pane's (see DRAWINGS_CHANGED_EVENT's own comment in config.ts).
  const instanceIdRef = useRef(`p${Math.random().toString(36).slice(2)}`);
  const panesRef = useRef<Map<string, string>>(new Map());
  const paramsAppliedRef = useRef<Map<string, string>>(new Map());
  const hoverRef = useRef<number | null>(null);
  const planIds = useRef<Map<string, string>>(new Map());
  const planEpoch = useRef(0);
  const levelIds = useRef<Map<string, string>>(new Map());
  const levelEpoch = useRef(0);
  // Which side of each armed drawing the price was on at the last check, by overlay id.
  const sidesRef = useRef<Map<string, Side>>(new Map());
  const peerCursorId = useRef<string | null>(null);
  const hoverTsRef = useRef<number | null>(null);
  const applyingPeer = useRef(false);
  const seqRef = useRef(0);

  const def = intervalDef(interval);
  const intervalMs = def.minutes * 60_000;

  // ---- lifecycle: one library instance per mounted pane ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    registerChartExtensions();
    const chart = init(el, { styles: chartStyles(), timezone: "Asia/Kolkata", locale: "en-US" });
    if (!chart) return;
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    // Follow the system light/dark setting live, so the canvas does not stay dark on a light page.
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const onScheme = () => chart.setStyles(chartStyles(prefersLight()));
    mq?.addEventListener?.("change", onScheme);

    // Delete or Backspace removes the selected drawing, unless the person is typing in a field.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const id = selectedRef.current;
      if (!id) return;
      const t = ev.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      ev.preventDefault();
      chart.removeOverlay(id);
    };
    window.addEventListener("keydown", onKey);

    // Linking: report the pointer's bar time and the visible window to whoever is listening.
    const onCursor = (data?: unknown) => {
      const c = data as Crosshair | undefined;
      const ts = c?.kLineData?.timestamp;
      hoverTsRef.current = typeof ts === "number" ? ts : null;
      propsRef.current.onCursor?.(typeof ts === "number" ? ts : null);
    };
    chart.subscribeAction(ActionType.OnCrosshairChange, onCursor);
    const onRange = () => {
      if (applyingPeer.current) return;
      const list = chart.getDataList();
      const to = Math.min(list.length - 1, Math.round(chart.getVisibleRange().to));
      const rightTs = list[to]?.timestamp;
      if (rightTs == null) return;
      propsRef.current.onRange?.({ barSpace: chart.getBarSpace(), rightTs, seq: ++seqRef.current });
    };
    chart.subscribeAction(ActionType.OnVisibleRangeChange, onRange);

    return () => {
      chart.unsubscribeAction(ActionType.OnCrosshairChange, onCursor);
      chart.unsubscribeAction(ActionType.OnVisibleRangeChange, onRange);
      ro.disconnect();
      mq?.removeEventListener?.("change", onScheme);
      window.removeEventListener("keydown", onKey);
      dispose(el);
      chartRef.current = null;
      panesRef.current.clear();
      paramsAppliedRef.current.clear();
      drawnRef.current.clear();
    };
  }, []);

  // ---- candles: load on a new series or interval, then top up on a timer ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;
    let retry: number | undefined;
    // A different series starts with a fresh allowance of automatic retries.
    const key = `${exchange}|${symbol}|${interval}`;
    if (seriesKey.current !== key) {
      seriesKey.current = key;
      triesRef.current = 0;
    }
    setStatus("loading");
    setMessage(null);

    async function load(initial: boolean) {
      let raw;
      try {
        raw = await getCandles(exchange, symbol, interval, def.lookbackDays, new Date(), def.source);
      } catch (e) {
        if (!cancelled && initial) {
          setStatus("error");
          setMessage(e instanceof Error ? e.message : "Could not load candles.");
          // The data provider is rate-limited and often says "try again shortly": do that for the person,
          // a few times, with a growing pause, before leaving them the Retry button.
          const more = triesRef.current < MAX_AUTO_RETRIES;
          setRetrying(more);
          if (more) {
            triesRef.current += 1;
            retry = window.setTimeout(() => setTick((n) => n + 1), Math.min(3_000 * triesRef.current, 12_000));
          }
        }
        return;
      }
      if (cancelled) return;
      const bars = raw.map(toKLine).filter((b) => Number.isFinite(b.timestamp));
      if (bars.length === 0) {
        if (initial) {
          setStatus("error");
          setMessage(`No candles for ${symbol} at ${def.label}. The market may be closed, or this size is not available for it.`);
        }
        return;
      }
      if (initial) {
        chart!.setPriceVolumePrecision(pricePrecision(bars[bars.length - 1].close), 0);
        chart!.applyNewData(bars);
        barsRef.current = bars;
        anchorRef.current = { timestamps: bars.map((b) => b.timestamp) };
        setStatus("ready");
        setMessage(null);
        setEpoch((n) => n + 1);
      } else {
        // updateData appends a newer bar and replaces an equal one, so a bar we started from a tick
        // becomes its real self when the download catches up.
        const lastKnown = barsRef.current[barsRef.current.length - 1]?.timestamp ?? 0;
        for (const b of bars) if (b.timestamp >= lastKnown) chart!.updateData(b);
        const merged = new Map(barsRef.current.map((b) => [b.timestamp, b] as const));
        for (const b of bars) merged.set(b.timestamp, b);
        barsRef.current = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
        anchorRef.current = { timestamps: barsRef.current.map((b) => b.timestamp) };
        repinDrawings();
      }
    }

    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- def is derived from interval
  }, [exchange, symbol, interval, tick]);

  // ---- the newest bar follows the price ----
  // Runs on every genuine price change, so a real tick shows at once - and also on a steady timer, so
  // the current bar still rolls into a fresh one right at its own boundary even when the price has not
  // moved since the last tick. A live feed pushes on a trade, not on a clock; two ticks reporting the
  // identical price never change React's own `price` prop, so without the timer the last candle would
  // sit well past when it should have closed, waiting for a price that happens to differ from before -
  // "the chart is delayed to refresh" for anything quiet enough to go a while between real moves.
  function rollTick() {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    const bars = barsRef.current;
    const last = bars[bars.length - 1];
    const tickPrice = propsRef.current.price;
    const next = rollLiveBar(last ?? null, tickPrice, Date.now(), intervalMs, def.value !== "daily");
    if (next) {
      chart.updateData(next);
      barsRef.current = last && last.timestamp === next.timestamp ? [...bars.slice(0, -1), next] : [...bars, next];
      anchorRef.current = { timestamps: barsRef.current.map((b) => b.timestamp) };
      if (!last || last.timestamp !== next.timestamp) repinDrawings();
    }
    if (tickPrice == null) return;
    // Armed drawings: one that has not been looked at yet only learns which side it is on; a new bar
    // starting means the one before it has closed, which "on a close" alerts judge by; every price judges
    // the "as it crosses" ones.
    seedAlerts(tickPrice);
    if (next && last && next.timestamp !== last.timestamp) runAlerts("close", last.close);
    runAlerts("cross", tickPrice);
  }
  useEffect(rollTick, [price, status, intervalMs, def.value]); // eslint-disable-line react-hooks/exhaustive-deps -- rollTick reads refs/propsRef fresh
  useEffect(() => {
    if (status !== "ready") return;
    const id = window.setInterval(rollTick, 1_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollTick reads refs/propsRef fresh; only these three actually change what it does
  }, [status, intervalMs, def.value]);

  // ---- linking: draw the other chart's pointer, and follow its window ----
  const peerCursor = props.peerCursor ?? null;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    if (peerCursor == null) {
      if (peerCursorId.current) chart.removeOverlay(peerCursorId.current);
      peerCursorId.current = null;
      return;
    }
    const value = barsRef.current[barsRef.current.length - 1]?.close ?? 0;
    if (peerCursorId.current) {
      chart.overrideOverlay({ id: peerCursorId.current, points: [{ timestamp: peerCursor, value }] });
    } else {
      const id = chart.createOverlay({ name: "peerCursor", groupId: PEER_GROUP, lock: true, points: [{ timestamp: peerCursor, value }] });
      peerCursorId.current = typeof id === "string" ? id : null;
    }
  }, [peerCursor, status]);

  // ---- a click on the chart: report its time (a drag is panning, not a click) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el || status !== "ready") return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
      down = null;
      if (moved > 5) return;
      if (pendingRef.current || propsRef.current.pickField) return; // drawing, or picking a price: the click means something else
      // The bar under the pointer, read from where the click landed - the crosshair's last report can be a move behind.
      let ts: number | null = null;
      try {
        const found = chartRef.current?.convertFromPixel([{ x: e.clientX - el.getBoundingClientRect().left, y: 0 }], { paneId: "candle_pane" });
        const point = Array.isArray(found) ? found[0] : found;
        if (typeof point?.timestamp === "number") ts = point.timestamp;
      } catch {
        /* fall back to the crosshair's own report */
      }
      ts ??= hoverTsRef.current;
      if (ts != null) propsRef.current.onTimeClick?.(ts);
    };
    el.addEventListener("mousedown", onDown);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("click", onClick);
    };
  }, [status, epoch]);

  // ---- pan to a time clicked on the linked chart: centre it, or as near as the loaded bars allow ----
  const panTo = props.panTo ?? null;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready" || !panTo) return;
    const list = chart.getDataList();
    if (list.length === 0) return;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].timestamp < panTo.ts) lo = mid + 1;
      else hi = mid;
    }
    const range = chart.getVisibleRange();
    const half = Math.floor((range.to - range.from) / 2);
    applyingPeer.current = true; // the scroll below is ours: the scroll link must not echo it back
    chart.scrollToDataIndex(Math.min(list.length - 1, lo + half));
    window.setTimeout(() => {
      applyingPeer.current = false;
    }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request (its seq) pans; the chart's own data is read when it does
  }, [panTo?.seq, status]);

  const peerRange = props.peerRange ?? null;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready" || !peerRange) return;
    // Already there (the echo of our own report, or a chart that has not moved): touch nothing, so two
    // charts settle after one exchange instead of trading messages.
    const list = chart.getDataList();
    const nowTo = Math.min(list.length - 1, Math.round(chart.getVisibleRange().to));
    if (chart.getBarSpace() === peerRange.barSpace && list[nowTo]?.timestamp === peerRange.rightTs) return;
    applyingPeer.current = true;
    chart.setBarSpace(peerRange.barSpace);
    chart.scrollToTimestamp(peerRange.rightTs);
    // The library reports the change we just caused; ignore that echo so two charts cannot chase each other.
    window.setTimeout(() => {
      applyingPeer.current = false;
    }, 60);
  }, [peerRange, status]);

  // ---- indicators: reconcile what is on the chart with what is wanted ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wanted = indicatorsHidden ? [] : indicators;
    const desired = new Set(wanted);
    for (const [name, paneId] of [...panesRef.current]) {
      if (!desired.has(name)) {
        chart.removeIndicator(paneId, name);
        panesRef.current.delete(name);
        paramsAppliedRef.current.delete(name);
      }
    }
    for (const name of wanted) {
      const d = INDICATOR_BY_NAME.get(name);
      if (!d) continue;
      const calcParams = effectiveParams(name, indicatorParams);
      const key = calcParams ? calcParams.join(",") : "";
      if (panesRef.current.has(name)) {
        if (calcParams && paramsAppliedRef.current.get(name) !== key) {
          chart.overrideIndicator({ name, calcParams }, panesRef.current.get(name));
          paramsAppliedRef.current.set(name, key);
        }
        continue;
      }
      const paneId = chart.createIndicator(calcParams ? { name, calcParams } : name, d.overlay, d.overlay ? { id: "candle_pane" } : { id: `${name.toLowerCase()}_pane` });
      if (typeof paneId === "string") {
        panesRef.current.set(name, paneId);
        paramsAppliedRef.current.set(name, key);
      }
    }
  }, [indicators, indicatorParams, indicatorsHidden]);

  // ---- the trade plan: entry, stop and target drawn as levels the person can drag ----
  // Each level keeps ONE overlay for as long as it exists: a changed price moves it (so a drag in
  // progress is never interrupted by a redraw), a cleared one removes it. A reloaded series starts them
  // again from nothing, since the old anchors belong to the old bars.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    if (planEpoch.current !== epoch) {
      planEpoch.current = epoch;
      chart.removeOverlay({ groupId: PLAN_GROUP });
      planIds.current.clear();
    }
    const anchor = barsRef.current[barsRef.current.length - 1]?.timestamp;
    if (anchor == null) return;
    const wanted = new Set<string>(plan.map((l) => l.key));
    for (const [key, id] of [...planIds.current]) {
      if (!wanted.has(key)) {
        chart.removeOverlay(id);
        planIds.current.delete(key);
      }
    }
    for (const l of plan) {
      const extendData: PlanLineExtend = { key: l.key, label: l.label, color: l.color, dashed: l.dashed ?? true };
      const points = [{ timestamp: anchor, value: l.price }];
      const existing = planIds.current.get(l.key);
      if (existing) {
        chart.overrideOverlay({ id: existing, points, extendData });
        continue;
      }
      const id = chart.createOverlay({
        name: "planLine",
        groupId: PLAN_GROUP,
        points,
        extendData,
        onPressedMoveEnd: (e: OverlayEvent) => {
          const v = e.overlay.points[0]?.value;
          if (typeof v === "number" && Number.isFinite(v)) propsRef.current.onPlanMove?.(l.key, Number(v.toFixed(pricePrecision(v))));
          return false;
        },
      });
      if (typeof id === "string") planIds.current.set(l.key, id);
    }
  }, [plan, status, epoch]);

  // ---- the stop and target of open trades: lines that can be dragged, and go back if refused ----
  // One overlay per level for as long as it exists, like the plan lines: a changed price moves it, a
  // level that is gone is removed, a reloaded series starts from nothing. A stop that trails by itself is
  // drawn locked (it cannot be picked up).
  const levels = props.levels;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    if (levelEpoch.current !== epoch) {
      levelEpoch.current = epoch;
      chart.removeOverlay({ groupId: LEVELS_GROUP });
      levelIds.current.clear();
    }
    const anchor = barsRef.current[barsRef.current.length - 1]?.timestamp;
    if (anchor == null) return;
    const wanted = new Set((levels ?? []).map((l) => l.key));
    for (const [key, id] of [...levelIds.current]) {
      if (!wanted.has(key)) {
        chart.removeOverlay(id);
        levelIds.current.delete(key);
      }
    }
    for (const l of levels ?? []) {
      const extendData: PlanLineExtend = { key: l.key, label: l.label, color: l.field === "stop" ? "#e8586a" : l.field === "target" ? "#3ecf8e" : "#4c8dff", dashed: l.kind === "waiting", cancellable: l.cancellable === true };
      const points = [{ timestamp: anchor, value: l.price }];
      const existing = levelIds.current.get(l.key);
      if (existing) {
        chart.overrideOverlay({ id: existing, points, extendData });
        continue;
      }
      const id = chart.createOverlay({
        name: "planLine",
        groupId: LEVELS_GROUP,
        points,
        extendData,
        lock: !l.draggable,
        onClick: (e: OverlayEvent) => {
          if (e.figureKey !== "close") return false;
          const current = propsRef.current.levels?.find((x) => x.key === l.key);
          if (current?.cancellable) propsRef.current.onLevelCancel?.(current);
          return false;
        },
        onPressedMoveEnd: (e: OverlayEvent) => {
          const v = e.overlay.points[0]?.value;
          const current = propsRef.current.levels?.find((x) => x.key === l.key);
          if (!current || typeof v !== "number" || !Number.isFinite(v)) return false;
          const price = Number(v.toFixed(pricePrecision(v)));
          void (async () => {
            let accepted = false;
            try {
              accepted = (await propsRef.current.onLevelMove?.(current, price)) === true;
            } catch {
              accepted = false;
            }
            if (accepted) return; // the page reloads the trade and the line follows the saved price
            const back = propsRef.current.levels?.find((x) => x.key === l.key);
            const lineId = levelIds.current.get(l.key);
            if (back && lineId) chartRef.current?.overrideOverlay({ id: lineId, points: [{ timestamp: anchor, value: back.price }] });
          })();
          return false;
        },
      });
      if (typeof id === "string") levelIds.current.set(l.key, id);
    }
    // A thin vertical line joining each trade's stop, entry and target, so the three read as one box (rebuilt whole: it is cheap and has no state).
    chart.removeOverlay({ name: "tradeSpan" });
    const byTrade = new Map<string, number[]>();
    for (const l of levels ?? []) byTrade.set(`${l.kind}:${l.tradeId}`, [...(byTrade.get(`${l.kind}:${l.tradeId}`) ?? []), l.price]);
    for (const prices of byTrade.values()) {
      if (prices.length < 2) continue;
      chart.createOverlay({ name: "tradeSpan", groupId: LEVELS_GROUP, lock: true, points: [{ timestamp: anchor, value: Math.min(...prices) }, { timestamp: anchor, value: Math.max(...prices) }] });
    }
  }, [levels, status, epoch]);

  // ---- the person's own trades: an arrow at each entry, an exit mark and a result ----
  // Redrawn whole on each change (a poll brings new results), and against the loaded series: a trade from
  // before the first candle has nowhere to be drawn.
  const trades = props.trades;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    chart.removeOverlay({ groupId: TRADES_GROUP });
    const first = barsRef.current[0]?.timestamp ?? 0;
    for (const t of trades ?? []) {
      if (t.entryTs < first) continue;
      const closedWithExit = t.state === "closed" && t.exitTs != null && t.exitPrice != null;
      const points = closedWithExit
        ? [{ timestamp: t.entryTs, value: t.entryPrice }, { timestamp: t.exitTs as number, value: t.exitPrice as number }]
        : [{ timestamp: t.entryTs, value: t.entryPrice }];
      const extendData: TradeMarkerExtend = { kind: t.kind, side: t.side, state: t.state, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnl: t.pnl, label: t.label, reason: t.reason };
      chart.createOverlay({ name: "tradeMarker", groupId: TRADES_GROUP, lock: true, points, extendData });
    }
  }, [trades, status, epoch]);

  // ---- support and resistance from the option chain ----
  const oiLevels = props.oiLevels;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    chart.removeOverlay({ groupId: OI_GROUP });
    const anchor = barsRef.current[barsRef.current.length - 1]?.timestamp;
    if (anchor == null) return;
    for (const l of oiLevels ?? []) chart.createOverlay({ name: "oiLevel", groupId: OI_GROUP, lock: true, points: [{ timestamp: anchor, value: l.price }], extendData: l });
  }, [oiLevels, status, epoch]);

  // ---- drawings: saved per instrument, restored after every load ----
  const persist = () => {
    const all = [...drawnRef.current.values()];
    saveDrawings(propsRef.current.exchange, propsRef.current.symbol, all, instanceIdRef.current);
    // the armed zones and levels are also watched by the server, so a touch reaches Telegram with every tab closed
    scheduleZoneSync(propsRef.current.exchange, propsRef.current.symbol, propsRef.current.interval, all);
  };

  // A drawing being dragged. The library only reports the end of a drag when the mouse is released over the chart's own plot area: let
  // go over the price axis, between two panes or outside the window and that report never comes, so the change was neither saved nor
  // shown on a sibling chart. The window-level release below finishes the job in that case.
  const draggingRef = useRef<string | null>(null);
  useEffect(() => {
    const released = () => {
      const id = draggingRef.current;
      if (!id) return;
      window.setTimeout(() => {
        if (draggingRef.current !== id) return; // the library saw the release itself and has already saved it
        draggingRef.current = null;
        const overlay = chartRef.current?.getOverlayById?.(id);
        if (!overlay || !drawnRef.current.has(id)) return;
        drawnRef.current.set(id, serialize(overlay));
        sidesRef.current.delete(id);
        syncTag(id);
        persist();
        emitDrawing();
      }, 0);
    };
    window.addEventListener("mouseup", released, true);
    window.addEventListener("pointerup", released, true);
    window.addEventListener("touchend", released, true);
    return () => {
      window.removeEventListener("mouseup", released, true);
      window.removeEventListener("pointerup", released, true);
      window.removeEventListener("touchend", released, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- serialize/persist/emitDrawing read refs and propsRef only
  }, []);

  // ---- drawing aids: a zone's corners snap to a candle's high/low with the magnet on; Shift keeps a line level ----
  const shiftRef = useRef(false);
  useEffect(() => {
    const set = (down: boolean) => (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftRef.current = down;
    };
    const up = set(false);
    const down = set(true);
    const reset = () => {
      shiftRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  /** The price a drawing's point at `index` should take, given what is held down and the magnet; null leaves the library's own value. */
  function adjustedValue(overlay: Overlay, index: number, point: { dataIndex?: number; value?: number }): number | null {
    const chart = chartRef.current;
    if (!chart || point.value == null) return null;
    if (shiftRef.current) {
      const flat = levelWithOtherEnd(overlay.name, index, overlay.points.map((p) => p.value));
      if (flat != null) return flat;
    }
    if (overlay.name === "rect" && propsRef.current.magnet && typeof point.dataIndex === "number") {
      const candle = chart.getDataList()[point.dataIndex];
      if (!candle) return null;
      // The magnet's own sensitivity (8 px) as a price distance on this chart's scale.
      const ys = chart.convertFromPixel([{ x: 0, y: 0 }, { x: 0, y: 8 }], { paneId: "candle_pane" }) as Array<{ value?: number }>;
      const reach = ys?.[0]?.value != null && ys?.[1]?.value != null ? Math.abs(ys[1].value - ys[0].value) : 0;
      return snapZoneCorner(point.value, candle, reach);
    }
    return null;
  }

  // The candle a zone sits on when a whole-zone drag begins (its left edge): holding Shift while dragging puts its top and bottom on that
  // candle's high and low, wherever the drag has taken it in time.
  const zoneOriginRef = useRef<{ id: string; wick: Wick } | null>(null);

  const handlers = () => ({
    // While a drawing is being placed, the library has just put its point under the cursor (and under its own magnet): adjust it.
    onDrawing: (e: OverlayEvent) => {
      const index = e.figureIndex ?? e.overlay.points.length - 1;
      const point = e.overlay.points[index];
      if (point) {
        const value = adjustedValue(e.overlay, index, point);
        if (value != null) point.value = value;
      }
      return false;
    },
    // Dragging a corner or an end of a finished drawing: the library would set the point itself, so do it here with the adjustment.
    onPressedMoving: (e: OverlayEvent) => {
      const origin = zoneOriginRef.current;
      if (origin && origin.id === e.overlay.id && shiftRef.current && !/point_\d+$/.test(e.figureKey ?? "")) {
        // Let the library move the zone as usual, then put its edges on the origin candle (the next tick: its own move runs right after this).
        const id = e.overlay.id;
        queueMicrotask(() => {
          const o = chartRef.current?.getOverlayById?.(id);
          if (!o || o.points.length < 2 || o.points[0].value == null || o.points[1].value == null) return;
          const [a, b] = zoneOnWick([o.points[0].value, o.points[1].value], origin.wick);
          chartRef.current?.overrideOverlay({ id, points: [{ ...o.points[0], value: a }, { ...o.points[1], value: b }] });
        });
        return false;
      }
      const index = e.figureIndex ?? -1;
      if (index < 0 || !/point_\d+$/.test(e.figureKey ?? "") || e.x == null || e.y == null) return false;
      const wants = shiftRef.current || (e.overlay.name === "rect" && propsRef.current.magnet);
      const chart = chartRef.current;
      const instance = e.overlay as unknown as { eventPressedPointMove?: (point: unknown, index: number) => void };
      if (!wants || !chart || typeof instance.eventPressedPointMove !== "function") return false;
      const found = chart.convertFromPixel([{ x: e.x, y: e.y }], { paneId: "candle_pane" });
      const point = (Array.isArray(found) ? found[0] : found) as { dataIndex?: number; timestamp?: number; value?: number } | undefined;
      if (!point || point.value == null) return false;
      const value = adjustedValue(e.overlay, index, point);
      if (value == null) return false;
      instance.eventPressedPointMove({ ...point, value }, index);
      return true;
    },
    onDrawEnd: (e: OverlayEvent) => {
      pendingRef.current = null;
      if (e.overlay.name === "textNote") {
        // Placed, but it has no words yet: ask for them, and only keep it once there are some.
        beginTextEdit(e.overlay, true);
        emitDrawing();
        return false;
      }
      const drawn = serialize(e.overlay);
      // A zone is drawn to be watched: it is armed straight away (the person can switch it off), and starts from where the price is now.
      const arm = e.overlay.name === "rect" && !drawn.alert && propsRef.current.zoneAlert !== false;
      drawnRef.current.set(e.overlay.id, arm ? { ...drawn, alert: { trigger: "cross" } } : drawn);
      if (arm) {
        const z = alertZone(drawn);
        const price = propsRef.current.price;
        if (price != null && z) sidesRef.current.set(e.overlay.id, sideOf(price, z));
        emitArmed();
      }
      syncTag(e.overlay.id);
      persist();
      emitDrawing();
      return false;
    },
    onDoubleClick: (e: OverlayEvent) => {
      if (e.overlay.name === "textNote") beginTextEdit(e.overlay, false);
      return false;
    },
    onPressedMoveStart: (e: OverlayEvent) => {
      draggingRef.current = e.overlay.id;
      zoneOriginRef.current = null;
      if (e.overlay.name === "rect" && e.overlay.points.length >= 2 && !/point_\d+$/.test(e.figureKey ?? "")) {
        const left = Math.min(...e.overlay.points.map((p) => p.timestamp ?? Infinity));
        const candle = chartRef.current ? candleAtOrBefore(chartRef.current.getDataList(), Number.isFinite(left) ? left : undefined) : null;
        if (candle) zoneOriginRef.current = { id: e.overlay.id, wick: { high: candle.high, low: candle.low } };
      }
      return false;
    },
    onPressedMoveEnd: (e: OverlayEvent) => {
      draggingRef.current = null;
      drawnRef.current.set(e.overlay.id, serialize(e.overlay));
      sidesRef.current.delete(e.overlay.id); // it moved: the next price only learns its side, it cannot cross
      syncTag(e.overlay.id);
      persist();
      emitDrawing();
      return false;
    },
    onRemoved: (e: OverlayEvent) => {
      if (selectedRef.current === e.overlay.id) selectedRef.current = null;
      if (pendingRef.current === e.overlay.id) pendingRef.current = null;
      if (!restoringRef.current) {
        removeTag(e.overlay.id, true);
        drawnRef.current.delete(e.overlay.id);
        sidesRef.current.delete(e.overlay.id);
        persist();
      }
      emitDrawing();
      emitArmed();
      return false;
    },
    onSelected: (e: OverlayEvent) => {
      selectedRef.current = e.overlay.id;
      emitDrawing();
      return false;
    },
    onDeselected: (e: OverlayEvent) => {
      if (selectedRef.current === e.overlay.id) selectedRef.current = null;
      emitDrawing();
      return false;
    },
    // Right-click deletes: the library ships no delete affordance and a 1px line is hard to aim at.
    onRightClick: (e: OverlayEvent) => {
      chartRef.current?.removeOverlay(e.overlay.id);
      return true;
    },
  });

  function serialize(o: Overlay): StoredDrawing {
    const alert = drawnRef.current.get(o.id)?.alert;
    const text = o.name === "textNote" ? ((o.extendData as { text?: string } | undefined)?.text ?? drawnRef.current.get(o.id)?.text) : undefined;
    const saved = drawnRef.current.get(o.id);
    const label = saved?.label;
    const style = saved ? saved.style : pendingStyleRef.current; // a new drawing starts from the default look; a finished one keeps its own
    return {
      name: o.name,
      points: o.points.map((p) => ({ timestamp: pointTimestamp(p, anchorRef.current), value: p.value })),
      ...(alert ? { alert } : {}),
      ...(text ? { text } : {}),
      ...(label ? { label } : {}),
      ...(style ? { style } : {}),
    };
  }

  // ---- the label / alert bell on a drawing: a companion pill, kept in step with its drawing ----
  const tagsRef = useRef<Map<string, string>>(new Map());
  /** `afterLibrary`: from inside the library's own removal callback (a drawing's onRemoved). klinecharts' removeInstance builds its filtered overlay
   * list while it loops and assigns it back when the loop ends, so a removal made from within that callback is overwritten and the pill comes
   * back (it then vanished only on a refresh). Removing it one tick later, once the library is done, sticks. */
  function removeTag(id: string, afterLibrary = false) {
    const tag = tagsRef.current.get(id);
    tagsRef.current.delete(id);
    if (!tag) return;
    if (afterLibrary) queueMicrotask(() => chartRef.current?.removeOverlay(tag));
    else chartRef.current?.removeOverlay(tag);
  }
  function syncTag(id: string) {
    const chart = chartRef.current;
    const d = drawnRef.current.get(id);
    if (!chart) return;
    const bell = d?.alert ? (d.alert.trigger === "close" ? "🔔 close" : "🔔") : "";
    const text = [bell, d?.label].filter(Boolean).join(" ");
    const p0 = d?.points[0];
    if (!d || d.name === "textNote" || !text || !p0 || typeof p0.value !== "number") {
      removeTag(id);
      return;
    }
    // A zone's pill sits on its top edge; every other drawing's at its own first point.
    const top = d.name === "rect" ? Math.max(...d.points.map((p) => p.value ?? -Infinity)) : p0.value;
    const point = toChartPoint({ ...p0, value: Number.isFinite(top) ? top : p0.value }, anchorRef.current);
    const extendData: DrawTagExtend = { text, color: d.style?.color ?? ACCENT, edge: d.name === "horizontalStraightLine" || d.name === "priceLine" ? "right" : "point" };
    const existing = tagsRef.current.get(id);
    if (existing) {
      chart.overrideOverlay({ id: existing, points: [point], extendData, visible: !propsRef.current.drawingsHidden });
      return;
    }
    const tag = chart.createOverlay({ name: "drawTag", groupId: DRAW_TAGS, lock: true, visible: !propsRef.current.drawingsHidden, points: [point], extendData });
    if (typeof tag === "string") tagsRef.current.set(id, tag);
  }

  /** Put a drawing's look on the chart now. */
  function applyStyle(id: string, name: string, style: DrawingStyle | undefined, text?: string) {
    const chart = chartRef.current;
    if (!chart) return;
    if (name === "textNote") chart.overrideOverlay({ id, extendData: { text: text ?? "", style } });
    else {
      if (name === "rect") chart.overrideOverlay({ id, extendData: { noMid: style?.noMid === true } });
      const styles = toOverlayStyles(name, style);
      if (styles) chart.overrideOverlay({ id, styles });
    }
  }

  // ---- text drawings: typed into a small box right on the chart ----
  function beginTextEdit(o: Overlay, isNew: boolean) {
    const chart = chartRef.current;
    const p = o.points[0];
    if (!chart || !p) return;
    const px = (chart as unknown as { convertToPixel?: (pt: unknown, f: unknown) => { x?: number; y?: number } | { x?: number; y?: number }[] }).convertToPixel?.(p, { paneId: "candle_pane" });
    const at = Array.isArray(px) ? px[0] : px;
    const current = (o.extendData as { text?: string } | undefined)?.text ?? drawnRef.current.get(o.id)?.text ?? "";
    setTextEdit({ id: o.id, x: at?.x ?? 40, y: at?.y ?? 40, value: current, isNew, draft: serialize(o) });
  }

  function finishTextEdit(commit: boolean) {
    const edit = textEditRef.current;
    if (!edit) return;
    setTextEdit(null);
    textEditRef.current = null;
    const chart = chartRef.current;
    const words = edit.value.trim().slice(0, TEXT_DRAWING_MAX);
    if (!chart) return;
    if (!commit || words === "") {
      if (edit.isNew) chart.removeOverlay(edit.id); // nothing typed: the label is not kept
      return;
    }
    chart.overrideOverlay({ id: edit.id, extendData: { text: words, style: edit.draft.style } });
    drawnRef.current.set(edit.id, { ...edit.draft, text: words });
    persist();
    emitDrawing();
  }

  // ---- alerts on drawings ----
  /** What the page is told about the drawing state: drawing in progress, something selected, and, for a
   * selected line or zone, whether it is armed and where it is. */
  function emitDrawing() {
    const id = selectedRef.current;
    const d = id ? drawnRef.current.get(id) : undefined;
    const selection: SelectionInfo | null = d
      ? {
          alertable: ALERTABLE.has(d.name),
          server: SERVER_WATCHED.has(d.name),
          trigger: d.alert?.trigger ?? null,
          level: levelText(d),
          ...(d.label ? { label: d.label } : {}),
          look: { name: d.name, style: d.style ?? {}, hasDefault: loadDrawingDefaults()[d.name] !== undefined },
        }
      : null;
    propsRef.current.onDrawingChange?.({ drawing: pendingRef.current != null, selected: id != null, selection });
  }
  function emitArmed() {
    let n = 0;
    for (const d of drawnRef.current.values()) if (d.alert) n += 1;
    propsRef.current.onArmed?.(n);
  }
  function seedAlerts(price: number) {
    for (const [id, d] of drawnRef.current) {
      if (!d.alert || sidesRef.current.has(id)) continue;
      const z = alertZone(d);
      if (z) sidesRef.current.set(id, sideOf(price, z));
    }
  }
  function runAlerts(phase: Trigger, price: number) {
    for (const [id, d] of drawnRef.current) {
      if (d.alert?.trigger !== phase) continue;
      const r = checkAlert(propsRef.current.symbol, d, phase, sidesRef.current.get(id) ?? null, price);
      if (!r) continue;
      sidesRef.current.set(id, r.side);
      if (r.message) propsRef.current.onAlert?.(r.message);
    }
  }

  // (Re)builds every drawing overlay from what's saved for this pane's own (exchange, symbol) -
  // used both when THIS pane loads a genuinely new series (the [epoch] effect below) and when a
  // SIBLING pane showing the same instrument, at whatever interval, just changed them (the
  // DRAWINGS_CHANGED_EVENT listener further down) - drawings are shared across every interval of
  // one instrument by design (see drawingsKey's own comment in config.ts).
  /** A drawing sits on a bar NUMBER, not a time, so it stays put only while the bars before it do: a new bar (or older history) arriving makes the
   * number mean a different time, and a zone reaching past the newest bar slides one bar later with every new bar. Put each drawing's points back
   * on the times they were saved at, against the bars as they are now. Not while one is being dragged. */
  function repinDrawings() {
    const chart = chartRef.current;
    if (!chart || draggingRef.current || pendingRef.current) return;
    for (const [id, d] of drawnRef.current) {
      chart.overrideOverlay({ id, points: d.points.map((p) => toChartPoint(p, anchorRef.current)) });
    }
  }

  function reloadDrawings() {
    const chart = chartRef.current;
    if (!chart) return;
    // Wipe only the drawings (by id): the plan and structure layers are theirs to manage.
    restoringRef.current = true;
    for (const id of [...tagsRef.current.keys()]) removeTag(id);
    for (const id of drawnRef.current.keys()) chart.removeOverlay(id);
    drawnRef.current.clear();
    for (const d of loadDrawings(propsRef.current.exchange, propsRef.current.symbol)) {
      const id = chart.createOverlay({
        name: d.name,
        groupId: USER_DRAWINGS,
        points: d.points.map((p) => toChartPoint(p, anchorRef.current)),
        mode: magnetMode(propsRef.current.magnet),
        ...(d.name === "textNote" ? { extendData: { text: d.text ?? "", style: d.style } } : {}),
        ...(d.name === "rect" ? { extendData: { noMid: d.style?.noMid === true } } : {}),
        ...(toOverlayStyles(d.name, d.style) ? { styles: toOverlayStyles(d.name, d.style) } : {}),
        ...handlers(),
      });
      if (typeof id === "string") {
        drawnRef.current.set(id, d);
        syncTag(id);
      }
    }
    restoringRef.current = false;
    sidesRef.current.clear();
    // A restored alert starts from where the price is now, not from whichever tick happens to come next.
    if (propsRef.current.price != null) seedAlerts(propsRef.current.price);
    emitArmed();
    // Zones armed before the server watched them (or on this browser's last visit) are sent now. Only when there are some: an empty set is sent
    // when the person deletes a zone, never on load, because a browser with no drawings (another device, cleared storage) must not wipe the
    // zones the server already watches for them.
    const all = [...drawnRef.current.values()];
    if (all.some((d) => d.alert && SERVER_WATCHED.has(d.name))) scheduleZoneSync(propsRef.current.exchange, propsRef.current.symbol, propsRef.current.interval, all);
  }

  useEffect(() => {
    if (epoch === 0) return;
    reloadDrawings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers() and the saved set read refs only; a new series always bumps epoch
  }, [epoch]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const { exchange, symbol, origin } = (e as CustomEvent<DrawingsChangedDetail>).detail;
      // Not our own write (already reflected here) and genuinely the same instrument this pane is
      // showing right now - only interval is allowed to differ, that's the whole point.
      if (origin === instanceIdRef.current) return;
      if (exchange !== propsRef.current.exchange || symbol !== propsRef.current.symbol) return;
      reloadDrawings();
    };
    window.addEventListener(DRAWINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DRAWINGS_CHANGED_EVENT, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadDrawings reads refs/propsRef only, stable enough not to need re-subscribing
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const id of drawnRef.current.keys()) chart.overrideOverlay({ id, visible: !drawingsHidden, mode: magnetMode(magnet) });
    chart.overrideOverlay({ groupId: DRAW_TAGS, visible: !drawingsHidden });
  }, [drawingsHidden, magnet, epoch]);

  useImperativeHandle(ref, () => ({
    startDrawing(tool) {
      const chart = chartRef.current;
      if (!chart) return;
      if (pendingRef.current) chart.removeOverlay(pendingRef.current);
      // A new drawing of this kind starts with the look the person made the default for it, if they did.
      const start = loadDrawingDefaults()[tool];
      pendingStyleRef.current = start;
      const id = chart.createOverlay({
        name: tool,
        groupId: USER_DRAWINGS,
        mode: magnetMode(propsRef.current.magnet),
        ...(tool === "textNote" ? { extendData: { text: "", style: start } } : {}),
        ...(tool === "rect" ? { extendData: { noMid: start?.noMid === true } } : {}),
        ...(toOverlayStyles(tool, start) ? { styles: toOverlayStyles(tool, start) } : {}),
        ...handlers(),
      });
      pendingRef.current = typeof id === "string" ? id : null;
      emitDrawing();
    },
    cancelDrawing() {
      if (pendingRef.current) chartRef.current?.removeOverlay(pendingRef.current);
      pendingRef.current = null;
      emitDrawing();
    },
    clearDrawings() {
      const chart = chartRef.current;
      if (!chart) return;
      for (const id of [...tagsRef.current.keys()]) removeTag(id);
      for (const id of [...drawnRef.current.keys()]) chart.removeOverlay(id);
      drawnRef.current.clear();
      sidesRef.current.clear();
      persist();
      emitArmed();
    },
    setSelectedStyle(patch) {
      const id = selectedRef.current;
      const chart = chartRef.current;
      const d = id ? drawnRef.current.get(id) : undefined;
      if (!id || !chart || !d) return;
      const style = mergeStyle(d.style, patch);
      const { style: _old, ...rest } = d;
      void _old;
      drawnRef.current.set(id, style ? { ...rest, style } : rest);
      applyStyle(id, d.name, style, d.text);
      syncTag(id);
      persist();
      emitDrawing();
    },
    resetSelectedStyle() {
      const id = selectedRef.current;
      const d = id ? drawnRef.current.get(id) : undefined;
      if (!id || !d) return;
      const { style: _old, ...rest } = d;
      void _old;
      drawnRef.current.set(id, rest);
      persist();
      // The library merges overlay styles rather than replacing them, so the way back to its own look is to build the
      // drawing again from what is saved.
      reloadDrawings();
      for (const [newId, saved] of drawnRef.current) {
        if (saved.name === d.name && JSON.stringify(saved.points) === JSON.stringify(d.points)) {
          selectedRef.current = newId;
          break;
        }
      }
      emitDrawing();
    },
    setSelectedStyleAsDefault(on) {
      const id = selectedRef.current;
      const d = id ? drawnRef.current.get(id) : undefined;
      if (!d) return;
      saveDrawingDefault(d.name, on ? (d.style ?? sanitizeStyle({})) : undefined);
      emitDrawing();
    },
    typicalMove() {
      return averageTrueRange(barsRef.current);
    },
    snapshot(opts?: { withoutTrades?: boolean }): ChartImage {
      const chart = chartRef.current;
      if (!chart) return { problem: "the chart is not on screen" };
      if (statusRef.current === "loading") return { problem: "the chart is still loading its candles" };
      if (statusRef.current === "error") return { problem: "the chart has not loaded - fix the message shown on it first (for example a Dhan token problem)" };
      const hidden = opts?.withoutTrades ? TRADE_GROUPS : [];
      for (const groupId of hidden) chart.overrideOverlay({ groupId, visible: false });
      // A short chart pane makes a squashed picture (the order blocks and OI levels run into each other): for the capture the chart is
      // made reasonably tall, then put back at once, in the same step, so nothing is painted at the other size.
      const box = containerRef.current;
      const extra = box ? Math.max(0, SNAPSHOT_MIN_HEIGHT - box.clientHeight) : 0;
      const prevBottom = box?.style.bottom ?? "";
      if (box && extra > 0) {
        box.style.bottom = `${-extra}px`;
        chart.resize();
      }
      try {
        return exportChart(chart);
      } finally {
        if (box && extra > 0) {
          box.style.bottom = prevBottom;
          chart.resize();
        }
        // Shown again whatever happened, so a failed export never leaves the person's own trade lines missing from their chart.
        for (const groupId of hidden) chart.overrideOverlay({ groupId, visible: true });
      }
    },
    removeSelected() {
      if (selectedRef.current) chartRef.current?.removeOverlay(selectedRef.current);
    },
    setSelectedAlert(trigger) {
      const id = selectedRef.current;
      const d = id ? drawnRef.current.get(id) : undefined;
      if (!id || !d || !ALERTABLE.has(d.name)) return;
      const { alert: _old, ...rest } = d;
      void _old;
      drawnRef.current.set(id, trigger ? { ...rest, alert: { trigger } } : rest);
      sidesRef.current.delete(id);
      // Arming starts from where the price is now, so it can only tell of a crossing from here on.
      const price = propsRef.current.price;
      const z = trigger ? alertZone(d) : null;
      if (price != null && z) sidesRef.current.set(id, sideOf(price, z));
      syncTag(id);
      persist();
      emitDrawing();
      emitArmed();
    },
    setSelectedLabel(text) {
      const id = selectedRef.current;
      const d = id ? drawnRef.current.get(id) : undefined;
      if (!id || !d || d.name === "textNote") return;
      const { label: _old, ...rest } = d;
      void _old;
      const label = text.trim().slice(0, TEXT_DRAWING_MAX);
      drawnRef.current.set(id, label ? { ...rest, label } : rest);
      syncTag(id);
      persist();
      emitDrawing();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // ---- structure: order blocks, fair value gaps, breaks, trend marks, setups ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    let cancelled = false;
    if (!structureIsOn(structure)) {
      chart.removeOverlay({ groupId: STRUCTURE_GROUP });
      propsRef.current.onStructure?.({ trendByTf: {}, setups: [] });
      return;
    }
    async function refresh(): Promise<boolean> {
      const batches: { label: string; tf: string; data: ChartStructure }[] = [];
      for (const tf of structure.tfs) {
        const tfDef = STRUCTURE_TIMEFRAMES.find((t) => t.value === tf);
        if (!tfDef) continue;
        try {
          const data = await getStructure(exchange, symbol, tf, structure);
          if (cancelled) return false;
          batches.push({ label: tfDef.label, tf, data });
        } catch {
          // this timeframe failed this round: keep the others, retry on the next refresh
        }
      }
      if (cancelled) return false;
      chart!.removeOverlay({ groupId: STRUCTURE_GROUP });
      for (const b of batches) {
        for (const spec of structureOverlays(b.label, b.data, structure)) {
          chart!.createOverlay({ name: spec.name, groupId: STRUCTURE_GROUP, lock: true, points: spec.points, extendData: spec.extendData });
        }
      }
      propsRef.current.onStructure?.({ trendByTf: Object.fromEntries(batches.map((b) => [b.tf, b.data.trend])), setups: liveSetups(batches) });
      return batches.length < structure.tfs.length;
    }
    // A timeframe that failed (the provider is rate-limited) is tried again soon, a few times, rather
    // than leaving its zones missing for the whole refresh period.
    let quick: number | undefined;
    let quickTries = 0;
    async function run() {
      const failed = await refresh();
      if (!cancelled && failed && quickTries < 3) {
        quickTries += 1;
        quick = window.setTimeout(() => void run(), 10_000);
      }
    }
    void run();
    const timer = window.setInterval(() => void refresh(), STRUCTURE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(quick);
    };
  }, [exchange, symbol, structure, status, epoch]);

  // ---- picking a price on the chart for a ticket field ----
  useEffect(() => {
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el || !pickField) return;
    const color = pickField === "stop" ? "#e8586a" : pickField === "target" ? "#3ecf8e" : "#4cc2ff";
    chart.setStyles({ crosshair: { horizontal: { line: { color }, text: { backgroundColor: color, borderColor: color, color: "#0e1319" } } } });
    el.style.cursor = "crosshair";
    const onCross = (data?: unknown) => {
      const c = data as Crosshair | undefined;
      if (!c || typeof c.paneId !== "string" || typeof c.y !== "number" || !c.paneId.startsWith("candle")) {
        hoverRef.current = null;
        return;
      }
      const pts = chart.convertFromPixel([{ y: c.y }], { paneId: c.paneId });
      const v = Array.isArray(pts) ? pts[0]?.value : (pts as { value?: number } | undefined)?.value;
      hoverRef.current = typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    chart.subscribeAction(ActionType.OnCrosshairChange, onCross);
    const onClick = () => {
      const p = hoverRef.current;
      if (p != null) propsRef.current.onPick(Number(p.toFixed(pricePrecision(p))));
    };
    el.addEventListener("click", onClick);
    return () => {
      chart.unsubscribeAction(ActionType.OnCrosshairChange, onCross);
      el.removeEventListener("click", onClick);
      el.style.cursor = "";
      hoverRef.current = null;
      chart.setStyles(chartStyles(prefersLight()));
    };
  }, [pickField]);

  // The canvas is invisible to a screen reader, so the same facts are stated in words.
  const summary = `${symbol}, ${def.label} candles.${price != null ? ` Last price ${formatPrice(price)}.` : ""}${plan.length ? ` Marked levels: ${plan.map((l) => `${l.label} ${formatPrice(l.price)}`).join(", ")}.` : ""}${oiLevels?.length ? ` Option-chain levels: ${oiLevels.map((l) => l.label).join(", ")}.` : ""}${levels?.length ? ` Entries, stops and targets of your open and waiting trades: ${levels.map((l) => `${l.label} at ${formatPrice(l.price)}`).join(", ")}.` : ""}${trades?.length ? ` Your trades on this chart: ${trades.map((t) => `${t.label}${t.state === "open" ? " (open)" : ""}`).join(", ")}.` : ""}`;

  return (
    <div className="chart-pane" data-testid="chart-pane">
      <p className="sr-only" data-testid="chart-summary">
        {summary}
      </p>
      <div ref={containerRef} className="chart-canvas" role="img" aria-label={`${symbol} price chart`} />
      {textEdit && (
        <input
          className="chart-text-input"
          style={{ left: Math.max(4, textEdit.x), top: Math.max(4, textEdit.y - 14) }}
          aria-label="Text on the chart"
          placeholder="Type, then Enter"
          maxLength={TEXT_DRAWING_MAX}
          autoFocus
          value={textEdit.value}
          onChange={(e) => setTextEdit((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing must not trigger the chart's own keys (Delete removes a drawing)
            if (e.key === "Enter") finishTextEdit(true);
            else if (e.key === "Escape") finishTextEdit(false);
          }}
          onBlur={() => finishTextEdit(true)}
        />
      )}
      {status !== "ready" && (
        <div className="chart-status" role={status === "error" ? "alert" : "status"}>
          {status === "loading" ? (
            "Loading candles…"
          ) : (
            <div>
              <p style={{ margin: "0 0 8px" }}>{message}</p>
              <p className="faint" style={{ margin: "0 0 8px", fontSize: 12 }}>
                {retrying ? "Trying again automatically." : "Automatic retries are used up."}
              </p>
              <button
                className="btn btn-small"
                onClick={() => {
                  triesRef.current = 0;
                  setTick((n) => n + 1);
                }}
              >
                Retry now
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

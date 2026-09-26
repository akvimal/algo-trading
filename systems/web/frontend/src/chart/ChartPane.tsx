import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActionType, OverlayMode, dispose, init, type Chart, type Crosshair, type Overlay, type OverlayEvent } from "klinecharts";
import { getCandles } from "../api/trade";
import type { ChartStructure } from "../api/types";
import { formatPrice } from "../format";
import { toChartPoint, pointTimestamp, type BarAnchor } from "./anchor";
import {
  INDICATOR_BY_NAME, effectiveParams, intervalDef, loadDrawings, pricePrecision, saveDrawings, structureIsOn, toKLine,
  STRUCTURE_TIMEFRAMES, type StoredDrawing, type StructureConfig,
} from "./config";
import { PEER_GROUP, PLAN_GROUP, STRUCTURE_GROUP, registerChartExtensions, type PlanLineExtend } from "./overlays";
import { liveSetups, getStructure, structureOverlays, type TrendByTf } from "./structure";
import { rollLiveBar, type Bar } from "./liveBar";
import { chartStyles, prefersLight } from "./theme";

export type DrawTool = "segment" | "rayLine" | "horizontalStraightLine" | "priceLine" | "rect" | "fibonacciLine" | "parallelStraightLine";

export type PlanLine = { key: string; price: number; label: string; color: string; dashed?: boolean };

export type PriceField = "entry" | "stop" | "target";

export type ChartPaneHandle = {
  startDrawing: (tool: DrawTool) => void;
  cancelDrawing: () => void;
  clearDrawings: () => void;
  removeSelected: () => void;
};

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
  magnet: boolean;
  drawingsHidden: boolean;
  /** Set while the person is choosing a price on the chart for a ticket field. */
  pickField: PriceField | null;
  onPick: (price: number) => void;
  onDrawingChange?: (state: { drawing: boolean; selected: boolean }) => void;
  onStructure?: (report: StructureReport) => void;
  /** Linking: this chart reports where the pointer is (a bar time, or null when it leaves) and the visible
   * window; it draws the other chart's pointer and follows the other chart's window. */
  onCursor?: (ts: number | null) => void;
  peerCursor?: number | null;
  onRange?: (r: RangeMsg) => void;
  peerRange?: RangeMsg | null;
};

type Status = "loading" | "ready" | "error";

const REFRESH_MS = 30_000;
const STRUCTURE_REFRESH_MS = 2 * 60_000;
const MAX_AUTO_RETRIES = 8;
const USER_DRAWINGS = "user-drawings";

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
  const pendingRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  const panesRef = useRef<Map<string, string>>(new Map());
  const paramsAppliedRef = useRef<Map<string, string>>(new Map());
  const hoverRef = useRef<number | null>(null);
  const peerCursorId = useRef<string | null>(null);
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

  // ---- candles: load on a new series or candle size, then top up on a timer ----
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
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    const bars = barsRef.current;
    const next = rollLiveBar(bars[bars.length - 1] ?? null, price, Date.now(), intervalMs, def.value !== "daily");
    if (!next) return;
    chart.updateData(next);
    const last = bars[bars.length - 1];
    barsRef.current = last && last.timestamp === next.timestamp ? [...bars.slice(0, -1), next] : [...bars, next];
    anchorRef.current = { timestamps: barsRef.current.map((b) => b.timestamp) };
  }, [price, status, intervalMs, def.value]);

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

  // ---- the trade plan: entry, stop and target drawn as levels ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || status !== "ready") return;
    chart.removeOverlay({ groupId: PLAN_GROUP });
    const anchor = barsRef.current[barsRef.current.length - 1]?.timestamp;
    if (anchor == null) return;
    for (const l of plan) {
      const extendData: PlanLineExtend = { label: l.label, color: l.color, dashed: l.dashed ?? true };
      chart.createOverlay({ name: "planLine", groupId: PLAN_GROUP, lock: true, points: [{ timestamp: anchor, value: l.price }], extendData });
    }
  }, [plan, status, epoch]);

  // ---- drawings: saved per instrument, restored after every load ----
  const persist = () => saveDrawings(propsRef.current.exchange, propsRef.current.symbol, [...drawnRef.current.values()]);

  const handlers = () => ({
    onDrawEnd: (e: OverlayEvent) => {
      drawnRef.current.set(e.overlay.id, serialize(e.overlay));
      persist();
      pendingRef.current = null;
      propsRef.current.onDrawingChange?.({ drawing: false, selected: selectedRef.current != null });
      return false;
    },
    onPressedMoveEnd: (e: OverlayEvent) => {
      drawnRef.current.set(e.overlay.id, serialize(e.overlay));
      persist();
      return false;
    },
    onRemoved: (e: OverlayEvent) => {
      if (selectedRef.current === e.overlay.id) {
        selectedRef.current = null;
        propsRef.current.onDrawingChange?.({ drawing: pendingRef.current != null, selected: false });
      }
      if (pendingRef.current === e.overlay.id) pendingRef.current = null;
      if (restoringRef.current) return false;
      drawnRef.current.delete(e.overlay.id);
      persist();
      return false;
    },
    onSelected: (e: OverlayEvent) => {
      selectedRef.current = e.overlay.id;
      propsRef.current.onDrawingChange?.({ drawing: pendingRef.current != null, selected: true });
      return false;
    },
    onDeselected: (e: OverlayEvent) => {
      if (selectedRef.current === e.overlay.id) {
        selectedRef.current = null;
        propsRef.current.onDrawingChange?.({ drawing: pendingRef.current != null, selected: false });
      }
      return false;
    },
    // Right-click deletes: the library ships no delete affordance and a 1px line is hard to aim at.
    onRightClick: (e: OverlayEvent) => {
      chartRef.current?.removeOverlay(e.overlay.id);
      return true;
    },
  });

  function serialize(o: Overlay): StoredDrawing {
    return { name: o.name, points: o.points.map((p) => ({ timestamp: pointTimestamp(p, anchorRef.current), value: p.value })) };
  }

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || epoch === 0) return;
    // Wipe only the drawings (by id): the plan and structure layers are theirs to manage.
    restoringRef.current = true;
    for (const id of drawnRef.current.keys()) chart.removeOverlay(id);
    drawnRef.current.clear();
    for (const d of loadDrawings(propsRef.current.exchange, propsRef.current.symbol)) {
      const id = chart.createOverlay({
        name: d.name,
        groupId: USER_DRAWINGS,
        points: d.points.map((p) => toChartPoint(p, anchorRef.current)),
        mode: magnetMode(propsRef.current.magnet),
        ...handlers(),
      });
      if (typeof id === "string") drawnRef.current.set(id, d);
    }
    restoringRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers() and the saved set read refs only; a new series always bumps epoch
  }, [epoch]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const id of drawnRef.current.keys()) chart.overrideOverlay({ id, visible: !drawingsHidden, mode: magnetMode(magnet) });
  }, [drawingsHidden, magnet, epoch]);

  useImperativeHandle(ref, () => ({
    startDrawing(tool) {
      const chart = chartRef.current;
      if (!chart) return;
      if (pendingRef.current) chart.removeOverlay(pendingRef.current);
      const id = chart.createOverlay({ name: tool, groupId: USER_DRAWINGS, mode: magnetMode(propsRef.current.magnet), ...handlers() });
      pendingRef.current = typeof id === "string" ? id : null;
      propsRef.current.onDrawingChange?.({ drawing: pendingRef.current != null, selected: selectedRef.current != null });
    },
    cancelDrawing() {
      if (pendingRef.current) chartRef.current?.removeOverlay(pendingRef.current);
      pendingRef.current = null;
      propsRef.current.onDrawingChange?.({ drawing: false, selected: selectedRef.current != null });
    },
    clearDrawings() {
      const chart = chartRef.current;
      if (!chart) return;
      for (const id of [...drawnRef.current.keys()]) chart.removeOverlay(id);
      drawnRef.current.clear();
      persist();
    },
    removeSelected() {
      if (selectedRef.current) chartRef.current?.removeOverlay(selectedRef.current);
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
  const summary = `${symbol}, ${def.label} candles.${price != null ? ` Last price ${formatPrice(price)}.` : ""}${plan.length ? ` Marked levels: ${plan.map((l) => `${l.label} ${formatPrice(l.price)}`).join(", ")}.` : ""}`;

  return (
    <div className="chart-pane" data-testid="chart-pane">
      <p className="sr-only" data-testid="chart-summary">
        {summary}
      </p>
      <div ref={containerRef} className="chart-canvas" role="img" aria-label={`${symbol} price chart`} />
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

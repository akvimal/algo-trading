import type { ChartStructure } from "../api/types";
import { api } from "../api/http";
import { STRUCTURE_TIMEFRAMES, lookbackRange, type StructureConfig } from "./config";
import type { BreakExtend, FvgExtend, ObExtend, SetupExtend, TrendMarkExtend } from "./overlays";

/** Structure for one series at one DETECTION timeframe (chosen independently of the candles on
 * screen, e.g. 15-minute zones over a 5-minute chart). Breakers, fair value gaps and setups are only
 * computed by the server when asked. */
export function getStructure(exchange: string, symbol: string, timeframe: string, cfg: StructureConfig, now: Date = new Date()) {
  const def = STRUCTURE_TIMEFRAMES.find((t) => t.value === timeframe);
  const { from, to } = lookbackRange(def?.lookbackDays ?? 30, now);
  const params = new URLSearchParams({ exchange, symbol, interval: timeframe, from, to });
  if (cfg.breakers) params.set("breakers", "true");
  if (cfg.fvg) params.set("fvg", "true");
  if (cfg.setups) params.set("setups", "true");
  if (def?.source) params.set("source", def.source);
  return api<ChartStructure>("marketData", `/order-blocks?${params}`);
}

export type OverlaySpec = { name: string; points: { timestamp: number; value: number }[]; extendData: unknown };

const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** The overlays to draw for one timeframe's structure. A timestamp that will not parse is skipped
 * rather than drawn at "NaN": a bad anchor breaks the whole render loop, not just one shape. */
export function structureOverlays(label: string, data: ChartStructure, cfg: StructureConfig): OverlaySpec[] {
  const out: OverlaySpec[] = [];

  for (const f of data.fvgs) {
    const at = ts(f.origin_timestamp);
    if (!Number.isFinite(at)) continue;
    const ext: FvgExtend = { kind: f.kind, top: f.top, bottom: f.bottom, filled: f.filled };
    out.push({ name: "htfFvg", points: [{ timestamp: at, value: f.top }], extendData: ext });
  }

  for (const z of data.order_blocks) {
    const at = ts(z.origin_timestamp);
    if (!Number.isFinite(at)) continue;
    const ext: ObExtend = { tf: label, kind: z.kind, role: z.role, proximal: z.proximal, distal: z.distal, mitigated: z.mitigated, counterTrend: z.counter_trend };
    out.push({ name: "htfOrderBlock", points: [{ timestamp: at, value: z.proximal }], extendData: ext });
  }

  if (cfg.breaks) {
    for (const e of data.events) {
      const to = ts(e.timestamp);
      const from = ts(e.from_timestamp);
      if (!Number.isFinite(to) || !Number.isFinite(from)) continue;
      const ext: BreakExtend = { tf: label, kind: e.kind, direction: e.direction, price: e.price };
      out.push({ name: "htfStructureBreak", points: [{ timestamp: from, value: e.price }, { timestamp: to, value: e.price }], extendData: ext });
    }
  }

  if (cfg.trendMarks) {
    for (const t of data.trend_changes) {
      const at = ts(t.timestamp);
      if (!Number.isFinite(at)) continue;
      const ext: TrendMarkExtend = { tf: label, trend: t.trend, price: t.price };
      out.push({ name: "htfTrendMark", points: [{ timestamp: at, value: t.price }], extendData: ext });
    }
  }

  if (cfg.setups) {
    for (const s of data.setups) {
      const left = ts(s.confirmed_timestamp);
      if (!Number.isFinite(left)) continue;
      // A resolved setup has a real second anchor. A live one has ONE anchor and extends itself to the
      // right edge every frame; it must never be anchored at "now", which the library may not resolve.
      const resolved = ts(s.resolved_timestamp);
      const points = Number.isFinite(resolved) && resolved > left ? [{ timestamp: left, value: s.entry }, { timestamp: resolved, value: s.entry }] : [{ timestamp: left, value: s.entry }];
      const ext: SetupExtend = { tf: label, direction: s.direction, status: s.status, entry: s.entry, stop: s.stop_loss, target: s.target, rr: s.risk_reward };
      out.push({ name: "htfSetup", points, extendData: ext });
    }
  }
  return out;
}

export type TrendByTf = Record<string, "up" | "down" | "range">;

/** Setups still in play (planned or triggered), for a strip above the chart. Triggered first. */
export function liveSetups(batches: { label: string; data: ChartStructure }[], limit = 4) {
  const live = batches.flatMap(({ label, data }) =>
    data.setups
      .filter((s) => s.status === "confirmed" || s.status === "triggered")
      .map((s) => ({ key: `${label}|${s.direction}|${s.confirmed_timestamp}`, tf: label, direction: s.direction, status: s.status, entry: s.entry, stop: s.stop_loss, target: s.target, rr: s.risk_reward })),
  );
  live.sort((a, b) => (a.status === b.status ? 0 : a.status === "triggered" ? -1 : 1));
  return live.slice(0, limit);
}

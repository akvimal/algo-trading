// Intraday auto-trader - config + per-symbol run state, persisted to
// localStorage. The watcher loop itself lives in AutoTradePanel.tsx; this
// module is just the stateless storage + validation slice (same split as
// manualOrder.ts vs ChartTradePanel).
//
// v1 scope (see docs/architecture.md § "Live chart - Intraday auto-trader"):
//   - trigger: a SuperTrend flip on completed bars of `interval`
//   - action: a MARKET future order in the flip's direction, opened with a
//     server-trailed SuperTrend stop (stop_loss_method='indicator') so the
//     stop keeps working even with the browser tab closed
//   - stop-and-reverse: execution's own counter_signal_policy='close_and_flip'
//     on the manual-future path closes the opposite position atomically, so
//     the watcher just places the new order
//   - one armed symbol at a time; switching the chart symbol disarms it
//   - fully automatic - no per-fire confirmation

import { type ChartInterval, type OptionStrikeMoneyness } from "./api";

// What the auto-trader trades on each flip. `future` opens a market
// future with a server-trailed SuperTrend stop; `option` opens a naked
// call (flip up) / naked put (flip down) at `moneyness` with a flat spot
// stop at the SuperTrend line. Both stop-and-reverse via execution's own
// counter_signal_policy='close_and_flip'.
export type AutoTradeInstrument = "future" | "option";

export type AutoTradeConfig = {
  instrument: AutoTradeInstrument;
  moneyness: OptionStrikeMoneyness; // option only
  period: number; // SuperTrend ATR period (> 1)
  multiplier: number; // SuperTrend ATR multiplier (> 0)
  interval: ChartInterval; // bar interval the flip is evaluated on
  lots: number; // explicit lot count - auto mode never risk-sizes
};

export const DEFAULT_AUTO_TRADE_CONFIG: AutoTradeConfig = {
  instrument: "future",
  moneyness: "ATM",
  period: 10,
  multiplier: 3,
  interval: "5min",
  lots: 1,
};

const VALID_INTERVALS: ChartInterval[] = ["1min", "3min", "5min", "15min", "30min", "60min"];
const VALID_MONEYNESS: OptionStrikeMoneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];

const ON_KEY = "manualChartAutoTradeOn";
const CONFIG_KEY = "manualChartAutoTradeConfig";
const STATE_KEY = "manualChartAutoTradeState"; // { [segment:symbol]: AutoTradeRunState }

// Per-symbol run state. `armedAt` is when the user turned auto-trade on
// for this symbol (display only). `lastActedBarTs` is the epoch-ms
// timestamp of the most recent flip bar the watcher has acted on OR
// seeded past - the dedupe key, mirroring signal-engine's own
// EngineRun.last_signal_candle_ts. Seeded to the latest historical flip
// on arming so an old flip from earlier in the day never fires
// retroactively.
export type AutoTradeRunState = {
  armedAt: number;
  lastActedBarTs: number;
};

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return Math.round(n * 100) / 100;
}

export function loadAutoTradeOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAutoTradeOn(on: boolean): void {
  try {
    localStorage.setItem(ON_KEY, String(on));
  } catch {
    /* private mode / quota - still applies this session */
  }
}

export function loadAutoTradeConfig(): AutoTradeConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      return {
        instrument: raw.instrument === "option" ? "option" : "future",
        moneyness: VALID_MONEYNESS.includes(raw.moneyness) ? raw.moneyness : DEFAULT_AUTO_TRADE_CONFIG.moneyness,
        period: clampInt(raw.period, 2, 100, DEFAULT_AUTO_TRADE_CONFIG.period),
        multiplier: clampNum(raw.multiplier, 0.5, 20, DEFAULT_AUTO_TRADE_CONFIG.multiplier),
        interval: VALID_INTERVALS.includes(raw.interval) ? raw.interval : DEFAULT_AUTO_TRADE_CONFIG.interval,
        lots: clampInt(raw.lots, 1, 100000, DEFAULT_AUTO_TRADE_CONFIG.lots),
      };
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_AUTO_TRADE_CONFIG };
}

export function saveAutoTradeConfig(config: AutoTradeConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* best-effort */
  }
}

function loadStateMap(): Record<string, AutoTradeRunState> {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    return raw && typeof raw === "object" ? (raw as Record<string, AutoTradeRunState>) : {};
  } catch {
    return {};
  }
}

function persistStateMap(map: Record<string, AutoTradeRunState>): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

export function symbolKey(segment: string, symbol: string): string {
  return `${segment}:${symbol.trim().toUpperCase()}`;
}

export function loadAutoTradeState(key: string): AutoTradeRunState | null {
  return loadStateMap()[key] ?? null;
}

export function saveAutoTradeState(key: string, state: AutoTradeRunState): void {
  const map = loadStateMap();
  map[key] = state;
  persistStateMap(map);
}

export function clearAutoTradeState(key: string): void {
  const map = loadStateMap();
  if (key in map) {
    delete map[key];
    persistStateMap(map);
  }
}

// Initial-series lookback per interval - enough completed bars for the
// SuperTrend warmup plus a full session or two of flips. Deliberately
// coarse (market-data caches a today-touching range per exact tuple, so a
// wide window costs little between bar closes).
export function lookbackDaysFor(interval: ChartInterval): number {
  switch (interval) {
    case "1min":
      return 3;
    case "3min":
      return 6;
    case "5min":
      return 10;
    case "15min":
      return 30;
    case "30min":
      return 45;
    case "60min":
      return 75;
  }
}

export function intervalMinutes(interval: ChartInterval): number {
  return { "1min": 1, "3min": 3, "5min": 5, "15min": 15, "30min": 30, "60min": 60 }[interval];
}

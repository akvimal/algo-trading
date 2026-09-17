// Intraday auto-trader - config model + localStorage draft persistence.
// The watcher itself is now SERVER-SIDE (signal-engine's in-house Rule
// engine - see AutoTradePanel.tsx's provisioning functions and
// docs/architecture.md § "Live chart - Intraday auto-trader"), not a
// browser loop: arming a symbol creates/updates a real Indicator+Rule+
// Strategy trio there and flips the Strategy to status='live', so it
// keeps running (and keeps trailing its stop, and keeps stop-and-
// reversing) with this tab closed, the browser off, or a different chart
// symbol open. This module is now just the config SHAPE + a per-viewer
// draft cache (what the config panel shows before you press ON) -
// AutoTradePanel.tsx owns the actual provisioning/status-polling logic.
//
// v1 scope (see docs/architecture.md § "Live chart - Intraday auto-trader"):
//   - trigger: a SuperTrend flip on completed bars of `interval`
//     (signal-engine's CrossoverRuleConfig against a `supertrend`
//     Indicator - the server-side equivalent of detectSupertrendFlips)
//   - action: a MARKET future or naked-option order in the flip's
//     direction, opened with a server-trailed SuperTrend stop
//     (stop_loss_method='indicator') so the stop keeps working even with
//     every browser tab closed
//   - stop-and-reverse: Strategy.counter_signal_policy='close_and_flip' on
//     the Strategy-driven order path closes the opposite position
//     atomically, same mechanism the old manual/browser path used
//   - "enter the current trend on arm": Strategy.seed_on_activation=true
//   - one Strategy per (segment, symbol) - see autoTradeStrategyName below
//   - fully automatic - no per-fire confirmation

import { type ChartInterval, type OptionStrikeMoneyness, type Segment } from "./api";

// What the auto-trader trades on each flip. `future` opens a market
// future with a server-trailed SuperTrend stop; `option` opens a naked
// call (flip up) / naked put (flip down) at `moneyness`, ALSO with a
// server-trailed SuperTrend spot stop (signal-engine's option leg
// resolution supports indicator-based trailing stops same as a future -
// unlike the old browser-only auto-trader, which could only give a naked
// option a flat stop since execution's MANUAL option path has no
// trailing SL of its own). Both stop-and-reverse via
// Strategy.counter_signal_policy='close_and_flip'.
export type AutoTradeInstrument = "future" | "option";

// One local-time-of-day window during which a flip is acted on - "HH:MM"
// strings, maps 1:1 onto signal-engine's Strategy.active_windows
// (ActiveWindow: {start, end}, end must be strictly after start, no
// overnight wraparound). Multiple windows may be configured; a flip is
// acted on if it falls within ANY of them - see Strategy.active_windows'
// own comment in infra/postgres/init/03-signal-generation.sql.
export type AutoTradeWindow = { start: string; end: string };

export type AutoTradeConfig = {
  instrument: AutoTradeInstrument;
  moneyness: OptionStrikeMoneyness; // option only
  period: number; // SuperTrend ATR period (> 1)
  multiplier: number; // SuperTrend ATR multiplier (> 0)
  interval: ChartInterval; // bar interval the flip is evaluated on
  lots: number; // explicit lot count - auto mode never risk-sizes
  // Gate: only act on a flip when GET /regime-equivalent server-side check
  // (signal-engine's Rule.regime_indicator_ids, an ADX + DMI-direction
  // Indicator pair provisioned alongside the crossover one) confirms the
  // flip's own direction. Opt-in.
  adxGate: boolean;
  // Multiple daily entry-time windows - see AutoTradeWindow above. Empty =
  // no restriction (acts on a flip any time).
  windows: AutoTradeWindow[];
};

export const DEFAULT_AUTO_TRADE_CONFIG: AutoTradeConfig = {
  instrument: "future",
  moneyness: "ATM",
  period: 10,
  multiplier: 3,
  interval: "5min",
  lots: 1,
  adxGate: false,
  windows: [],
};

const VALID_INTERVALS: ChartInterval[] = ["1min", "3min", "5min", "15min", "30min", "60min"];
const VALID_MONEYNESS: OptionStrikeMoneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHhmm(s: string): boolean {
  return HHMM_RE.test(s);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return Math.round(n * 100) / 100;
}

function sanitizeWindows(raw: unknown): AutoTradeWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoTradeWindow[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const start = (w as { start?: unknown }).start;
    const end = (w as { end?: unknown }).end;
    if (typeof start === "string" && typeof end === "string" && isValidHhmm(start) && isValidHhmm(end) && end > start) {
      out.push({ start, end });
    }
  }
  return out;
}

const CONFIG_KEY = "manualChartAutoTradeConfigV2";

// Per-viewer draft only - what the config panel is pre-filled with before
// you press ON for a symbol that has no auto-trade Strategy yet. Not the
// source of truth for anything actually running (that's the Strategy row
// itself, server-side, per (segment, symbol) - see AutoTradePanel.tsx).
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
        adxGate: raw.adxGate === true,
        windows: sanitizeWindows(raw.windows),
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

// One Strategy (+ backing Rule + Indicator(s)) per (segment, symbol) -
// signal-engine has no per-user/per-symbol uniqueness of its own (Strategy
// ownership is attribution-only, see docs/architecture.md), so this name
// tag IS the identity AutoTradePanel.tsx's find-or-create provisioning
// looks up. Keep these three in sync if you ever change the tag shape -
// they intentionally share one naming scheme so every row for one
// auto-trade symbol is recognizable together in signal-engine's own
// generic Strategies/Rules/Indicators screens too.
export function autoTradeTag(segment: Segment, symbol: string): string {
  return `${segment}:${symbol.trim().toUpperCase()}`;
}
export function autoTradeStrategyName(segment: Segment, symbol: string): string {
  return `Auto-trade: ${autoTradeTag(segment, symbol)}`;
}
export function autoTradeIndicatorName(segment: Segment, symbol: string): string {
  return `Auto-trade ST: ${autoTradeTag(segment, symbol)}`;
}
export function autoTradeAdxIndicatorName(segment: Segment, symbol: string): string {
  return `Auto-trade ADX: ${autoTradeTag(segment, symbol)}`;
}
export function autoTradeDmiIndicatorName(segment: Segment, symbol: string): string {
  return `Auto-trade DMI: ${autoTradeTag(segment, symbol)}`;
}

import type { Segment } from "../api/types";

// The intraday auto-trader, as data. It is a real strategy on the server (signal-engine's in-house
// engine watching a SuperTrend), so it keeps running with this page closed; this module is only what the
// person can set, how that becomes the server's strategy, and the reverse. No requests and no screen here.

export type AutoInterval = "1min" | "3min" | "5min" | "15min" | "30min" | "60min";
export type Moneyness = "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2";
export type AutoWindow = { start: string; end: string };

export type AutoConfig = {
  /** A market future, or a naked call (turn up) and put (turn down). */
  instrument: "future" | "option";
  moneyness: Moneyness;
  /** SuperTrend: how many candles the average range covers, and how many times it is multiplied. */
  period: number;
  multiplier: number;
  /** The candle size a flip is judged on. */
  interval: AutoInterval;
  lots: number;
  /** Only act on a flip when trend strength (ADX) and direction (DMI) agree with it. */
  adxGate: boolean;
  /** Times of day (India time) when a flip is acted on; none means any time. */
  windows: AutoWindow[];
  /** Practice money for this auto-trader's own paper account, set when it is first turned on. */
  balance: number;
};

// Off by default: it places real (paper) orders on its own once armed, so it stays out of the way of a
// new user until they deliberately turn it on in Settings. A per-browser preference, not account state.
const VISIBLE_KEY = "web.autotrader.visible";

export function loadAutoTraderVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAutoTraderVisible(visible: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, String(visible));
  } catch {
    // storage blocked: the choice simply lasts this session
  }
}

export const DEFAULT_CONFIG: AutoConfig = {
  instrument: "future", moneyness: "ATM", period: 10, multiplier: 3, interval: "5min", lots: 1, adxGate: false, windows: [], balance: 100_000,
};

export const INTERVAL_CHOICES: { value: AutoInterval; label: string }[] = [
  { value: "1min", label: "1m" }, { value: "3min", label: "3m" }, { value: "5min", label: "5m" },
  { value: "15min", label: "15m" }, { value: "30min", label: "30m" }, { value: "60min", label: "1h" },
];
export const MONEYNESS_CHOICES: { value: Moneyness; label: string }[] = [
  { value: "ITM2", label: "2 strikes in the money" }, { value: "ITM1", label: "1 strike in the money" }, { value: "ATM", label: "At the money" },
  { value: "OTM1", label: "1 strike out of the money" }, { value: "OTM2", label: "2 strikes out of the money" },
];

const INTERVALS = new Set<string>(INTERVAL_CHOICES.map((i) => i.value));
const MONEYNESS = new Set<string>(MONEYNESS_CHOICES.map((m) => m.value));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Delta lists options only for Bitcoin and Ether; every NSE and MCX contract instrument has a chain. */
export const optionEligible = (segment: Segment, symbol: string) => segment !== "CRYPTO" || ["BTCUSD", "ETHUSD"].includes(symbol.trim().toUpperCase());

export const isHhmm = (s: string) => HHMM.test(s);

/** What is wrong with a setting, in words, or an empty list. The server checks again; this saves a trip. */
export function validateConfig(c: AutoConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(c.period) || c.period < 2 || c.period > 100) errors.push("The average range needs 2 to 100 candles.");
  if (!(c.multiplier >= 0.5 && c.multiplier <= 20)) errors.push("The multiplier needs to be between 0.5 and 20.");
  if (!Number.isInteger(c.lots) || c.lots < 1 || c.lots > 100_000) errors.push("Lots needs to be a whole number, at least 1.");
  if (!(c.balance > 0)) errors.push("Practice money needs to be more than zero.");
  c.windows.forEach((w, i) => {
    if (!isHhmm(w.start) || !isHhmm(w.end)) errors.push(`Window ${i + 1} needs a start and an end time.`);
    else if (w.end <= w.start) errors.push(`Window ${i + 1} must end after it starts.`);
  });
  return errors;
}

const num = (v: unknown, lo: number, hi: number, fallback: number, whole: boolean) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return whole ? Math.round(n) : Math.round(n * 100) / 100;
};

/** A saved draft made safe: anything missing or out of range falls back to the default. */
export function cleanConfig(raw: unknown): AutoConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const windows = Array.isArray(r.windows)
    ? r.windows.flatMap((w) => {
        const o = (w ?? {}) as Record<string, unknown>;
        return typeof o.start === "string" && typeof o.end === "string" && isHhmm(o.start) && isHhmm(o.end) && o.end > o.start ? [{ start: o.start, end: o.end }] : [];
      })
    : [];
  return {
    instrument: r.instrument === "option" ? "option" : "future",
    moneyness: MONEYNESS.has(String(r.moneyness)) ? (r.moneyness as Moneyness) : DEFAULT_CONFIG.moneyness,
    period: num(r.period, 2, 100, DEFAULT_CONFIG.period, true),
    multiplier: num(r.multiplier, 0.5, 20, DEFAULT_CONFIG.multiplier, false),
    interval: INTERVALS.has(String(r.interval)) ? (r.interval as AutoInterval) : DEFAULT_CONFIG.interval,
    lots: num(r.lots, 1, 100_000, DEFAULT_CONFIG.lots, true),
    adxGate: r.adxGate === true,
    windows,
    balance: num(r.balance, 1, 1e9, DEFAULT_CONFIG.balance, true),
  };
}

// ---- identity: one strategy per market and instrument ----
// The server has no notion of "this person's auto-trader for NIFTY", so a name tag is the identity that
// finding, changing and removing it all go by. It is the same tag the classic app uses, so a strategy
// set up there is recognised here.
export const tagFor = (segment: Segment, symbol: string) => `${segment}:${symbol.trim().toUpperCase()}`;
export const strategyName = (segment: Segment, symbol: string) => `Auto-trade: ${tagFor(segment, symbol)}`;
export const supertrendName = (segment: Segment, symbol: string) => `Auto-trade ST: ${tagFor(segment, symbol)}`;
export const adxName = (segment: Segment, symbol: string) => `Auto-trade ADX: ${tagFor(segment, symbol)}`;
export const dmiName = (segment: Segment, symbol: string) => `Auto-trade DMI: ${tagFor(segment, symbol)}`;

/** Fixed strengths for the optional gate: a trend counts from ADX 20, over 14 candles. */
export const ADX_PARAMS = { period: 14, trend_threshold: 20 };
export const DMI_PARAMS = { period: 14 };

/** What to create on the server for a setting: the SuperTrend indicator (and, with the gate, ADX and
 * DMI), the rule that fires on a flip, and the strategy that trades it. `ids` fills in the indicator
 * and rule ids once they exist. */
export function buildProvision(c: AutoConfig, segment: Segment, symbol: string) {
  const sym = symbol.trim().toUpperCase();
  const instrument = c.instrument;
  return {
    supertrend: { name: supertrendName(segment, sym), type: "supertrend" as const, params: { period: c.period, multiplier: c.multiplier } },
    adx: c.adxGate ? { name: adxName(segment, sym), type: "adx" as const, params: ADX_PARAMS } : null,
    dmi: c.adxGate ? { name: dmiName(segment, sym), type: "dmi_direction" as const, params: DMI_PARAMS } : null,
    rule: (supertrendId: string, regimeIds: string[]) => ({
      name: strategyName(segment, sym),
      segment,
      underlying: sym,
      underlying_type: "symbol" as const,
      interval: c.interval,
      rule_config: { type: "crossover" as const, indicator_id: supertrendId },
      regime_indicator_ids: regimeIds,
    }),
    /** The parts a strategy keeps when changed. Its name, source and horizon are fixed at creation. */
    strategy: (ruleId: string) => ({
      instrument_type: instrument,
      rule_id: ruleId,
      stop_loss_method: "indicator" as const,
      stop_loss_interval: c.interval,
      stop_loss_indicator_type: "supertrend" as const,
      stop_loss_indicator_params: { period: c.period, multiplier: c.multiplier },
      trailing_stop_enabled: true,
      option_position_style: instrument === "option" ? ("naked" as const) : undefined,
      option_strike_moneyness: instrument === "option" ? c.moneyness : undefined,
      fixed_lots: c.lots,
      segment,
      duplicate_signal_policy: "skip" as const,
      counter_signal_policy: "close_and_flip" as const,
      active_windows: c.windows,
      seed_on_activation: true,
    }),
    strategyName: strategyName(segment, sym),
  };
}

export type ServerStrategy = {
  instrument_type: string;
  option_strike_moneyness?: string | null;
  stop_loss_indicator_params?: { period?: number; multiplier?: number } | null;
  fixed_lots: number | null;
  active_windows: AutoWindow[];
};
export type ServerRule = { interval: string; regime_indicator_ids: string[] };

/** The setting the server is running, so the form shows what is really on, not a stale draft. */
export function configFromServer(s: ServerStrategy, rule: ServerRule | null, balance: number | null): AutoConfig {
  return cleanConfig({
    instrument: s.instrument_type === "option" ? "option" : "future",
    moneyness: s.option_strike_moneyness,
    period: s.stop_loss_indicator_params?.period,
    multiplier: s.stop_loss_indicator_params?.multiplier,
    interval: rule?.interval,
    lots: s.fixed_lots ?? DEFAULT_CONFIG.lots,
    adxGate: (rule?.regime_indicator_ids.length ?? 0) > 0,
    windows: s.active_windows,
    balance: balance ?? DEFAULT_CONFIG.balance,
  });
}

/** One line saying what it is set to do, e.g. "5m SuperTrend (10, 3) · future · 1 lot · ADX gate". */
export function summarise(c: AutoConfig): string {
  const size = `${c.lots} lot${c.lots === 1 ? "" : "s"}`;
  const what = c.instrument === "option" ? `naked option, ${MONEYNESS_CHOICES.find((m) => m.value === c.moneyness)?.label.toLowerCase()}` : "future";
  const iv = INTERVAL_CHOICES.find((i) => i.value === c.interval)?.label ?? c.interval;
  const parts = [`${iv} SuperTrend (${c.period}, ${c.multiplier})`, what, size];
  if (c.adxGate) parts.push("ADX gate");
  if (c.windows.length) parts.push(c.windows.map((w) => `${w.start}–${w.end}`).join(", "));
  return parts.join(" · ");
}

/** True when two settings would provision the same strategy (the practice balance only matters at the
 * first turn-on, so it is left out). */
export const sameConfig = (a: AutoConfig, b: AutoConfig) => JSON.stringify({ ...a, balance: 0 }) === JSON.stringify({ ...b, balance: 0 });

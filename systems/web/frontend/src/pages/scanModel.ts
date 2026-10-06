import type { Buildup, OiHistoryPoint, OiRow, Proximity, Regime, ScreenerRow } from "../api/types";

export const BUILDUP_LABEL: Record<Buildup, string> = {
  long_buildup: "Long buildup",
  short_buildup: "Short buildup",
  short_covering: "Short covering",
  long_unwinding: "Long unwinding",
};

/** What each reading means in a sentence, for people who do not know the jargon. */
export const BUILDUP_HELP: Record<Buildup, string> = {
  long_buildup: "price up, open interest up: new buyers are entering",
  short_buildup: "price down, open interest up: new sellers are entering",
  short_covering: "price up, open interest down: sellers are exiting",
  long_unwinding: "price down, open interest down: buyers are exiting",
};

/** A first guess at Bullish/Bearish from the call/put OI buildup readings already on the card -
 * "good" (long_buildup/short_covering - this leg's OWN premium rising, see BUILDUP_HELP) on the
 * call side reads bullish (calls being bought or short-covered as the underlying rises); the same
 * "good" reading on the put side reads bearish (puts being bought or short-covered as the
 * underlying falls) - the same "good" classification BuildupPill already uses for its own colour.
 * When the two agree with each other (both or neither "good" - no clear call/put split) this
 * falls back to the day's own price change. Always just a starting point for the Bullish/Bearish
 * chips, never a recommendation - the person can change it with one click either way. */
export function defaultViewFromOi(row: Pick<OiRow, "call_buildup" | "put_buildup" | "price_change_pct">): "BUY" | "SELL" {
  const good = (b: Buildup | null) => b === "long_buildup" || b === "short_covering";
  const callBullish = good(row.call_buildup);
  const putBearish = good(row.put_buildup);
  if (callBullish && !putBearish) return "BUY";
  if (putBearish && !callBullish) return "SELL";
  return (row.price_change_pct ?? 0) >= 0 ? "BUY" : "SELL";
}

export const REGIME_LABEL: Record<Regime, string> = {
  trending_up: "Trending up",
  trending_down: "Trending down",
  ranging: "Ranging",
  transitional: "Changing",
};

export const PROXIMITY_LABEL: Record<Proximity, string> = { near_52w_high: "Near 52-week high", near_52w_low: "Near 52-week low" };

export type OiSort = "call_oi" | "put_oi" | "pcr" | "price" | "strength" | "oi_total" | "symbol";
/** A one-tap reading of the option chain: one of the four price-against-OI quadrants, or a big two-sided shift. */
export type OiSignal = "all" | "strong_bull" | "strong_bear" | Buildup;
/** The signals that are a quadrant, in the order the chips show them: bullish pair first, then the bearish pair. */
export const QUADRANT_SIGNALS: Buildup[] = ["long_buildup", "short_covering", "short_buildup", "long_unwinding"];
export const isQuadrantSignal = (s: OiSignal): s is Buildup => (QUADRANT_SIGNALS as string[]).includes(s);
export type OiFilters = { call: Buildup | "all"; put: Buildup | "all"; signal: OiSignal; minShift: number; search: string; sort: OiSort };
/** minShift: how much (in %) the call AND the put open interest must each have grown for a shift to count as a major one. */
export const DEFAULT_MIN_SHIFT = 10;
export const OI_DEFAULTS: OiFilters = { call: "all", put: "all", signal: "all", minShift: DEFAULT_MIN_SHIFT, search: "", sort: "call_oi" };

export const OI_SIGNAL_LABEL: Record<"strong_bull" | "strong_bear", string> = { strong_bull: "Strong bullish", strong_bear: "Strong bearish" };
// NOTE on the labels these read. The buildup labels here compare each side's open interest with the UNDERLYING's price move
// (market-data's oi_buildup.py: one price change for both sides), not with the option's own premium. So the textbook bullish pair
// "call long buildup + put short buildup" (call buyers arriving while put writers arrive) can never appear on these labels: it would
// need the price to be up for the call side and down for the put side. In these labels the same situation is price up with
// call OI up and put OI up, i.e. "Long buildup" on BOTH sides; its bearish mirror (call writers and put buyers arriving, price
// falling) is "Short buildup" on both.
export const OI_SIGNAL_HELP: Record<"strong_bull" | "strong_bear", string> = {
  strong_bull: "Price up while both call and put open interest grew a lot: new call buyers and new put writers arriving together (long buildup on both sides).",
  strong_bear: "Price down while both call and put open interest grew a lot: new call writers and new put buyers arriving together (short buildup on both sides).",
};

/** Whether a stock shows a major two-sided shift: price up with a long buildup on BOTH sides is bullish, price down with a short
 * buildup on both sides is bearish (see the note above on why it is read this way), AND open interest grew by at least `minShift` percent
 * on BOTH sides. A reading with no OI change figure never qualifies. It describes what the option chain did today; it is not a prediction. */
export function oiSignal(row: Pick<OiRow, "call_buildup" | "put_buildup" | "call_oi_change_pct" | "put_oi_change_pct">, minShift: number): "strong_bull" | "strong_bear" | null {
  const call = row.call_oi_change_pct;
  const put = row.put_oi_change_pct;
  if (call == null || put == null || Number.isNaN(call) || Number.isNaN(put)) return null;
  if (call < minShift || put < minShift) return null;
  if (row.call_buildup === "long_buildup" && row.put_buildup === "long_buildup") return "strong_bull";
  if (row.call_buildup === "short_buildup" && row.put_buildup === "short_buildup") return "strong_bear";
  return null;
}

// ---- the four quadrants: price against TOTAL open interest (calls and puts together) --------------------------------------------------------
//
//                  OI rising                 OI falling
//   price up       Long buildup (bullish)    Short covering (bullish)
//   price down     Short buildup (bearish)   Long unwinding (bearish)
//
// The same reading the end-of-day Telegram digest uses (market-data's app/domain/oi_quadrants.py); both are tested against the same cases file
// (fixtures/oi_quadrant_cases.json) so they cannot drift. A stock only counts when the day was not noise.
export const MIN_PRICE_MOVE_PCT = 0.5;
export const MIN_OI_CHANGE_PCT = 5;

/** How much call plus put open interest changed in total, as a percent of yesterday's total: rebuilt from today's totals and each side's change
 * (yesterday = today / (1 + change)), so a big side counts for more than a small one. Null when a figure is missing. */
export function totalOiChangePct(row: Pick<OiRow, "total_call_oi" | "total_put_oi" | "call_oi_change_pct" | "put_oi_change_pct">): number | null {
  const { total_call_oi: tc, total_put_oi: tp, call_oi_change_pct: cp, put_oi_change_pct: pp } = row;
  if (tc == null || tp == null || cp == null || pp == null || Number.isNaN(cp) || Number.isNaN(pp) || cp <= -100 || pp <= -100) return null;
  const previous = tc / (1 + cp / 100) + tp / (1 + pp / 100);
  return previous > 0 ? ((tc + tp - previous) / previous) * 100 : null;
}

/** Which quadrant a stock is in, or null when the price moved under the floor, total OI changed under the floor, or a figure is missing. */
export function oiQuadrant(row: Pick<OiRow, "total_call_oi" | "total_put_oi" | "call_oi_change_pct" | "put_oi_change_pct" | "price_change_pct">): Buildup | null {
  const price = row.price_change_pct;
  const oi = totalOiChangePct(row);
  if (price == null || oi == null || Math.abs(price) < MIN_PRICE_MOVE_PCT || Math.abs(oi) < MIN_OI_CHANGE_PCT) return null;
  if (price > 0) return oi > 0 ? "long_buildup" : "short_covering";
  return oi > 0 ? "short_buildup" : "long_unwinding";
}

/** How big a shift is: the call and put OI changes together. Null when either is missing. */
export const oiStrength = (row: Pick<OiRow, "call_oi_change_pct" | "put_oi_change_pct">): number | null =>
  row.call_oi_change_pct == null || row.put_oi_change_pct == null ? null : row.call_oi_change_pct + row.put_oi_change_pct;

const num = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? null : v);

/** Nulls always sort last, in either direction: "no data" is never the biggest or smallest. */
function byNumberDesc<T>(get: (r: T) => number | null | undefined) {
  return (a: T, b: T) => {
    const x = num(get(a));
    const y = num(get(b));
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
}

const matches = (symbol: string, search: string) => !search.trim() || symbol.toUpperCase().includes(search.trim().toUpperCase());

export function filterOi(rows: OiRow[], f: OiFilters): OiRow[] {
  const out = rows.filter(
    (r) =>
      matches(r.symbol, f.search) &&
      (f.call === "all" || r.call_buildup === f.call) &&
      (f.put === "all" || r.put_buildup === f.put) &&
      (f.signal === "all" || (isQuadrantSignal(f.signal) ? oiQuadrant(r) === f.signal : oiSignal(r, f.minShift) === f.signal)),
  );
  const sorters: Record<OiSort, (a: OiRow, b: OiRow) => number> = {
    call_oi: byNumberDesc((r) => r.call_oi_change_pct),
    put_oi: byNumberDesc((r) => r.put_oi_change_pct),
    pcr: byNumberDesc((r) => r.pcr),
    price: byNumberDesc((r) => r.price_change_pct),
    strength: byNumberDesc(oiStrength),
    oi_total: byNumberDesc((r) => {
      const t = totalOiChangePct(r);
      return t == null ? null : Math.abs(t);
    }),
    symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  };
  return [...out].sort((a, b) => sorters[f.sort](a, b) || a.symbol.localeCompare(b.symbol));
}

export type ScreenerSort = "d5" | "d20" | "adx" | "symbol";
export type ScreenerFilters = { regime: Regime | "all"; proximity: Proximity | "all"; search: string; sort: ScreenerSort };
export const SCREENER_DEFAULTS: ScreenerFilters = { regime: "all", proximity: "all", search: "", sort: "d5" };

export function filterScreener(rows: ScreenerRow[], f: ScreenerFilters): ScreenerRow[] {
  const out = rows.filter((r) => matches(r.symbol, f.search) && (f.regime === "all" || r.regime === f.regime) && (f.proximity === "all" || r.proximity === f.proximity));
  const sorters: Record<ScreenerSort, (a: ScreenerRow, b: ScreenerRow) => number> = {
    d5: byNumberDesc((r) => r.pct_change_5d),
    d20: byNumberDesc((r) => r.pct_change_20d),
    adx: byNumberDesc((r) => r.adx),
    symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  };
  return [...out].sort((a, b) => sorters[f.sort](a, b) || a.symbol.localeCompare(b.symbol));
}

/** Big lists are shown a page at a time: 2,500 equities must not become 2,500 cards. */
export const PAGE = 40;
export const visible = <T,>(rows: T[], shown: number): T[] => rows.slice(0, shown);

/** "1.2Cr", "45L", "12,300": open interest in the units Indians read. */
export function compactCount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  return new Intl.NumberFormat("en-IN").format(n);
}

/** The symbol to chart for a scan row: where the Trade screen takes it. */
export const tradeLink = (symbol: string) => `/trade?symbol=${encodeURIComponent(symbol)}&segment=NSE`;

/** One day of the per-stock OI history: how call and put open interest and the price moved against the day before. */
export type OiDay = {
  date: string;
  callPct: number | null;
  putPct: number | null;
  pricePct: number | null;
  callBuildup: Buildup | null;
  putBuildup: Buildup | null;
  pcr: number | null;
};

const pctChange = (now: number | null | undefined, before: number | null | undefined): number | null =>
  now == null || before == null || !before ? null : ((now - before) / before) * 100;

/** The same OI-vs-price 2x2 read market-data uses for the badges (oi_summary._classify_buildup): a flat or unknown change reads as nothing. */
export function classifyBuildup(oiDiff: number | null, priceDiff: number | null): Buildup | null {
  if (!oiDiff || !priceDiff) return null;
  if (oiDiff > 0) return priceDiff > 0 ? "long_buildup" : "short_buildup";
  return priceDiff > 0 ? "short_covering" : "long_unwinding";
}

/** The last `days` days of change for one stock, newest first. Each day is measured against the stored day before it (the same way the
 * server computes the badge on the latest day), so the first point of the history only serves as a reference and `days` days of change
 * needs `days + 1` points. A stock with fewer points than that simply shows fewer days. */
export function oiDays(history: OiHistoryPoint[], days = 5): OiDay[] {
  const out: OiDay[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    const callNow = cur.total_call_oi;
    const putNow = cur.total_put_oi;
    const priceDiff = cur.spot_price != null && prev.spot_price != null ? cur.spot_price - prev.spot_price : null;
    out.push({
      date: cur.snapshot_date,
      callPct: pctChange(callNow, prev.total_call_oi),
      putPct: pctChange(putNow, prev.total_put_oi),
      pricePct: pctChange(cur.spot_price, prev.spot_price),
      callBuildup: callNow != null && prev.total_call_oi != null ? classifyBuildup(callNow - prev.total_call_oi, priceDiff) : null,
      putBuildup: putNow != null && prev.total_put_oi != null ? classifyBuildup(putNow - prev.total_put_oi, priceDiff) : null,
      pcr: callNow ? (putNow ?? 0) / callNow : null,
    });
  }
  return out.slice(-days).reverse();
}

/** How much call and put OI moved over the whole window shown (first day's change through the last), as one figure each. */
export function oiWindowChange(history: OiHistoryPoint[], days = 5): { callPct: number | null; putPct: number | null; from: string | null } {
  const used = history.slice(-(days + 1));
  if (used.length < 2) return { callPct: null, putPct: null, from: null };
  const first = used[0];
  const last = used[used.length - 1];
  return { callPct: pctChange(last.total_call_oi, first.total_call_oi), putPct: pctChange(last.total_put_oi, first.total_put_oi), from: first.snapshot_date };
}

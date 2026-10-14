import type { Activity, Buildup, OiHistoryPoint, OiRow, Proximity, Regime, ScreenerRow, ZoneScanRow } from "../api/types";

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

/** The call-side and put-side readings, worded for options. The data is the same four quadrants (this side's open interest against the UNDERLYING's
 * price move), but "long buildup" is a futures word: for an option, rising open interest has a buyer AND a seller, and which one is the aggressor shows in
 * the option's own premium, which falls when the stock rises for a put. So a put whose OI grew as the stock rose is most likely written (bullish support),
 * not "long". Call OI up with the stock up is the one reading that cannot be told apart from this data (buying or writing): it is worded as buying, the
 * likelier one when the stock is rising, and its help says so. */
export type OptionSide = "call" | "put";
export const SIDE_LABEL: Record<OptionSide, Record<Buildup, string>> = {
  // No "Call"/"Put" prefix: every place these show sits under a call or put heading already.
  call: { long_buildup: "Buying", short_buildup: "Writing", short_covering: "Writers covering", long_unwinding: "Unwinding" },
  put: { long_buildup: "Writing", short_buildup: "Buying", short_covering: "Unwinding", long_unwinding: "Writers covering" },
};
export const SIDE_HELP: Record<OptionSide, Record<Buildup, string>> = {
  call: {
    long_buildup: "stock up, call open interest up: most likely new call buyers (bullish), though writers can be adding too",
    short_buildup: "stock down, call open interest up: most likely new call writers, a ceiling forming (bearish)",
    short_covering: "stock up, call open interest down: call writers closing out as the stock rises (bullish)",
    long_unwinding: "stock down, call open interest down: call buyers giving up (bearish)",
  },
  put: {
    long_buildup: "stock up, put open interest up: most likely new put writers, a floor forming (bullish)",
    short_buildup: "stock down, put open interest up: most likely new put buyers, hedging or betting lower (bearish)",
    short_covering: "stock up, put open interest down: put buyers giving up (bullish)",
    long_unwinding: "stock down, put open interest down: put writers closing out as the stock falls (bearish)",
  },
};

export const ACTIVITY_LABEL: Record<Activity, string> = { buying: "Buying", writing: "Writing", writers_covering: "Writers covering", unwinding: "Unwinding" };
export const ACTIVITY_ORDER: Activity[] = ["buying", "writing", "writers_covering", "unwinding"];
/** Read from the option's own premium, so these are stated, not "most likely". */
export const ACTIVITY_HELP: Record<OptionSide, Record<Activity, string>> = {
  call: {
    buying: "call open interest up and the call price up: calls are being bought (bullish)",
    writing: "call open interest up and the call price down: calls are being written, a ceiling forming (bearish)",
    writers_covering: "call open interest down and the call price up: call writers are buying back (bullish)",
    unwinding: "call open interest down and the call price down: call buyers are selling out (bearish)",
  },
  put: {
    buying: "put open interest up and the put price up: puts are being bought (bearish, or hedging)",
    writing: "put open interest up and the put price down: puts are being written, a floor forming (bullish)",
    writers_covering: "put open interest down and the put price up: put writers are buying back (bearish)",
    unwinding: "put open interest down and the put price down: put buyers are selling out (bullish)",
  },
};
const INFERRED: Record<OptionSide, Record<Buildup, Activity>> = {
  call: { long_buildup: "buying", short_buildup: "writing", short_covering: "writers_covering", long_unwinding: "unwinding" },
  put: { long_buildup: "writing", short_buildup: "buying", short_covering: "unwinding", long_unwinding: "writers_covering" },
};
/** The reading for one side of a stock: the measured one (from the option's own price) when it was recorded, else the likelier one worked out from the
 * stock's price. `measured` says which, so the page can be honest about it. */
export function sideActivity(side: OptionSide, activity: Activity | null | undefined, buildup: Buildup | null | undefined): { activity: Activity; measured: boolean } | null {
  if (activity) return { activity, measured: true };
  if (buildup) return { activity: INFERRED[side][buildup], measured: false };
  return null;
}
/** Green when the reading leans bullish: calls bought or their writers covering, puts written or their buyers selling out. */
export const activityIsBullish = (side: OptionSide, a: Activity): boolean => (side === "call" ? a === "buying" || a === "writers_covering" : a === "writing" || a === "unwinding");

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

export type OiSort = "call_oi" | "put_oi" | "pcr" | "price" | "strength" | "oi_total" | "symbol" | "zone";
/** A one-tap reading of the option chain: one of the four price-against-OI quadrants, or a big two-sided shift. */
export type OiSignal = "all" | "strong_bull" | "strong_bear" | "reversal" | Buildup;
/** The signals that are a quadrant, in the order the chips show them: bullish pair first, then the bearish pair. */
export const QUADRANT_SIGNALS: Buildup[] = ["long_buildup", "short_covering", "short_buildup", "long_unwinding"];
export const isQuadrantSignal = (s: OiSignal): s is Buildup => (QUADRANT_SIGNALS as string[]).includes(s);
/** The "At a zone" filter: every stock, only the stocks the nightly zone scan put in tier A or B, or any stock at a zone (tier C too). */
export type ZoneFilter = "all" | "shortlist" | "any";
export type OiFilters = { call: Activity | "all"; put: Activity | "all"; signal: OiSignal; minShift: number; search: string; sort: OiSort; zone: ZoneFilter };
/** minShift: how much (in %) the call AND the put open interest must each have grown for a shift to count as a major one. */
export const DEFAULT_MIN_SHIFT = 10;
export const OI_DEFAULTS: OiFilters = { call: "all", put: "all", signal: "all", minShift: DEFAULT_MIN_SHIFT, search: "", sort: "call_oi", zone: "all" };

export const OI_SIGNAL_LABEL: Record<"strong_bull" | "strong_bear" | "reversal", string> = { strong_bull: "Strong bullish", strong_bear: "Strong bearish", reversal: "Early reversal" };
// NOTE on the labels these read. The buildup labels here compare each side's open interest with the UNDERLYING's price move
// (market-data's oi_buildup.py: one price change for both sides), not with the option's own premium. So the textbook bullish pair
// "call long buildup + put short buildup" (call buyers arriving while put writers arrive) can never appear on these labels: it would
// need the price to be up for the call side and down for the put side. In these labels the same situation is price up with
// call OI up and put OI up, i.e. "Long buildup" on BOTH sides; its bearish mirror (call writers and put buyers arriving, price
// falling) is "Short buildup" on both.
export const OI_SIGNAL_HELP: Record<"strong_bull" | "strong_bear" | "reversal", string> = {
  reversal: "A trend over the last few days that one side of the option chain has just challenged with a jump in open interest well beyond its usual. A place to look, not a signal.",
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

// ---- early reversal: the other side suddenly piles in against a trend --------------------------------------------------------------------------
//
// Each day's two readings (call side, put side) lean bullish or bearish (activityIsBullish: calls bought, puts written...), +1 or -1 each. A trend is
// the last PRIOR_DAYS days leaning one way by at least MIN_TREND in total. A reversal is WATCHED when today a side leans the OTHER way on a jump in its
// open interest that is both big (REVERSAL_MIN_OI_PCT) and out of that stock's own pattern (REVERSAL_SPIKE_MULT x its recent average move). It is a
// place to look, not a signal: open interest also moves for hedging, and the last days before a monthly expiry are left out (it rolls to the next series).
export const REVERSAL_PRIOR_DAYS = 4;
export const REVERSAL_MIN_TREND = 2;
export const REVERSAL_MIN_OI_PCT = 15;
export const REVERSAL_SPIKE_MULT = 2;

export type Reversal = { direction: "down" | "up"; sides: OptionSide[]; trendScore: number };

/** The monthly stock-option expiry for the month of `iso`: the last Tuesday. (A holiday moves it a day earlier, which the window below allows for.) */
function lastTuesday(iso: string): Date {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // last day of the month
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 5) % 7));
  return d;
}

/** True for the trading days around a monthly expiry (from three days before to one after), when total open interest rolls to the next series and a
 * jump or drop in it means nothing. */
export function nearMonthlyExpiry(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getTime();
  const expiry = lastTuesday(iso).getTime();
  const days = Math.round((day - expiry) / 86_400_000);
  return days >= -3 && days <= 1;
}

/** Weekdays from `from` to `to` (Mon-Fri; a market holiday is not known here). 1 = the next trading day, so a Friday to the Monday is 1 too. */
function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime() + 86_400_000; t <= end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const sideLean = (side: OptionSide, activity: Activity | null, buildup: Buildup | null): number => {
  const read = sideActivity(side, activity, buildup);
  return read ? (activityIsBullish(side, read.activity) ? 1 : -1) : 0;
};

/** Whether a stock's latest day looks like the start of a reversal of the trend before it. Null when there is no trend, no jump on the other side,
 * too little history, or the day sits next to a monthly expiry. `direction: "down"` is a bullish trend that a bearish side has just challenged. */
export function reversalWatch(row: Pick<OiRow, "history" | "snapshot_date">): Reversal | null {
  if (nearMonthlyExpiry(row.snapshot_date)) return null;
  // The reference day plus the days read: every step must be the next trading day. The nightly snapshot can miss a day, and a "day-over-day" change
  // across a gap is several days of movement that would read as a spike (a holiday also breaks the run, which only costs a missed flag).
  const points = row.history.slice(-(REVERSAL_PRIOR_DAYS + 2));
  if (points.length < REVERSAL_PRIOR_DAYS + 2) return null;
  for (let i = 1; i < points.length; i++) if (weekdaysBetween(points[i - 1].snapshot_date, points[i].snapshot_date) !== 1) return null;
  const days = oiDays(points, REVERSAL_PRIOR_DAYS + 1); // newest first: today, then the days before it
  const [today, ...prior] = days;
  if (prior.some((d) => nearMonthlyExpiry(d.date))) return null; // the days the trend is read from must not straddle a roll either
  const trendScore = prior.reduce((sum, d) => sum + sideLean("call", d.callActivity, d.callBuildup) + sideLean("put", d.putActivity, d.putBuildup), 0);
  if (Math.abs(trendScore) < REVERSAL_MIN_TREND) return null;
  const trendUp = trendScore > 0;
  const sides: OptionSide[] = [];
  for (const side of ["call", "put"] as OptionSide[]) {
    const lean = side === "call" ? sideLean("call", today.callActivity, today.callBuildup) : sideLean("put", today.putActivity, today.putBuildup);
    if (lean !== (trendUp ? -1 : 1)) continue;
    const pct = side === "call" ? today.callPct : today.putPct;
    if (pct == null || Math.abs(pct) < REVERSAL_MIN_OI_PCT) continue;
    const history = prior.map((d) => (side === "call" ? d.callPct : d.putPct)).filter((v): v is number => v != null);
    const usual = history.length ? Math.max(1, history.reduce((a, v) => a + Math.abs(v), 0) / history.length) : 1;
    if (Math.abs(pct) >= REVERSAL_SPIKE_MULT * usual) sides.push(side);
  }
  return sides.length ? { direction: trendUp ? "down" : "up", sides, trendScore } : null;
}

export const REVERSAL_LABEL: Record<Reversal["direction"], string> = { down: "Early reversal ↓", up: "Early reversal ↑" };
export const reversalHelp = (r: Reversal): string =>
  `The last ${REVERSAL_PRIOR_DAYS} days leaned ${r.direction === "down" ? "bullish" : "bearish"}, and today the ${r.sides.join(" and ")} side${r.sides.length > 1 ? "s" : ""} moved the other way on a jump in open interest ` +
  `well beyond ${r.sides.length > 1 ? "their" : "its"} usual. A place to look, not a signal: open interest also moves for hedging.`;

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

export function filterOi(rows: OiRow[], f: OiFilters, zones: Record<string, ZoneScanRow> = {}): OiRow[] {
  const out = rows.filter(
    (r) =>
      matches(r.symbol, f.search) &&
      zoneMatches(zones[r.symbol], f.zone) &&
      (f.call === "all" || sideActivity("call", r.call_activity, r.call_buildup)?.activity === f.call) &&
      (f.put === "all" || sideActivity("put", r.put_activity, r.put_buildup)?.activity === f.put) &&
      (f.signal === "all" || (f.signal === "reversal" ? reversalWatch(r) !== null : isQuadrantSignal(f.signal) ? oiQuadrant(r) === f.signal : oiSignal(r, f.minShift) === f.signal)),
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
    // best tier first, then the nearest zone; a stock without one goes last
    zone: (a, b) => zoneRank(zones[a.symbol]) - zoneRank(zones[b.symbol]),
  };
  return [...out].sort((a, b) => sorters[f.sort](a, b) || a.symbol.localeCompare(b.symbol));
}

const TIER_ORDER = { A: 0, B: 1, C: 2 } as const;
const zoneMatches = (z: ZoneScanRow | undefined, filter: ZoneFilter) => filter === "all" || (!!z && (filter === "any" || z.tier !== "C"));
const zoneRank = (z: ZoneScanRow | undefined) => (z ? TIER_ORDER[z.tier] * 1000 + Math.min(z.zone_distance_atr, 99) : 1e6);

export const ZONE_TIER_HELP: Record<ZoneScanRow["tier"], string> = {
  A: "Tier A: a weekly zone of the same kind is also at price, and open interest points the same way.",
  B: "Tier B: the weekly trend is on the zone's side, and open interest points the same way.",
  C: "Tier C: an untested daily zone at price, without that weekly or open-interest support.",
};

/** "Inside a supply zone" or "1.8% below a supply zone" (price approaches supply from below, demand from above). */
export function zonePlace(z: Pick<ZoneScanRow, "zone_kind" | "zone_position" | "zone_distance_pct">): string {
  const kind = z.zone_kind === "demand" ? "demand" : "supply";
  if (z.zone_position === "inside") return `Inside a ${kind} zone`;
  return `${z.zone_distance_pct.toFixed(1)}% ${z.zone_kind === "demand" ? "above" : "below"} a ${kind} zone`;
}

/** "Daily down, weekly range", leaving out a weekly read the stock had too little history for. */
export const zoneTrends = (z: Pick<ZoneScanRow, "daily_trend" | "weekly_trend">) => `Daily ${z.daily_trend}${z.weekly_trend ? `, weekly ${z.weekly_trend}` : ""}`;

export type ScreenerSort = "d5" | "d20" | "adx" | "symbol" | "mom" | "ret3m" | "rs" | "turnover" | "ema20" | "rsi3";
/** Which stocks the Screener lists: everything, an index, the F&O stocks, or the liquid stocks outside the Nifty 500. */
export type Universe = "all" | "nifty500" | "large" | "mid" | "small" | "fno" | "other";
/** "Top 10% / 20% / 40% by 12-1 month momentum" among the liquid stocks, or no cut. */
export type RsCut = "any" | "10" | "20" | "40";
export type ScreenerFilters = { regime: Regime | "all"; proximity: Proximity | "all"; search: string; sort: ScreenerSort; universe: Universe; liquid: boolean; rs: RsCut };
export const LIQUID_MIN_CR = 5;
export const SCREENER_DEFAULTS: ScreenerFilters = { regime: "all", proximity: "all", search: "", sort: "d5", universe: "nifty500", liquid: true, rs: "any" };

export const UNIVERSE_LABEL: Record<Universe, string> = { all: "All stocks", nifty500: "Nifty 500", large: "Large (Nifty 100)", mid: "Midcap 150", small: "Smallcap 250", fno: "F&O stocks", other: "Outside Nifty 500" };
export const UNIVERSES = Object.keys(UNIVERSE_LABEL) as Universe[];
const UNIVERSE_TAG: Partial<Record<Universe, string>> = { nifty500: "NIFTY500", large: "NIFTY100", mid: "NIFTYMIDCAP150", small: "NIFTYSMALLCAP250" };

export function inUniverse(r: ScreenerRow, u: Universe): boolean {
  if (u === "all") return true;
  if (u === "fno") return !!r.is_fno;
  if (u === "other") return !(r.universes ?? []).includes("NIFTY500");
  return (r.universes ?? []).includes(UNIVERSE_TAG[u]!);
}

/** Whether the data has what a filter needs: an older backend, or a night before the new columns were first filled, lacks it - then the filter is skipped, not allowed to hide everything. */
const haveTags = (rows: ScreenerRow[]) => rows.some((r) => r.universes !== undefined);
export const haveLiquidity = (rows: ScreenerRow[]) => rows.some((r) => r.avg_turnover_cr != null);

/** How many stocks each universe has under the current liquidity setting, for the chips. */
export function universeCounts(rows: ScreenerRow[], liquid: boolean): Record<Universe, number> {
  const base = liquid && haveLiquidity(rows) ? rows.filter((r) => (r.avg_turnover_cr ?? 0) >= LIQUID_MIN_CR) : rows;
  return Object.fromEntries(UNIVERSES.map((u) => [u, base.filter((r) => inUniverse(r, u)).length])) as Record<Universe, number>;
}

/** "Large", "Mid", "Small" for a stock in one of those indices (the biggest first), else "Outside Nifty 500". */
export function sizeLabel(r: Pick<ScreenerRow, "universes">): string | null {
  const u = r.universes;
  if (u === undefined) return null;
  return u.includes("NIFTY100") ? "Large" : u.includes("NIFTYMIDCAP150") ? "Mid" : u.includes("NIFTYSMALLCAP250") ? "Small" : u.includes("NIFTY500") ? "Nifty 500" : "Outside Nifty 500";
}

export function filterScreener(rows: ScreenerRow[], f: ScreenerFilters): ScreenerRow[] {
  const tags = haveTags(rows);
  const liquidity = haveLiquidity(rows);
  const rsMin = f.rs === "any" ? null : 100 - Number(f.rs);
  const out = rows.filter(
    (r) =>
      matches(r.symbol, f.search) &&
      (f.regime === "all" || r.regime === f.regime) &&
      (f.proximity === "all" || r.proximity === f.proximity) &&
      (!tags || inUniverse(r, f.universe)) &&
      (!f.liquid || !liquidity || (r.avg_turnover_cr ?? 0) >= LIQUID_MIN_CR) &&
      (rsMin === null || (r.rs_12m_pctile != null && r.rs_12m_pctile >= rsMin)),
  );
  const sorters: Record<ScreenerSort, (a: ScreenerRow, b: ScreenerRow) => number> = {
    d5: byNumberDesc((r) => r.pct_change_5d),
    d20: byNumberDesc((r) => r.pct_change_20d),
    adx: byNumberDesc((r) => r.adx),
    symbol: (a, b) => a.symbol.localeCompare(b.symbol),
    mom: byNumberDesc((r) => r.mom_12_1_pct ?? null),
    ret3m: byNumberDesc((r) => r.ret_3m_pct ?? null),
    rs: byNumberDesc((r) => r.rs_12m_pctile ?? null),
    turnover: byNumberDesc((r) => r.avg_turnover_cr ?? null),
    // the stocks furthest below their 20-day EMA first (a pullback list); one without a value goes last
    ema20: byNumberDesc((r) => (r.dist_ema20_pct == null ? null : -r.dist_ema20_pct)),
    rsi3: byNumberDesc((r) => (r.rsi3 == null ? null : -r.rsi3)),
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

/** The "full Trade page" link on a scan card: the same instrument on two charts side by side, weekly on the left and daily on the right,
 * the swing view a scan result is read in. (The interval link is off in that layout so each chart keeps its own.) */
export const fullTradeLink = (symbol: string) => `${tradeLink(symbol)}&layout=side&intervals=weekly,daily`;

/** The OI buildup card's trade link: the same two charts, with the ticket opened on a credit spread leaning the way the card's own call/put
 * reading does (Bullish = bull put spread, Bearish = bear call spread). Only a starting point; the Bullish/Bearish and Debit/Credit chips change it. */
export const oiTradeLink = (symbol: string, view: "BUY" | "SELL") => `${fullTradeLink(symbol)}&form=credit&view=${view}`;

/** One day of the per-stock OI history: how call and put open interest and the price moved against the day before. */
export type OiDay = {
  date: string;
  callPct: number | null;
  putPct: number | null;
  pricePct: number | null;
  callBuildup: Buildup | null;
  putBuildup: Buildup | null;
  callActivity: Activity | null;
  putActivity: Activity | null;
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
      callActivity: cur.call_activity ?? null,
      putActivity: cur.put_activity ?? null,
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

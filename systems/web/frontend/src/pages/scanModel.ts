import type { Buildup, OiRow, Proximity, Regime, ScreenerRow } from "../api/types";

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

export const REGIME_LABEL: Record<Regime, string> = {
  trending_up: "Trending up",
  trending_down: "Trending down",
  ranging: "Ranging",
  transitional: "Changing",
};

export const PROXIMITY_LABEL: Record<Proximity, string> = { near_52w_high: "Near 52-week high", near_52w_low: "Near 52-week low" };

export type OiSort = "call_oi" | "put_oi" | "pcr" | "price" | "symbol";
export type OiFilters = { call: Buildup | "all"; put: Buildup | "all"; search: string; sort: OiSort };
export const OI_DEFAULTS: OiFilters = { call: "all", put: "all", search: "", sort: "call_oi" };

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
  const out = rows.filter((r) => matches(r.symbol, f.search) && (f.call === "all" || r.call_buildup === f.call) && (f.put === "all" || r.put_buildup === f.put));
  const sorters: Record<OiSort, (a: OiRow, b: OiRow) => number> = {
    call_oi: byNumberDesc((r) => r.call_oi_change_pct),
    put_oi: byNumberDesc((r) => r.put_oi_change_pct),
    pcr: byNumberDesc((r) => r.pcr),
    price: byNumberDesc((r) => r.price_change_pct),
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

import type { OiSummary } from "../api/types";

// Support and resistance read from the option chain: where call and put open interest has piled up.
// Plain data and no chart library, so it can be tested without a screen and used by the page.

/** The instruments that carry an option chain on this platform's data providers (indices and MCX
 * commodities through Dhan, Bitcoin and Ether through Delta). For anything else there is nothing to draw. */
export const OI_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "GOLDM", "CRUDEOILM", "BTCUSD", "ETHUSD"]);

export const hasOiChain = (symbol: string) => OI_UNDERLYINGS.has(symbol.trim().toUpperCase());

export type OiLevel = {
  kind: "resistance" | "support";
  /** 1 = the biggest wall on its side, 2 = the next. */
  rank: 1 | 2;
  /** The strike where open interest is being added fastest right now, before it is a standing wall. */
  forming: boolean;
  strike: number;
  oi: number;
  /** The 15-minute addition, for a forming level. */
  oiChange: number | null;
};

/** Resistance is the biggest call open interest at or above the price (call writers defend it; a heavy
 * call strike below the price has already been broken through). Support is the biggest put open interest
 * at or below it. Keeping each side to its own half of the chain stops both from landing on the same
 * round strike near the money, which often carries the most on both sides. The two biggest on each side
 * are returned, plus the fastest-building strike on each side when it is not already one of them. */
export function computeOiLevels(oi: OiSummary): OiLevel[] {
  const spot = oi.underlying_last_price;
  const calls: { strike: number; oi: number }[] = [];
  const puts: { strike: number; oi: number }[] = [];
  let resForm: { strike: number; chg: number } | null = null;
  let supForm: { strike: number; chg: number } | null = null;
  for (const s of oi.strikes) {
    if (s.call && s.strike >= spot) {
      calls.push({ strike: s.strike, oi: s.call.oi });
      const c = s.call.oi_change_15m ?? 0;
      if (c > 0 && (!resForm || c > resForm.chg)) resForm = { strike: s.strike, chg: c };
    }
    if (s.put && s.strike <= spot) {
      puts.push({ strike: s.strike, oi: s.put.oi });
      const c = s.put.oi_change_15m ?? 0;
      if (c > 0 && (!supForm || c > supForm.chg)) supForm = { strike: s.strike, chg: c };
    }
  }
  calls.sort((a, b) => b.oi - a.oi);
  puts.sort((a, b) => b.oi - a.oi);

  const out: OiLevel[] = [];
  calls.slice(0, 2).forEach((c, i) => out.push({ kind: "resistance", rank: (i + 1) as 1 | 2, forming: false, strike: c.strike, oi: c.oi, oiChange: null }));
  puts.slice(0, 2).forEach((p, i) => out.push({ kind: "support", rank: (i + 1) as 1 | 2, forming: false, strike: p.strike, oi: p.oi, oiChange: null }));
  const resStrikes = new Set(calls.slice(0, 2).map((c) => c.strike));
  const supStrikes = new Set(puts.slice(0, 2).map((p) => p.strike));
  if (resForm && !resStrikes.has(resForm.strike)) out.push({ kind: "resistance", rank: 2, forming: true, strike: resForm.strike, oi: 0, oiChange: resForm.chg });
  if (supForm && !supStrikes.has(supForm.strike)) out.push({ kind: "support", rank: 2, forming: true, strike: supForm.strike, oi: 0, oiChange: supForm.chg });
  return out;
}

/** Indian compact form (K, L, Cr): an index's open interest runs to crores. */
export function compactIndian(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Crypto open interest is a plain count of contracts, not an Indian-numbered quantity. */
export const oiCount = (n: number, crypto: boolean) => (crypto ? Math.round(n).toLocaleString("en-US") : compactIndian(n));

export type OiLevelLine = { kind: OiLevel["kind"]; rank: 1 | 2; forming: boolean; price: number; label: string };

/** What the chart draws for each level: its price and the words on its tag, e.g. "R1 24500 · 1.2Cr OI"
 * or "S forming 24300 · +85.0K/15m". */
export function oiLevelLines(oi: OiSummary): OiLevelLine[] {
  const crypto = oi.underlying_exchange === "CRYPTO";
  return computeOiLevels(oi).map((l) => {
    const tag = l.kind === "resistance" ? "R" : "S";
    const label = l.forming
      ? `${tag} forming ${l.strike}${l.oiChange != null ? ` · +${oiCount(l.oiChange, crypto)}/15m` : ""}`
      : `${tag}${l.rank} ${l.strike}${l.oi ? ` · ${oiCount(l.oi, crypto)} OI` : ""}`;
    return { kind: l.kind, rank: l.rank, forming: l.forming, price: l.strike, label };
  });
}

/** Only the walls nearest the price: the closest resistance at or above it and the closest support at or below it, from the standing
 * (not forming) levels. A side with nothing beyond the price falls back to its nearest level of that kind, so there is still a line to
 * look at. Without a price, the biggest wall (rank 1) on each side. */
export function closestOiLevels(levels: OiLevelLine[], price: number | null): OiLevelLine[] {
  const out: OiLevelLine[] = [];
  for (const kind of ["resistance", "support"] as const) {
    const side = levels.filter((l) => l.kind === kind && !l.forming);
    if (side.length === 0) continue;
    if (price == null) {
      out.push([...side].sort((a, b) => a.rank - b.rank)[0]);
      continue;
    }
    const beyond = side.filter((l) => (kind === "resistance" ? l.price >= price : l.price <= price));
    const pool = beyond.length ? beyond : side;
    const nearest = [...pool].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
    out.push(nearest);
  }
  return out;
}

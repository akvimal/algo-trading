import type { Position, Segment } from "../api/types";
import type { QuoteSubscription } from "../hooks/useQuoteSocket";

// Live results for open positions from pushed prices, without waiting for the next poll. Plain data
// and no requests, so it can be tested without a screen.
//
// Only a spot or futures position is worked out here: its result is one price against one entry. An
// option spread's result depends on the prices of all its legs together, and the server already puts
// that together, so option groups (and their legs) keep the polled figure.

export type Prices = Record<string, number>;
export const priceKey = (exchange: string, symbol: string) => `${exchange}:${symbol}`;

const isLive = (p: Position) => p.status === "OPEN" && p.option_group_id == null;

/** The price socket takes at most this many symbols per connection (market-data's limit); asking for
 * more only earns an error frame. The rest keep their polled figure. */
export const MAX_LIVE_SYMBOLS = 5;

/** What to subscribe to: each distinct open spot or futures position's own symbol, newest first so the
 * trades just opened are the ones kept live when there are more than the socket allows. */
export function liveSubscriptions(positions: Position[]): QuoteSubscription[] {
  const seen = new Map<string, QuoteSubscription>();
  const newestFirst = [...positions].sort((a, b) => Date.parse(b.entry_time) - Date.parse(a.entry_time));
  for (const p of newestFirst) if (isLive(p)) seen.set(priceKey(p.exchange, p.symbol), { exchange: p.exchange, symbol: p.symbol });
  return [...seen.values()].slice(0, MAX_LIVE_SYMBOLS);
}

/** The result of an open position at a price, the same arithmetic the server uses. */
export const resultAt = (p: Pick<Position, "action" | "entry_price" | "quantity">, price: number) =>
  (p.action === "BUY" ? price - p.entry_price : p.entry_price - price) * p.quantity;

export type Applied = {
  positions: Position[];
  /** How much each account's open result moved from what the server last said, so a total built from
   * the server's figures can be brought up to date too. */
  delta: Partial<Record<Segment, number>>;
};

/** Open positions valued at the latest pushed price. One with no price yet keeps the server's figure. */
export function applyLivePrices(positions: Position[], prices: Prices): Applied {
  const delta: Applied["delta"] = {};
  const out = positions.map((p) => {
    const price = isLive(p) ? prices[priceKey(p.exchange, p.symbol)] : undefined;
    if (price == null || !Number.isFinite(price) || price <= 0) return p;
    const pnl = resultAt(p, price);
    delta[p.segment] = (delta[p.segment] ?? 0) + (pnl - (p.unrealized_pnl ?? 0));
    return { ...p, live_price: price, unrealized_pnl: pnl };
  });
  return { positions: out, delta };
}

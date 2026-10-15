import { getCandles, getExpiries, getLtp, getRegime, resolveUnderlying } from "../api/trade";
import { hasOiChain } from "../chart/oiLevels";
import { useResource } from "../hooks/useResource";
import type { MarketRegime, ResolvedUnderlying, Segment } from "../api/types";

// While the socket looks down, REST is the only source, so it polls quickly. Once the socket
// connects it is USUALLY the faster path, but "connected" only means the handshake to market-data
// succeeded - the tick still has to come from market-data's own shared upstream Dhan feed, which
// can be dead (an expired token, a rate-limit block, ...) while the socket itself sits open and
// silent. REST used to stop polling entirely in that case (pollMs: undefined), so polledPrice
// would freeze at whatever it last fetched with nothing to refresh it - harmless when a stale
// value was still shown as if live, but once TradePage started re-checking freshness on every
// read (see tradeModel.ts's isFresh/PRICE_STALE_MS) that froze value aged out and there was no
// fallback left: the price genuinely disappeared for as long as the tab stayed open, breaking a
// market order ("Waiting for a live price"). Never switch this to `undefined` again - keep REST
// polling, just less often, so it can always self-heal within one cycle, comfortably inside
// PRICE_STALE_MS, if the socket stops actually delivering.
const LTP_POLL_MS_SOCKET_DOWN = 5_000;
const LTP_POLL_MS_SOCKET_UP = 30_000;

export type PaneData = {
  resolved: ResolvedUnderlying | null;
  /** The series the chart draws (for an index, the index itself, not its future). */
  exchange: string | null;
  symbol: string | null;
  /** The last price REST returned (the socket's price is layered on top by the caller). */
  polledPrice: number | null;
  /** When `polledPrice` was actually fetched - `useResource` keeps a value on screen through any
   * number of failing refreshes (a dead upstream feed, an expired token, ...), so this is what
   * lets the caller tell a genuinely live price apart from one that stopped updating a while ago. */
  polledAt: number | null;
  regime: MarketRegime | null;
  /** The nearest option expiry that has not passed (YYYY-MM-DD) for an instrument with an option chain: the weekly one for an index that has weeklies. */
  optionExpiry: string | null;
  error: Error | null;
  reloadResolve: () => void;
};

/** Everything one chart needs about its instrument that is not the candles: what to chart, the
 * quote (polled at 5 seconds unless a socket is delivering it), and the regime read. Called once per
 * pane, always in the same order, and turned off for a pane that is not on screen. */
export function usePaneData(spec: { symbol: string; segment: Segment; interval: string } | null, enabled: boolean, socketConnected: boolean): PaneData {
  const on = enabled && spec != null;
  const resolved = useResource(() => resolveUnderlying(spec!.segment, spec!.symbol), [spec?.segment, spec?.symbol], { enabled: on });
  const exchange = resolved.data?.chart_exchange ?? null;
  const symbol = resolved.data?.chart_symbol ?? null;
  const ready = on && exchange != null && symbol != null;
  const ltp = useResource(() => getLtp(exchange!, symbol!), [exchange, symbol], { pollMs: socketConnected ? LTP_POLL_MS_SOCKET_UP : LTP_POLL_MS_SOCKET_DOWN, enabled: ready });
  const regime = useResource(() => getRegime(exchange!, symbol!, spec!.interval), [exchange, symbol, spec?.interval], { pollMs: 60_000, enabled: ready });
  const expiries = useResource(() => getExpiries(exchange!, symbol!), [exchange, symbol], { enabled: ready && hasOiChain(spec!.symbol) });
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const optionExpiry = expiries.data?.find((e) => e >= todayIso) ?? null;
  return {
    resolved: resolved.data,
    exchange,
    symbol,
    polledPrice: ltp.data?.ltp ?? null,
    polledAt: ltp.fetchedAt,
    regime: regime.data,
    optionExpiry,
    error: resolved.error ?? ltp.error,
    reloadResolve: resolved.reload,
  };
}

// Re-exported so a screen that only needs the candle download shares one import site.
export { getCandles };

import { getCandles, getLtp, getRegime, resolveUnderlying } from "../api/trade";
import { useResource } from "../hooks/useResource";
import type { MarketRegime, ResolvedUnderlying, Segment } from "../api/types";

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
  const ltp = useResource(() => getLtp(exchange!, symbol!), [exchange, symbol], { pollMs: socketConnected ? undefined : 5_000, enabled: ready });
  const regime = useResource(() => getRegime(exchange!, symbol!, spec!.interval), [exchange, symbol, spec?.interval], { pollMs: 60_000, enabled: ready });
  return {
    resolved: resolved.data,
    exchange,
    symbol,
    polledPrice: ltp.data?.ltp ?? null,
    polledAt: ltp.fetchedAt,
    regime: regime.data,
    error: resolved.error ?? ltp.error,
    reloadResolve: resolved.reload,
  };
}

// Re-exported so a screen that only needs the candle download shares one import site.
export { getCandles };

import { useState } from "react";
import { getLtp } from "../api/trade";
import { useQuoteSocket } from "../hooks/useQuoteSocket";
import { useResource } from "../hooks/useResource";
import { isFresh } from "./tradeModel";

/** The same "socket first, REST underneath" live price the Trade page's own charts use
 * (usePaneData + TradePage's priceOf), just for the one symbol a Scan card panel is showing.
 * Shared by ScanChartPanel and ScanTradePanel - each call opens its own socket subscription, so
 * having both panels open on the same card costs two connections to the same symbol rather than
 * one; a real but small inefficiency, not worth the extra plumbing to share a single socket
 * between two independently-mounted panels that are not always both on screen. */
export function useScanLivePrice(exchange: string, symbol: string): { price: number | null; connected: boolean } {
  const ltp = useResource(() => getLtp(exchange, symbol), [exchange, symbol], { pollMs: 30_000 });
  const [pushed, setPushed] = useState<{ price: number; at: number } | null>(null);
  const socket = useQuoteSocket([{ exchange, symbol }], (t) => {
    if (t.exchange === exchange && t.symbol === symbol) setPushed({ price: t.price, at: Date.now() });
  });
  const price = pushed && isFresh(pushed.at, Date.now()) ? pushed.price : (ltp.data?.ltp ?? null);
  return { price, connected: socket.connected };
}

import { useEffect, useRef, useState } from "react";
import { getToken } from "../auth/token";

// Live price push from market-data (/ws/quotes): one connection carries every symbol this page
// wants, instead of each screen polling /quotes/ltp on a timer. The server fans a shared feed
// out to any number of browsers. A dropped connection is retried with a growing delay, and the
// caller falls back to polling for as long as `connected` is false, so a dead socket costs
// freshness (a few seconds), never correctness.

export type QuoteTick = { exchange: string; symbol: string; price: number; ltt?: string; received_at?: string };
export type QuoteSubscription = { exchange: string; symbol: string };

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

// The server caches the last tick it ever saw for a symbol for a full 24h (market-data's
// md:ltp:* key, self-cleaning, re-armed on every real tick) and hands it out as the `snapshot`
// on subscribe even when the upstream Dhan feed has been dead for hours (an expired access
// token, a network stall, ...) - there is no separate "feed is down" signal on this socket. A
// snapshot/tick that old is not "a few seconds stale", it is a different session's price
// entirely, and trusting it as `price` bridges a giant fake candle on the chart (rollLiveBar)
// and corrupts live P&L (useLivePositions) alike. Comfortably above any real gap between a tick
// being produced (`received_at`) and reaching us, well below "stale by market-hours".
const MAX_TICK_AGE_MS = 2 * 60_000;

const keyOf = (s: QuoteSubscription) => `${s.exchange}:${s.symbol}`;

/** True when `receivedAt` is missing/unparseable (older test fixtures and any frame the server
 * sends without it - treated as fresh rather than dropped) or within MAX_TICK_AGE_MS of `now`.
 * Pure and exported so the staleness cutoff itself is directly unit-testable. */
export function isFreshTick(receivedAt: string | undefined, now: number): boolean {
  if (!receivedAt) return true;
  const ts = Date.parse(receivedAt);
  if (Number.isNaN(ts)) return true;
  return now - ts < MAX_TICK_AGE_MS;
}

/** Same origin as the page, through its own nginx /ws/ proxy rather than a direct hop to a bare
 * backend port that a firewall may not open. The scheme follows the page, or an https page would
 * be refused a plain ws connection. */
export function socketUrl(loc: Pick<Location, "protocol" | "host"> = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws/quotes`;
}

export function nextDelay(current: number): number {
  return Math.min(current * 2, MAX_RETRY_MS);
}

/** Subscribes to `subscriptions` and calls `onTick` for every snapshot and tick. Switching the
 * symbols sends a subscribe/unsubscribe on the same connection rather than reconnecting. */
export function useQuoteSocket(
  subscriptions: QuoteSubscription[],
  onTick: (tick: QuoteTick) => void,
): { connected: boolean; keysRequired: boolean } {
  const [connected, setConnected] = useState(false);
  const [keysRequired, setKeysRequired] = useState(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  const subsRef = useRef(subscriptions);
  subsRef.current = subscriptions;
  const joined = useRef<Set<string>>(new Set());
  const socket = useRef<WebSocket | null>(null);
  const subsKey = subscriptions.map(keyOf).sort().join(",");

  // Connection lifecycle: once per mount, never rebuilt for a symbol change.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let delay = FIRST_RETRY_MS;

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(socketUrl());
      socket.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        delay = FIRST_RETRY_MS;
        setConnected(true);
        // A WebSocket handshake cannot carry an Authorization header and a token in the URL would
        // reach access logs, so the first frame identifies us. With own-keys mode off the server
        // simply ignores it.
        const token = getToken();
        if (token) ws.send(JSON.stringify({ action: "auth", token }));
        const wanted = subsRef.current;
        joined.current = new Set(wanted.map(keyOf));
        for (const s of wanted) ws.send(JSON.stringify({ action: "subscribe", exchange: s.exchange, symbol: s.symbol }));
      };

      ws.onmessage = (event) => {
        let frame: any;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return; // one malformed frame is not worth dropping the connection over
        }
        if ((frame.type === "snapshot" || frame.type === "tick") && frame.exchange && frame.symbol && typeof frame.price === "number") {
          if (isFreshTick(frame.received_at, Date.now())) onTickRef.current(frame as QuoteTick);
        } else if (frame.type === "error" && frame.code === "own_dhan_keys_required") {
          setKeysRequired(true);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        timer = window.setTimeout(connect, delay);
        delay = nextDelay(delay);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
      setConnected(false);
    };
  }, []);

  // A changed symbol set is sent as a diff on the open connection. (Before the first open, or
  // while reconnecting, onopen subscribes to whatever is current at that moment.)
  useEffect(() => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const next = new Set(subscriptions.map(keyOf));
    for (const s of subscriptions) {
      if (!joined.current.has(keyOf(s))) ws.send(JSON.stringify({ action: "subscribe", exchange: s.exchange, symbol: s.symbol }));
    }
    for (const key of joined.current) {
      if (!next.has(key)) {
        const [exchange, symbol] = key.split(":");
        ws.send(JSON.stringify({ action: "unsubscribe", exchange, symbol }));
      }
    }
    joined.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subsKey stands in for the (unstable) array
  }, [subsKey]);

  return { connected, keysRequired };
}

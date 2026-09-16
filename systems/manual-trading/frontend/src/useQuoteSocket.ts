import { useEffect, useRef, useState } from "react";

// Live LTP push (2026-09-16, Phase 1 of the SaaS scaling work - see
// docs/architecture.md) - the first WebSocket client anywhere in this
// repo. Fans a shared platform-account feed out to any number of browser
// sessions (market-data's app/api/routes/quotes_ws.py) instead of every
// open chart tab polling GET /quotes/ltp on its own timer. Deliberately
// a small, reusable hook rather than something LiveChartPanel-specific -
// other charts/pages may want the same feed later.
//
// No auth - matches the endpoint's own deliberate anonymous design (see
// quotes_ws.py's docstring): this is always the platform's shared global
// feed, never a per-user BYO-credentialed quote, so there's no identity
// for a token to carry.

const MARKET_DATA_PORT = import.meta.env.VITE_MARKET_DATA_PORT ?? "8001";

// One tab reconnecting is cheap (unlike the upstream Dhan connection
// dhan_feed.py protects with real exponential backoff) - a flat retry is
// simple and plenty.
const RECONNECT_DELAY_MS = 3000;

export type QuoteTick = {
  exchange: string;
  symbol: string;
  price: number;
  ltt: string;
  received_at: string;
};

type ServerFrame = { type: "snapshot" | "tick" | "error" } & Partial<QuoteTick> & { detail?: string };

export type QuoteSubscription = { exchange: string; symbol: string };

function keyOf(s: QuoteSubscription): string {
  return `${s.exchange}:${s.symbol}`;
}

// A WS handshake fails outright on a scheme mismatch (unlike a plain
// fetch()), so this derives ws:/wss: from the page's own scheme rather
// than hardcoding http: the way this frontend's other *_BASE_URL
// constants do.
function wsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.hostname}:${MARKET_DATA_PORT}/ws/quotes`;
}

/** Subscribes to a small set of (exchange, symbol) quotes over one shared
 * WebSocket connection for this hook instance's lifetime, calling
 * `onTick` for every snapshot/tick frame. `connected` reflects the
 * socket's live state - callers use it to decide whether their own
 * REST-polling fallback should run (see LiveChartPanel.tsx's
 * tickLtp/wsConnectedRef). The connection itself is established once (not
 * torn down and rebuilt on every symbol change) - switching symbols sends
 * a live subscribe/unsubscribe diff on the same socket instead. */
export function useQuoteSocket(subscriptions: QuoteSubscription[], onTick: (tick: QuoteTick) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  // Always the latest subscriptions, read by onopen (so a reconnect after
  // a symbol switch subscribes to what's CURRENT, not whatever the
  // connection effect closed over at mount) and by the diff effect below.
  const subscriptionsRef = useRef(subscriptions);
  subscriptionsRef.current = subscriptions;

  const joinedRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  const subsKey = subscriptions.map(keyOf).sort().join(",");

  // Connection lifecycle - mount/unmount only. Deliberately NOT keyed on
  // subsKey (a symbol change must not pay a full reconnect); see the diff
  // effect below for how subscription changes actually reach the server.
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | undefined;

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        const current = subscriptionsRef.current;
        joinedRef.current = new Set(current.map(keyOf));
        for (const s of current) {
          ws.send(JSON.stringify({ action: "subscribe", exchange: s.exchange, symbol: s.symbol }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as ServerFrame;
          if ((frame.type === "snapshot" || frame.type === "tick") && frame.exchange && frame.symbol && typeof frame.price === "number") {
            onTickRef.current(frame as QuoteTick);
          }
        } catch {
          // malformed frame - ignore, the next one will likely be fine
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, []);

  // Live subscribe/unsubscribe diff when the requested symbol set changes
  // mid-connection (e.g. a chart's underlying changes). A no-op on mount
  // (nothing "changes" yet, and the socket likely isn't open regardless -
  // onopen above handles the initial subscribe once it is) and a no-op
  // whenever the socket isn't currently open (onopen will pick up
  // whatever's current in subscriptionsRef once it reconnects).
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const next = new Set(subscriptions.map(keyOf));
    const prev = joinedRef.current;
    for (const s of subscriptions) {
      if (!prev.has(keyOf(s))) ws.send(JSON.stringify({ action: "subscribe", exchange: s.exchange, symbol: s.symbol }));
    }
    for (const key of prev) {
      if (!next.has(key)) {
        const [exchange, symbol] = key.split(":");
        ws.send(JSON.stringify({ action: "unsubscribe", exchange, symbol }));
      }
    }
    joinedRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subsKey is the intentional dependency; subscriptions itself isn't stable across renders
  }, [subsKey]);

  return { connected };
}

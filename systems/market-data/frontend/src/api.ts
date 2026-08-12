// Which market a symbol trades on - the same open-ended union used
// platform-wide (Strategy.segment/Account.segment in the other frontends),
// not a Dhan-specific enum. NSE/MCX (Dhan) and CRYPTO (Delta Exchange
// India) are all wired up to a real provider - see ProviderStatus below.
export type Exchange = "NSE" | "MCX" | "CRYPTO";

// Build-time port (docker-compose.yml's build arg) so a port-shifted
// container group (e.g. a separate local test stack) calls its OWN
// backend instead of a hardcoded dev port. Default matches dev's port, so
// `npm run dev` with no .env still works exactly as before.
const MARKET_DATA_PORT = import.meta.env.VITE_MARKET_DATA_PORT ?? "8001";
const MARKET_DATA_BASE_URL = `http://${location.hostname}:${MARKET_DATA_PORT}`;

async function asJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status}`);
  }
  return res.json();
}

export type Health = {
  status: string;
};

export async function fetchHealth(): Promise<Health> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/health`);
  return asJson(res, "GET /health");
}

// Mirrors the backend's ProviderStatus (app/domain/models.py) - one row
// per registered QuoteProvider (app/providers/router.py's all_providers())
// - "dhan-nse"/"dhan-mcx"/"delta-india" today, shown automatically with
// no frontend change needed when a new one is registered.
export type ProviderStatus = {
  provider: string;
  symbol_count: number;
  last_synced_at: string | null;
};

export async function fetchSyncStatus(): Promise<ProviderStatus[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/sync-status`);
  return asJson(res, "GET /instruments/sync-status");
}

export async function triggerSync(): Promise<ProviderStatus[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/sync`, { method: "POST" });
  return asJson(res, "POST /instruments/sync");
}

// One entry per subscribed symbol on a provider's live market feed
// WebSocket (app/providers/dhan_feed.py / delta_feed.py) - keyed
// "EXCHANGE:SYMBOL" to match the backend's feed_status() shape. `ltt`
// (last-trade-time) is Dhan-only - Delta's own ticks don't carry a
// separate trade timestamp, just `received_at`, so it's optional here.
export type FeedTick = {
  price: number;
  ltt?: string; // ISO-8601, the tick's own last-trade-time (Dhan only)
  received_at: string; // ISO-8601, when this backend process received it
};

export type FeedStatus = {
  connected: boolean;
  connected_at: string | null;
  last_message_at: string | null;
  reconnect_count: number;
  last_error: string | null;
  ticks: Record<string, FeedTick>;
};

export async function fetchFeedStatus(): Promise<FeedStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/dhan/feed-status`);
  return asJson(res, "GET /dhan/feed-status");
}

export async function subscribeFeed(exchange: Exchange, symbol: string): Promise<FeedStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/dhan/feed/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exchange, symbol }),
  });
  return asJson(res, "POST /dhan/feed/subscribe");
}

// Delta Exchange India's own live feed (app/providers/delta_feed.py) -
// same shape, separate endpoints (kept on its own /delta/... path rather
// than a shared one, see docs/architecture.md).
export async function fetchDeltaFeedStatus(): Promise<FeedStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/delta/feed-status`);
  return asJson(res, "GET /delta/feed-status");
}

export async function subscribeDeltaFeed(exchange: Exchange, symbol: string): Promise<FeedStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/delta/feed/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exchange, symbol }),
  });
  return asJson(res, "POST /delta/feed/subscribe");
}

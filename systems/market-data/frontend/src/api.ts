import { clearAuthToken, getAuthToken } from "./auth";

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

// Every route below requires an admin Bearer token (require_admin, see
// docs/architecture.md) - this wrapper layers the stored token onto an
// otherwise-identical fetch() call, same authFetch pattern execution/
// frontend already uses. A 401 here only ever means "token missing/
// expired/invalid or not an admin" (never a domain error on these
// routes), so it's safe to treat any 401 as "session expired" and clear
// it - DhanAdminSection's own poll loop re-checks auth state and falls
// back to the login prompt on its next tick, no full-page reload needed
// (unlike execution/frontend's whole-app gate, this is one section of an
// otherwise-public dashboard).
function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) clearAuthToken();
    return res;
  });
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

// Dhan-only (unlike Delta below) - admin-gated server-side, see authFetch's
// own comment.
export async function fetchFeedStatus(): Promise<FeedStatus> {
  const res = await authFetch(`${MARKET_DATA_BASE_URL}/dhan/feed-status`);
  return asJson(res, "GET /dhan/feed-status");
}

export async function subscribeFeed(exchange: Exchange, symbol: string): Promise<FeedStatus> {
  const res = await authFetch(`${MARKET_DATA_BASE_URL}/dhan/feed/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exchange, symbol }),
  });
  return asJson(res, "POST /dhan/feed/subscribe");
}

// Data provider (Dhan) credentials - moved here from execution/frontend
// (its former admin console) since this is market-data's own data, not
// execution's - see docs/architecture.md. Admin-gated server-side
// (require_admin) same as the feed routes above.
export type DhanStatus = {
  renewed: boolean;
  last_renewed_at: string | null;
  expiry_time: string | null;
  dhan_client_name: string | null;
  create_time: string | null;
  dhan_client_id: string;
  has_access_token: boolean;
};

export async function fetchDhanStatus(): Promise<DhanStatus> {
  const res = await authFetch(`${MARKET_DATA_BASE_URL}/dhan/token-status`);
  return asJson(res, "GET /dhan/token-status");
}

// Sets both the Dhan client ID and access token at runtime - in-memory
// only (see set_manual_credentials' own docstring), no restart needed,
// but also doesn't survive one.
export async function updateDhanCredentials(clientId: string, accessToken: string): Promise<DhanStatus> {
  const res = await authFetch(`${MARKET_DATA_BASE_URL}/dhan/credentials`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, access_token: accessToken }),
  });
  return asJson(res, "PUT /dhan/credentials");
}

export async function renewDhanToken(): Promise<unknown> {
  const res = await authFetch(`${MARKET_DATA_BASE_URL}/dhan/renew-token`, { method: "POST" });
  return asJson(res, "POST /dhan/renew-token");
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

import { useEffect, useState } from "react";

import {
  Exchange,
  FeedStatus,
  Health,
  ProviderStatus,
  fetchDeltaFeedStatus,
  fetchFeedStatus,
  fetchHealth,
  fetchSyncStatus,
  subscribeDeltaFeed,
  subscribeFeed,
  triggerSync,
} from "./api";

const POLL_INTERVAL_MS = 5000;

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function HealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchHealth();
        if (!cancelled) {
          setHealth(data);
          setUnreachable(false);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setUnreachable(true);
        }
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ok = health?.status === "ok";

  return (
    <section className="panel">
      <h2>
        <span className={`dot ${ok ? "good" : "bad"}`} />
        Health
      </h2>
      <p className="status-line">
        {unreachable ? (
          <>
            <strong>Unreachable</strong> - backend did not respond
          </>
        ) : ok ? (
          <>
            <strong>OK</strong>
          </>
        ) : (
          <>
            <strong>Unexpected response</strong>
          </>
        )}
      </p>
    </section>
  );
}

function DataFreshnessPanel() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchSyncStatus();
        if (!cancelled) {
          setProviders(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch sync status");
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      const data = await triggerSync();
      setProviders(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="panel">
      <h2>Historical data</h2>
      {error && <p className="error">{error}</p>}
      {providers.length === 0 ? (
        <p className="empty">No providers reported yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Symbols</th>
              <th>Last synced</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.provider}>
                <td>{p.provider}</td>
                <td className="num">{p.symbol_count}</td>
                <td>{relativeTime(p.last_synced_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="secondary" onClick={handleSync} disabled={syncing}>
        {syncing ? "Syncing..." : "Sync now"}
      </button>
    </section>
  );
}

type LiveFeedPanelProps = {
  title: string;
  fetchStatus: () => Promise<FeedStatus>;
  subscribe: (exchange: Exchange, symbol: string) => Promise<FeedStatus>;
  exchangeOptions: Exchange[];
  symbolPlaceholder: string;
};

// Parameterized over which provider's feed it talks to - Dhan and Delta
// (app/providers/dhan_feed.py / delta_feed.py) expose the identical
// FeedStatus shape on separate /dhan/... and /delta/... routes, so this
// is the same panel rendered twice below rather than two near-duplicate
// components.
function LiveFeedPanel({ title, fetchStatus, subscribe, exchangeOptions, symbolPlaceholder }: LiveFeedPanelProps) {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exchange, setExchange] = useState<Exchange>(exchangeOptions[0]);
  const [symbol, setSymbol] = useState("");
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchStatus();
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch feed status");
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchStatus]);

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol.trim()) return;
    setSubscribing(true);
    try {
      const data = await subscribe(exchange, symbol.trim());
      setStatus(data);
      setError(null);
      setSymbol("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Subscribe failed");
    } finally {
      setSubscribing(false);
    }
  }

  const ticks = Object.entries(status?.ticks ?? {});

  return (
    <section className="panel">
      <h2>
        <span className={`dot ${status?.connected ? "good" : "bad"}`} />
        {title}
      </h2>
      {error && <p className="error">{error}</p>}
      <p className="status-line">
        {status?.connected ? (
          <>
            <strong>Connected</strong> since {relativeTime(status.connected_at)} - last message {relativeTime(status.last_message_at)}
          </>
        ) : (
          <>
            <strong>Disconnected</strong>
            {status && status.reconnect_count > 0 && ` - reconnected ${status.reconnect_count}x`}
          </>
        )}
      </p>
      {status?.last_error && <p className="status-line">Last error: {status.last_error}</p>}
      {ticks.length === 0 ? (
        <p className="empty">No ticks yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Price</th>
              <th>Last trade</th>
            </tr>
          </thead>
          <tbody>
            {ticks.map(([key, tick]) => (
              <tr key={key}>
                <td>{key}</td>
                <td className="num">{tick.price}</td>
                {/* ltt (Dhan's own trade timestamp) falls back to received_at for Delta's ticks, which don't carry one */}
                <td>{relativeTime(tick.ltt ?? tick.received_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="subscribe-form" onSubmit={handleSubscribe}>
        <select value={exchange} onChange={(e) => setExchange(e.target.value as Exchange)}>
          {exchangeOptions.map((ex) => (
            <option key={ex} value={ex}>
              {ex}
            </option>
          ))}
        </select>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={symbolPlaceholder} />
        <button type="submit" disabled={subscribing || !symbol.trim()}>
          {subscribing ? "Adding..." : "Subscribe"}
        </button>
      </form>
    </section>
  );
}

export default function App() {
  return (
    <main>
      <header>
        <h1>market-data</h1>
        <p className="subtitle">Provider credentials, instrument sync, and live quotes - status at a glance.</p>
      </header>
      <div className="panel-grid">
        <HealthPanel />
        <DataFreshnessPanel />
        <LiveFeedPanel
          title="Dhan live feed"
          fetchStatus={fetchFeedStatus}
          subscribe={subscribeFeed}
          exchangeOptions={["NSE", "MCX"]}
          symbolPlaceholder="e.g. RELIANCE"
        />
        <LiveFeedPanel
          title="Delta live feed"
          fetchStatus={fetchDeltaFeedStatus}
          subscribe={subscribeDeltaFeed}
          exchangeOptions={["CRYPTO"]}
          symbolPlaceholder="e.g. BTCUSD"
        />
      </div>
    </main>
  );
}

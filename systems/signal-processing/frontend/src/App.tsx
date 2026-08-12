import { useEffect, useState } from "react";

import { clearSignals, fetchSignals, type ResolvedSignal } from "./api";
import { executionUrl } from "./links";

const POLL_INTERVAL_MS = 5000;

function signalIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("signal_id");
}

export default function App() {
  const [signals, setSignals] = useState<ResolvedSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [signalIdFilter] = useState<string | null>(signalIdFromUrl);
  const [clearing, setClearing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchSignals({ signalId: signalIdFilter ?? undefined });
        if (!cancelled) {
          setSignals(data);
          setError(null);
          setLastUpdated(new Date());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load signals");
        }
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [signalIdFilter]);

  async function handleClearSignals() {
    const confirmed = window.confirm(
      "Delete every signal, resolved order, and raw payload? This can't be undone. Strategies and positions " +
        "in the other systems are untouched.",
    );
    if (!confirmed) return;
    setClearing(true);
    setActionMessage(null);
    try {
      const result = await clearSignals();
      setActionMessage(
        `Cleared ${result.signals_deleted} signals, ${result.resolved_orders_deleted} resolved orders, ` +
          `${result.raw_payloads_deleted} raw payloads.`,
      );
      setSignals([]);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to clear signals");
    } finally {
      setClearing(false);
    }
  }

  return (
    <main>
      <header className="header-row">
        <div>
          <h1>signal-processing</h1>
          <p className="subtitle">
            Incoming signals and their resolved horizon / instrument, refreshed every{" "}
            {POLL_INTERVAL_MS / 1000}s.
            {lastUpdated && <span className="updated"> Last updated {lastUpdated.toLocaleTimeString()}</span>}
          </p>
        </div>
        <button type="button" className="danger" onClick={handleClearSignals} disabled={clearing}>
          {clearing ? "Clearing..." : "Clear all signals"}
        </button>
      </header>

      {actionMessage && <p className="action-message">{actionMessage}</p>}

      {signalIdFilter && (
        <p className="filter-banner">
          Showing signal <code>{signalIdFilter}</code> only. <a href="/">Clear filter</a>
        </p>
      )}

      {error && <p className="error">Could not reach the backend: {error}</p>}

      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Symbol</th>
            <th>Exch</th>
            <th>Action</th>
            <th>Price</th>
            <th>Source</th>
            <th>Horizon</th>
            <th>Instrument</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {signals.length === 0 && !error && (
            <tr>
              <td colSpan={10} className="empty">
                {signalIdFilter
                  ? "No signal found with that ID."
                  : "No signals yet - send one via a Chartink webhook or `make test-signal`."}
              </td>
            </tr>
          )}
          {signals.map((s) => (
            <tr key={s.signal_id}>
              <td>{new Date(s.received_at).toLocaleString()}</td>
              <td className="symbol">{s.symbol}</td>
              <td>{s.exchange}</td>
              <td>
                <span className={`badge ${s.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{s.action}</span>
              </td>
              <td className="num">{s.price.toFixed(2)}</td>
              <td>{s.source}</td>
              <td>{s.horizon ?? "-"}</td>
              <td>{s.instrument_type ?? "-"}</td>
              <td title={s.rejection_reason ?? undefined}>{s.status ?? "-"}</td>
              <td>
                <a href={executionUrl(s.signal_id)} target="_blank" rel="noreferrer" className="crosslink">
                  Execution &rarr;
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

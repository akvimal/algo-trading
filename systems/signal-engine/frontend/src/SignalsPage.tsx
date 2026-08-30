import { useEffect, useState } from "react";

import { clearSignals, fetchSignals, type ProviderSignal } from "./api";

// The old signal-processing frontend's whole app, folded in as a tab here
// after the signal-engine merge (2026-08-28, see docs/architecture.md) -
// incoming signals and their resolved horizon/instrument, across every
// strategy (Strategies/Rules tabs already show a per-strategy slice of
// this same data via fetchSignalsForStrategy).
const POLL_INTERVAL_MS = 5000;
const SEGMENTS = ["NSE", "MCX", "CRYPTO"] as const;

function signalIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("signal_id");
}

// Time only ("2:23 PM") - the date filter below narrows the grid to one
// day at a time, so the date itself doesn't need repeating per row.
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Local (not UTC) YYYY-MM-DD, so the date filter/input line up with the
// user's own calendar day rather than shifting at UTC midnight.
function localDateStr(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayLocalDate(): string {
  return localDateStr(new Date().toISOString());
}

// 2-letter codes for the consolidated Info column's Horizon/Instrument
// badges - null (not yet resolved) renders as "-" rather than looking
// these up.
const HORIZON_CODES: Record<string, string> = { intraday: "ID", positional: "PO" };
const INSTRUMENT_CODES: Record<string, string> = { spot: "SP", future: "FU", option: "OP" };

// Status badge: 1-letter code + a color matching this app's existing
// buy/sell semantic tokens (green=resolved-and-pending, red=rejected,
// muted=queued/sent - "sent" is a real resolved_orders.status value,
// just not one this pipeline sets today).
function statusCode(status: string | null): string {
  return status ? status[0].toUpperCase() : "-";
}

function statusBadgeClass(status: string | null): string {
  if (status === "pending") return "badge-mini-buy";
  if (status === "rejected") return "badge-mini-sell";
  return "badge-mini-muted";
}

function statusTitle(status: string | null, rejectionReason: string | null): string {
  if (!status) return "not yet resolved";
  return status === "rejected" && rejectionReason ? `${status} - ${rejectionReason}` : status;
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<ProviderSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [signalIdFilter] = useState<string | null>(signalIdFromUrl);
  const [dateFilter, setDateFilter] = useState<string>(todayLocalDate);
  const [segmentFilter, setSegmentFilter] = useState<(typeof SEGMENTS)[number] | "ALL">("ALL");
  const [clearing, setClearing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchSignals({ signalId: signalIdFilter ?? undefined, limit: 200 });
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
      "Delete every signal, resolved order, and raw payload? This can't be undone. Strategies " +
        "and positions in execution are untouched.",
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

  // Date filter is skipped in signal-id deep-link mode (that view is "show
  // me this one row", not "show me this one day") - segment filter still
  // applies in both modes.
  const dateFiltered = signalIdFilter ? signals : signals.filter((s) => localDateStr(s.received_at) === dateFilter);
  const filtered = segmentFilter === "ALL" ? dateFiltered : dateFiltered.filter((s) => s.exchange === segmentFilter);

  return (
    <>
      <header className="header-row">
        <p className="subtitle">
          Incoming signals and their resolved horizon / instrument, across every strategy, refreshed every{" "}
          {POLL_INTERVAL_MS / 1000}s.
          {lastUpdated && <span className="updated"> Last updated {lastUpdated.toLocaleTimeString()}</span>}
        </p>
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

      <div className="settings-row">
        {!signalIdFilter && (
          <label>
            Date
            <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} />
          </label>
        )}
        {!signalIdFilter && dateFilter !== todayLocalDate() && (
          <button type="button" className="secondary tiny" onClick={() => setDateFilter(todayLocalDate())}>
            Today
          </button>
        )}
        <label>
          Segment
          <select value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value as (typeof SEGMENTS)[number] | "ALL")}>
            <option value="ALL">All</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error">Could not reach the backend: {error}</p>}

      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Symbol</th>
            <th>Exch</th>
            <th>Action</th>
            <th>Price</th>
            <th>Info</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && !error && (
            <tr>
              <td colSpan={6} className="empty">
                {signalIdFilter
                  ? "No signal found with that ID."
                  : "No signals yet - send one via a Chartink webhook or `make test-signal`."}
              </td>
            </tr>
          )}
          {filtered.map((s) => (
            <tr key={s.signal_id}>
              <td>{formatTime(s.received_at)}</td>
              <td className="symbol">{s.symbol}</td>
              <td>{s.exchange}</td>
              <td>
                <span className={`badge ${s.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{s.action}</span>
              </td>
              <td className="num">{s.price.toFixed(2)}</td>
              <td>
                <span className="badge-mini badge-mini-muted" title={s.horizon ?? "not yet resolved"}>
                  {s.horizon ? (HORIZON_CODES[s.horizon] ?? s.horizon) : "-"}
                </span>
                <span className="badge-mini badge-mini-muted" title={s.instrument_type ?? "not yet resolved"}>
                  {s.instrument_type ? (INSTRUMENT_CODES[s.instrument_type] ?? s.instrument_type) : "-"}
                </span>
                <span className={`badge-mini ${statusBadgeClass(s.status)}`} title={statusTitle(s.status, s.rejection_reason)}>
                  {statusCode(s.status)}
                </span>
                <span className="badge-mini badge-mini-muted" title={s.source}>
                  {s.source}
                </span>
                {s.status === "rejected" && s.rejection_reason && (
                  <span className="rejection-note">{s.rejection_reason}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

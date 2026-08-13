import { useEffect, useState } from "react";

import {
  type Account,
  type Position,
  checkExitsNow,
  clearPositions,
  fetchPositions,
  squareOffNow,
  squareOffPosition,
} from "./api";
import Nav from "./Nav";
import { SEGMENTS, formatPct, formatTime, localDateStr, pnlPercent, todayLocalDate } from "./format";

const POLL_INTERVAL_MS = 5000;

function signalIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("signal_id");
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [signalIdFilter] = useState<string | null>(signalIdFromUrl);
  const [dateFilter, setDateFilter] = useState<string>(todayLocalDate);
  const [segmentFilter, setSegmentFilter] = useState<Account["segment"] | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [squaringOff, setSquaringOff] = useState(false);
  const [checkingExits, setCheckingExits] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [squaringOffId, setSquaringOffId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const positionsData = await fetchPositions({ signalId: signalIdFilter ?? undefined, withLivePnl: true });
        if (!cancelled) {
          setPositions(positionsData);
          setError(null);
          setLastUpdated(new Date());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load execution data");
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

  async function refreshPositions() {
    const fresh = await fetchPositions({ signalId: signalIdFilter ?? undefined, withLivePnl: true });
    setPositions(fresh);
  }

  async function handleSquareOffNow() {
    setSquaringOff(true);
    setActionMessage(null);
    try {
      const result = await squareOffNow();
      setActionMessage(
        `Square-off done: ${result.closed} closed, ${result.failed} left open (quote unavailable), ${result.total_open} were open.`,
      );
      await refreshPositions();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Square-off failed");
    } finally {
      setSquaringOff(false);
    }
  }

  async function handleCheckExitsNow() {
    setCheckingExits(true);
    setActionMessage(null);
    try {
      const result = await checkExitsNow();
      setActionMessage(
        `Exit check done: ${result.closed_stop_loss} stopped out, ${result.closed_target} hit target, ` +
          `${result.trailed} trailed, ${result.checked} positions had a stop-loss/target to check.`,
      );
      await refreshPositions();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Exit check failed");
    } finally {
      setCheckingExits(false);
    }
  }

  async function handleClearPositions() {
    const confirmed = window.confirm(
      "Delete every position (OPEN/CLOSED/REJECTED) and every option position group? This can't be " +
        "undone. Settings, signals in signal-processing, and strategies in signal-generation are untouched.",
    );
    if (!confirmed) return;
    setClearing(true);
    setActionMessage(null);
    try {
      const result = await clearPositions();
      setActionMessage(`Cleared ${result.positions_deleted} positions and ${result.option_groups_deleted} option groups.`);
      setPositions([]);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to clear positions");
    } finally {
      setClearing(false);
    }
  }

  async function handleSquareOffOne(p: Position) {
    const confirmed = window.confirm(`Square off ${p.symbol} (qty ${p.quantity ?? "-"}) at the current price?`);
    if (!confirmed) return;
    setSquaringOffId(p.id);
    setActionMessage(null);
    try {
      const result = await squareOffPosition(p.id);
      setActionMessage(
        `Closed ${result.symbol} at ${result.exit_price.toFixed(2)} (P&L ${result.pnl >= 0 ? "+" : ""}${result.pnl.toFixed(2)}).`,
      );
      await refreshPositions();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to square off position");
    } finally {
      setSquaringOffId(null);
    }
  }

  // The date filter is skipped entirely in signal-id deep-link mode (that
  // view is "show me this one row", not "show me this one day"). Segment
  // filter applies in both modes - narrowing to one account is useful
  // even inside a deep link.
  const dateFiltered = signalIdFilter
    ? positions
    : positions.filter((p) => localDateStr(p.entry_time) === dateFilter);
  const filtered = segmentFilter === "ALL" ? dateFiltered : dateFiltered.filter((p) => p.segment === segmentFilter);

  const open = filtered.filter((p) => p.status === "OPEN");
  const closed = filtered.filter((p) => p.status === "CLOSED");
  const rejected = filtered.filter((p) => p.status === "REJECTED");
  // Orders grid = everything no longer live - CLOSED (real P&L) and
  // REJECTED (never filled, shows the rejection reason instead) side by
  // side, newest first by whichever of exit_time/entry_time applies.
  const orders = [...closed, ...rejected].sort(
    (a, b) => new Date(b.exit_time ?? b.entry_time).getTime() - new Date(a.exit_time ?? a.entry_time).getTime(),
  );
  const totalPnl = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const openWithLivePnl = open.filter((p) => p.unrealized_pnl != null);
  const totalUnrealizedPnl = openWithLivePnl.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);

  return (
    <main>
      <header>
        <div className="header-row">
          <h1>execution</h1>
          <Nav active="positions" />
        </div>
        <p className="subtitle">
          Refreshed every {POLL_INTERVAL_MS / 1000}s.
          {lastUpdated && <span className="updated"> Last updated {lastUpdated.toLocaleTimeString()}</span>}
        </p>
      </header>

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
          Account
          <select value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value as Account["segment"] | "ALL")}>
            <option value="ALL">All</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleSquareOffNow} disabled={squaringOff} className="secondary tiny">
          {squaringOff ? "Squaring off..." : "Square off now"}
        </button>
        <button onClick={handleCheckExitsNow} disabled={checkingExits} className="secondary tiny">
          {checkingExits ? "Checking..." : "Check exits now"}
        </button>
        <button onClick={handleClearPositions} disabled={clearing} className="danger tiny">
          {clearing ? "Clearing..." : "Clear positions"}
        </button>
      </div>

      {error && <p className="error">Could not reach the backend: {error}</p>}
      {actionMessage && <p className="action-message">{actionMessage}</p>}

      <section className="summary">
        <div className="stat">
          <span className="stat-label">Open</span>
          <span className="stat-value">{open.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Closed</span>
          <span className="stat-value">{closed.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Rejected</span>
          <span className="stat-value">{rejected.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Realized P&amp;L</span>
          <span className={`stat-value num ${totalPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
            {totalPnl >= 0 ? "+" : ""}
            {totalPnl.toFixed(2)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Unrealized P&amp;L (live)</span>
          <span className={`stat-value num ${totalUnrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
            {open.length === 0 ? "-" : `${totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}`}
            {open.length > openWithLivePnl.length && (
              <span className="muted"> ({open.length - openWithLivePnl.length} quote unavailable)</span>
            )}
          </span>
        </div>
      </section>

      <h2 className="section-title">Positions</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Symbol</th>
              <th>Segment</th>
              <th>Action</th>
              <th>Qty</th>
              <th>Entry Px</th>
              <th>CMP</th>
              <th>Unrealized P&amp;L</th>
              <th>Stop-loss</th>
              <th>Target</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && !error && (
              <tr>
                <td colSpan={11} className="empty">
                  {signalIdFilter ? "No open position found for that signal." : "No open positions."}
                </td>
              </tr>
            )}
            {open.map((p) => (
              <tr key={p.id}>
                <td>{formatTime(p.entry_time)}</td>
                <td className="symbol">
                  {p.symbol} <span className="muted">{p.exchange}</span>
                </td>
                <td>{p.segment}</td>
                <td>
                  <span className={`badge ${p.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{p.action}</span>
                </td>
                <td className="num">{p.quantity ?? "-"}</td>
                <td className="num">{p.entry_price.toFixed(2)}</td>
                <td className="num">{p.live_price?.toFixed(2) ?? "-"}</td>
                <td
                  className={`num ${p.unrealized_pnl != null ? (p.unrealized_pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""} pnl-live`}
                  title="Unrealized - not yet closed"
                >
                  {p.unrealized_pnl != null ? `${p.unrealized_pnl >= 0 ? "+" : ""}${p.unrealized_pnl.toFixed(2)}` : "-"}
                  {formatPct(pnlPercent(p.unrealized_pnl, p.entry_price, p.quantity))}
                </td>
                <td className="num" title={p.trailing_stop_enabled ? "Trailing" : undefined}>
                  {p.stop_loss_price != null ? p.stop_loss_price.toFixed(2) : "-"}
                  {p.stop_loss_price != null && p.trailing_stop_enabled && <span className="muted"> &#8599;</span>}
                </td>
                <td className="num">{p.target_price != null ? p.target_price.toFixed(2) : "-"}</td>
                <td>
                  <button
                    type="button"
                    className="danger tiny"
                    onClick={() => handleSquareOffOne(p)}
                    disabled={squaringOffId === p.id}
                  >
                    {squaringOffId === p.id ? "Closing..." : "Square off"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">Orders</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Exit</th>
              <th>Symbol</th>
              <th>Segment</th>
              <th>Action</th>
              <th>Qty</th>
              <th>Entry Px</th>
              <th>Exit Px</th>
              <th>P&amp;L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && !error && (
              <tr>
                <td colSpan={10} className="empty">
                  {signalIdFilter ? "No order found for that signal." : "No orders yet."}
                </td>
              </tr>
            )}
            {orders.map((p) => (
              <tr key={p.id}>
                <td>{formatTime(p.entry_time)}</td>
                <td>{p.exit_time ? formatTime(p.exit_time) : "-"}</td>
                <td className="symbol">
                  {p.symbol} <span className="muted">{p.exchange}</span>
                </td>
                <td>{p.segment}</td>
                <td>
                  <span className={`badge ${p.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{p.action}</span>
                </td>
                <td className="num">{p.quantity ?? "-"}</td>
                <td className="num">{p.entry_price.toFixed(2)}</td>
                <td className="num">{p.exit_price?.toFixed(2) ?? "-"}</td>
                <td className={`num ${p.pnl != null ? (p.pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                  {p.pnl != null ? `${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}` : "-"}
                  {formatPct(pnlPercent(p.pnl, p.entry_price, p.quantity))}
                </td>
                <td title={p.rejection_reason ?? p.exit_reason ?? undefined}>
                  {p.status}
                  {p.exit_reason && <span className="muted"> ({p.exit_reason.replace("_", " ")})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

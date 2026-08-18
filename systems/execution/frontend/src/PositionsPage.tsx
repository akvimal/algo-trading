import { Fragment, useEffect, useState } from "react";

import {
  type Account,
  type OptionGroup,
  type Position,
  checkExitsNow,
  checkOptionGroupExitsNow,
  clearPositions,
  fetchOptionGroups,
  fetchPositions,
  fetchStrategyNames,
  squareOffNow,
  squareOffOptionGroup,
  squareOffOptionGroupsNow,
  squareOffPosition,
  updateOptionGroupSpotStopLoss,
  updateOptionGroupStopLoss,
} from "./api";
import Nav from "./Nav";
import { SEGMENTS, formatPct, formatTime, localDateStr, pnlPercent, todayLocalDate } from "./format";

function combinedExitPrice(g: OptionGroup): number | null {
  const buyLeg = g.legs.find((l) => l.action === "BUY");
  const sellLeg = g.legs.find((l) => l.action === "SELL");
  if (buyLeg?.exit_price == null) return null;
  return buyLeg.exit_price - (sellLeg?.exit_price ?? 0);
}

// "Value" column - total premium committed (lots × net debit per unit),
// not the bare per-unit premium net_debit is on its own.
function groupValue(g: OptionGroup): number | null {
  if (g.net_debit == null || g.quantity == null) return null;
  return g.net_debit * g.quantity;
}

// "Signal" column - the originating signal-generation Strategy's name, or
// "Manual" for the Manual tab's option orders (strategy_id null - see
// docs/architecture.md's "Manual tab" section). Falls back to the raw id
// if the name lookup hasn't loaded yet (or the Strategy was since
// deleted) rather than blocking the row on it.
function signalLabel(g: OptionGroup, strategyNames: Record<string, string>): string {
  if (g.strategy_id == null) return "Manual";
  return strategyNames[g.strategy_id] ?? g.strategy_id;
}

// % distance of a price from some base (net debit for the premium SL/
// target, entry spot price for the underlying-based stop) - a positive %
// is above the base, negative below.
function pctFrom(price: number | null, base: number | null): number | null {
  if (price == null || base == null || base === 0) return null;
  return ((price - base) / base) * 100;
}

const POLL_INTERVAL_MS = 5000;

function signalIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("signal_id");
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [optionGroups, setOptionGroups] = useState<OptionGroup[]>([]);
  const [signalIdFilter] = useState<string | null>(signalIdFromUrl);
  const [dateFilter, setDateFilter] = useState<string>(todayLocalDate);
  const [segmentFilter, setSegmentFilter] = useState<Account["segment"] | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [squaringOff, setSquaringOff] = useState(false);
  const [checkingExits, setCheckingExits] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [squaringOffId, setSquaringOffId] = useState<string | null>(null);
  const [squaringOffGroupId, setSquaringOffGroupId] = useState<string | null>(null);
  const [editingSlGroupId, setEditingSlGroupId] = useState<string | null>(null);
  const [editingSpotSlGroupId, setEditingSpotSlGroupId] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [instrumentTab, setInstrumentTab] = useState<"spot" | "derivatives">("spot");
  const [subTab, setSubTab] = useState<"positions" | "orders">("positions");
  const [strategyNames, setStrategyNames] = useState<Record<string, string>>({});

  // One-time, not on the 5s poll - strategy names essentially never
  // change mid-session, and this is a separate cross-system CORS call
  // (signal-generation), not execution's own data.
  useEffect(() => {
    let cancelled = false;
    fetchStrategyNames()
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const s of rows) map[s.id] = s.name;
        setStrategyNames(map);
      })
      .catch(() => {
        // Best-effort - the Signal column just falls back to the raw id.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [positionsData, groupsData] = await Promise.all([
          fetchPositions({ signalId: signalIdFilter ?? undefined, withLivePnl: true }),
          fetchOptionGroups({ signalId: signalIdFilter ?? undefined, withLivePnl: true }),
        ]);
        if (!cancelled) {
          setPositions(positionsData);
          setOptionGroups(groupsData);
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

  async function refreshAll() {
    const [freshPositions, freshGroups] = await Promise.all([
      fetchPositions({ signalId: signalIdFilter ?? undefined, withLivePnl: true }),
      fetchOptionGroups({ signalId: signalIdFilter ?? undefined, withLivePnl: true }),
    ]);
    setPositions(freshPositions);
    setOptionGroups(freshGroups);
  }

  async function handleSquareOffNow() {
    setSquaringOff(true);
    setActionMessage(null);
    try {
      const [result, groupResult] = await Promise.all([squareOffNow(), squareOffOptionGroupsNow()]);
      setActionMessage(
        `Square-off done: ${result.closed + groupResult.closed} closed ` +
          `(${result.closed} position(s), ${groupResult.closed} option group(s)), ` +
          `${result.failed + groupResult.failed} left open (quote unavailable).`,
      );
      await refreshAll();
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
      const [result, groupResult] = await Promise.all([checkExitsNow(), checkOptionGroupExitsNow()]);
      setActionMessage(
        `Exit check done: ${result.closed_stop_loss + groupResult.closed_stop_loss} stopped out, ` +
          `${result.closed_target + groupResult.closed_target} hit target, ${result.trailed} trailed, ` +
          `${result.checked + groupResult.checked} had a stop-loss/target to check.`,
      );
      await refreshAll();
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
      setOptionGroups([]);
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
      await refreshAll();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to square off position");
    } finally {
      setSquaringOffId(null);
    }
  }

  async function handleSquareOffGroup(g: OptionGroup) {
    const confirmed = window.confirm(
      `Square off ${g.underlying_symbol} ${g.strategy_type} (${g.legs.length} leg(s), qty ${g.quantity ?? "-"}) ` +
        "at current prices? Both legs close together.",
    );
    if (!confirmed) return;
    setSquaringOffGroupId(g.id);
    setActionMessage(null);
    try {
      const result = await squareOffOptionGroup(g.id);
      setActionMessage(
        `Closed ${result.underlying_symbol} (P&L ${result.pnl >= 0 ? "+" : ""}${result.pnl.toFixed(2)}).`,
      );
      await refreshAll();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to square off option group");
    } finally {
      setSquaringOffGroupId(null);
    }
  }

  // Only sl_scope='combined' groups can be edited here (matches the
  // backend's own restriction - see PUT /option-groups/{id}/stop-loss).
  // Takes a % below net debit (always a "BUY"-direction combined position,
  // see option_position_manager.py's module docstring) and converts to the
  // absolute price the API actually stores, same formula
  // compute_stop_loss_percent_price("BUY", ...) uses at open time.
  async function handleEditGroupSl(g: OptionGroup) {
    if (g.sl_scope !== "combined" || g.net_debit == null) return;
    const currentPct = pctFrom(g.combined_stop_loss_price, g.net_debit);
    const input = window.prompt(
      `New stop-loss, as % below net debit (${g.net_debit.toFixed(2)}) for ${g.underlying_symbol} ` +
        `${g.strategy_type}. E.g. 20 stops at ${(g.net_debit * 0.8).toFixed(2)}.`,
      currentPct != null ? (-currentPct).toFixed(1) : "",
    );
    if (input == null || input.trim() === "") return;
    const pct = Number(input);
    if (!Number.isFinite(pct)) {
      setActionMessage("Enter a valid number for stop-loss %.");
      return;
    }
    const newPrice = g.net_debit * (1 - pct / 100);
    setEditingSlGroupId(g.id);
    setActionMessage(null);
    try {
      await updateOptionGroupStopLoss(g.id, newPrice);
      setActionMessage(`Updated ${g.underlying_symbol} stop-loss to ${newPrice.toFixed(2)} (${pct}% below net debit).`);
      await refreshAll();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to update stop-loss");
    } finally {
      setEditingSlGroupId(null);
    }
  }

  // The primary, underlying-based stop - independent of sl_scope/the
  // premium stop above (see updateOptionGroupSpotStopLoss's own comment).
  // Direction-aware same as the premium version: BUY closes if spot FALLS
  // to/through the stop, SELL if it RISES to/through it.
  async function handleEditGroupSpotSl(g: OptionGroup) {
    if (g.entry_spot_price == null) {
      setActionMessage(`No entry spot price recorded for ${g.underlying_symbol} - can't set a spot-based stop-loss.`);
      return;
    }
    const currentPct = pctFrom(g.spot_stop_loss_price, g.entry_spot_price);
    const direction = g.action === "BUY" ? "falls to/through" : "rises to/through";
    const examplePrice = g.action === "BUY" ? g.entry_spot_price * 0.99 : g.entry_spot_price * 1.01;
    const input = window.prompt(
      `New stop-loss for ${g.underlying_symbol}, as % away from entry spot (${g.entry_spot_price.toFixed(2)}). ` +
        `Closes when spot ${direction} it. E.g. 1 = ${examplePrice.toFixed(2)}.`,
      currentPct != null ? Math.abs(currentPct).toFixed(2) : "",
    );
    if (input == null || input.trim() === "") return;
    const pct = Number(input);
    if (!Number.isFinite(pct)) {
      setActionMessage("Enter a valid number for stop-loss %.");
      return;
    }
    const newPrice = g.action === "BUY" ? g.entry_spot_price * (1 - pct / 100) : g.entry_spot_price * (1 + pct / 100);
    setEditingSpotSlGroupId(g.id);
    setActionMessage(null);
    try {
      await updateOptionGroupSpotStopLoss(g.id, newPrice);
      setActionMessage(`Updated ${g.underlying_symbol} stop-loss to ${newPrice.toFixed(2)} (${pct}% from entry spot).`);
      await refreshAll();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to update stop-loss");
    } finally {
      setEditingSpotSlGroupId(null);
    }
  }

  // The date filter is skipped entirely in signal-id deep-link mode (that
  // view is "show me this one row", not "show me this one day"). Segment
  // filter applies in both modes - narrowing to one account is useful
  // even inside a deep link.
  //
  // Legs (Position rows with option_group_id set) are excluded here - they
  // render as part of their OptionGroup below instead of as standalone rows.
  const dateFiltered = signalIdFilter
    ? positions
    : positions.filter((p) => localDateStr(p.entry_time) === dateFilter);
  const filtered = (segmentFilter === "ALL" ? dateFiltered : dateFiltered.filter((p) => p.segment === segmentFilter)).filter(
    (p) => p.option_group_id == null,
  );

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

  const groupDateFiltered = signalIdFilter
    ? optionGroups
    : optionGroups.filter((g) => localDateStr(g.entry_time) === dateFilter);
  const groupFiltered =
    segmentFilter === "ALL" ? groupDateFiltered : groupDateFiltered.filter((g) => g.segment === segmentFilter);

  const openGroups = groupFiltered.filter((g) => g.status === "OPEN");
  const closedGroups = groupFiltered.filter((g) => g.status === "CLOSED");
  const rejectedGroups = groupFiltered.filter((g) => g.status === "REJECTED");
  const groupOrders = [...closedGroups, ...rejectedGroups].sort(
    (a, b) => new Date(b.exit_time ?? b.entry_time).getTime() - new Date(a.exit_time ?? a.entry_time).getTime(),
  );
  const totalGroupPnl = closedGroups.reduce((sum, g) => sum + (g.pnl ?? 0), 0);
  const openGroupsWithLivePnl = openGroups.filter((g) => g.unrealized_pnl != null);
  const totalGroupUnrealizedPnl = openGroupsWithLivePnl.reduce((sum, g) => sum + (g.unrealized_pnl ?? 0), 0);

  // Summary stats fold plain positions and option groups together - one
  // "Open"/"Closed"/"Rejected"/P&L figure for the whole account view.
  const combinedOpenCount = open.length + openGroups.length;
  const combinedClosedCount = closed.length + closedGroups.length;
  const combinedRejectedCount = rejected.length + rejectedGroups.length;
  const combinedTotalPnl = totalPnl + totalGroupPnl;
  const combinedOpenWithLivePnlCount = openWithLivePnl.length + openGroupsWithLivePnl.length;
  const combinedTotalUnrealizedPnl = totalUnrealizedPnl + totalGroupUnrealizedPnl;

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
          <span className="stat-value">{combinedOpenCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Closed</span>
          <span className="stat-value">{combinedClosedCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Rejected</span>
          <span className="stat-value">{combinedRejectedCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Realized P&amp;L</span>
          <span className={`stat-value num ${combinedTotalPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
            {combinedTotalPnl >= 0 ? "+" : ""}
            {combinedTotalPnl.toFixed(2)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Unrealized P&amp;L (live)</span>
          <span className={`stat-value num ${combinedTotalUnrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
            {combinedOpenCount === 0 ? "-" : `${combinedTotalUnrealizedPnl >= 0 ? "+" : ""}${combinedTotalUnrealizedPnl.toFixed(2)}`}
            {combinedOpenCount > combinedOpenWithLivePnlCount && (
              <span className="muted"> ({combinedOpenCount - combinedOpenWithLivePnlCount} quote unavailable)</span>
            )}
          </span>
        </div>
      </section>

      <nav className="tabs">
        <button
          type="button"
          className={instrumentTab === "spot" ? "active" : ""}
          onClick={() => setInstrumentTab("spot")}
        >
          Spot / Future <span className="tab-count">{open.length}</span>
        </button>
        <button
          type="button"
          className={instrumentTab === "derivatives" ? "active" : ""}
          onClick={() => setInstrumentTab("derivatives")}
        >
          Derivatives <span className="tab-count">{openGroups.length}</span>
        </button>
      </nav>
      <nav className="tabs subtabs">
        <button type="button" className={subTab === "positions" ? "active" : ""} onClick={() => setSubTab("positions")}>
          Positions
        </button>
        <button type="button" className={subTab === "orders" ? "active" : ""} onClick={() => setSubTab("orders")}>
          Orders
        </button>
      </nav>

      {instrumentTab === "spot" && subTab === "positions" && (
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && !error && (
              <tr>
                <td colSpan={10} className="empty">
                  {signalIdFilter ? "No open position found for that signal." : "No open positions."}
                </td>
              </tr>
            )}
            {open.map((p) => (
              <tr key={p.id}>
                <td>{formatTime(p.entry_time)}</td>
                <td className="symbol">{p.symbol}</td>
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
      )}

      {instrumentTab === "spot" && subTab === "orders" && (
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
                <td className="symbol">{p.symbol}</td>
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
      )}

      {instrumentTab === "derivatives" && subTab === "positions" && (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Entry</th>
              <th>Underlying</th>
              <th>Action</th>
              <th>Qty</th>
              <th>Value</th>
              <th>Live Spot</th>
              <th>Stop-loss</th>
              <th>Unrealized P&amp;L</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {openGroups.length === 0 && !error && (
              <tr>
                <td colSpan={10} className="empty">
                  {signalIdFilter ? "No open option group found for that signal." : "No open option positions."}
                </td>
              </tr>
            )}
            {openGroups.map((g) => {
              const spotSlPct = pctFrom(g.spot_stop_loss_price, g.entry_spot_price);
              const premiumSlPct = pctFrom(g.combined_stop_loss_price, g.net_debit);
              const premiumTargetPct = pctFrom(g.combined_target_price, g.net_debit);
              const expanded = expandedGroupId === g.id;
              return (
                <Fragment key={g.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="icon-btn secondary"
                        onClick={() => setExpandedGroupId(expanded ? null : g.id)}
                        title={expanded ? "Hide legs" : "Show legs"}
                        aria-label={expanded ? "Hide legs" : "Show legs"}
                      >
                        {expanded ? "▾" : "▸"}
                      </button>
                    </td>
                    <td>{formatTime(g.entry_time)}</td>
                    <td className="symbol">
                      {g.underlying_symbol} <span className="muted">({g.segment})</span>
                    </td>
                    <td>
                      <span className={`badge ${g.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{g.action}</span>
                    </td>
                    <td className="num">{g.quantity ?? "-"}</td>
                    <td className="num">{groupValue(g)?.toFixed(2) ?? "-"}</td>
                    <td className="num">{g.live_spot_price != null ? g.live_spot_price.toFixed(2) : "-"}</td>
                    <td className="num">
                      {g.spot_stop_loss_price != null ? (
                        <>
                          {g.spot_stop_loss_price.toFixed(2)}
                          {formatPct(spotSlPct)}
                        </>
                      ) : (
                        <span className="muted">-</span>
                      )}
                      <button
                        type="button"
                        className="icon-btn secondary edit-icon"
                        onClick={() => handleEditGroupSpotSl(g)}
                        disabled={editingSpotSlGroupId === g.id || g.entry_spot_price == null}
                        title={g.entry_spot_price == null ? "No entry spot price recorded" : "Edit stop-loss (underlying price/%)"}
                        aria-label="Edit stop-loss"
                      >
                        {editingSpotSlGroupId === g.id ? "…" : "✎"}
                      </button>
                    </td>
                    <td
                      className={`num ${g.unrealized_pnl != null ? (g.unrealized_pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""} pnl-live`}
                      title="Unrealized - not yet closed"
                    >
                      {g.unrealized_pnl != null ? `${g.unrealized_pnl >= 0 ? "+" : ""}${g.unrealized_pnl.toFixed(2)}` : "-"}
                      {formatPct(pnlPercent(g.unrealized_pnl, g.net_debit, g.quantity))}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn danger"
                        onClick={() => handleSquareOffGroup(g)}
                        disabled={squaringOffGroupId === g.id}
                        title="Square off (both legs)"
                        aria-label="Square off"
                      >
                        {squaringOffGroupId === g.id ? "…" : "✕"}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="legs-row">
                      <td colSpan={10}>
                        <div className="legs-detail">
                          <div className="legs-detail-header">
                            <strong>{g.strategy_type}</strong>
                            {g.sl_scope === "individual" && <span className="muted"> &middot; individual leg SL/target</span>}
                          </div>
                          <table className="legs-table">
                            <thead>
                              <tr>
                                <th>Leg</th>
                                <th>Symbol</th>
                                <th>Entry</th>
                                <th>Live Px</th>
                                <th>P&amp;L</th>
                                <th>Stop-loss</th>
                                <th>Target</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.legs.map((leg) => (
                                <tr key={leg.id}>
                                  <td>
                                    <span className={`badge ${leg.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{leg.action}</span>
                                  </td>
                                  <td className="symbol">{leg.symbol}</td>
                                  <td className="num">{leg.entry_price.toFixed(2)}</td>
                                  <td className="num">{leg.live_price != null ? leg.live_price.toFixed(2) : "-"}</td>
                                  <td
                                    className={`num ${leg.unrealized_pnl != null ? (leg.unrealized_pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}
                                  >
                                    {leg.unrealized_pnl != null ? `${leg.unrealized_pnl >= 0 ? "+" : ""}${leg.unrealized_pnl.toFixed(2)}` : "-"}
                                  </td>
                                  <td className="num">{leg.stop_loss_price != null ? leg.stop_loss_price.toFixed(2) : "-"}</td>
                                  <td className="num">{leg.target_price != null ? leg.target_price.toFixed(2) : "-"}</td>
                                  <td>{leg.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="legs-detail-footer">
                            <span>
                              Live combined px: <strong>{g.live_combined_price?.toFixed(2) ?? "-"}</strong>
                            </span>
                            <span>
                              Premium SL:{" "}
                              <strong>
                                {g.combined_stop_loss_price != null ? g.combined_stop_loss_price.toFixed(2) : "-"}
                                {formatPct(premiumSlPct)}
                              </strong>
                            </span>
                            <span>
                              Premium target:{" "}
                              <strong>
                                {g.combined_target_price != null ? g.combined_target_price.toFixed(2) : "-"}
                                {formatPct(premiumTargetPct)}
                              </strong>
                            </span>
                            {g.sl_scope === "combined" && (
                              <button
                                type="button"
                                className="secondary tiny"
                                onClick={() => handleEditGroupSl(g)}
                                disabled={editingSlGroupId === g.id}
                              >
                                {editingSlGroupId === g.id ? "Saving..." : "Edit premium SL"}
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {instrumentTab === "derivatives" && subTab === "orders" && (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Entry</th>
              <th>Underlying</th>
              <th>Signal</th>
              <th>Strategy</th>
              <th>Lots</th>
              <th>Value</th>
              <th>Exit</th>
              <th>P&amp;L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {groupOrders.length === 0 && !error && (
              <tr>
                <td colSpan={10} className="empty">
                  {signalIdFilter ? "No option order found for that signal." : "No option orders yet."}
                </td>
              </tr>
            )}
            {groupOrders.map((g) => {
              const expanded = expandedGroupId === g.id;
              const hasLegs = g.legs.length > 0;
              return (
                <Fragment key={g.id}>
                  <tr>
                    <td>
                      {hasLegs && (
                        <button
                          type="button"
                          className="icon-btn secondary"
                          onClick={() => setExpandedGroupId(expanded ? null : g.id)}
                          title={expanded ? "Hide legs" : "Show legs"}
                          aria-label={expanded ? "Hide legs" : "Show legs"}
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                      )}
                    </td>
                    <td>{formatTime(g.entry_time)}</td>
                    <td className="symbol">
                      {g.underlying_symbol} <span className="muted">({g.segment})</span>
                    </td>
                    <td>{signalLabel(g, strategyNames)}</td>
                    <td>{g.strategy_type}</td>
                    <td className="num">{g.quantity ?? "-"}</td>
                    <td className="num">{groupValue(g)?.toFixed(2) ?? "-"}</td>
                    <td>{g.exit_time ? formatTime(g.exit_time) : "-"}</td>
                    <td className={`num ${g.pnl != null ? (g.pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                      {g.pnl != null ? `${g.pnl >= 0 ? "+" : ""}${g.pnl.toFixed(2)}` : "-"}
                      {formatPct(pnlPercent(g.pnl, g.net_debit, g.quantity))}
                    </td>
                    <td title={g.rejection_reason ?? g.exit_reason ?? undefined}>
                      {g.status}
                      {g.exit_reason && <span className="muted"> ({g.exit_reason.replace("_", " ")})</span>}
                    </td>
                  </tr>
                  {expanded && hasLegs && (
                    <tr className="legs-row">
                      <td colSpan={10}>
                        <div className="legs-detail">
                          <table className="legs-table">
                            <thead>
                              <tr>
                                <th>Leg</th>
                                <th>Symbol</th>
                                <th>Entry</th>
                                <th>Exit</th>
                                <th>P&amp;L</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.legs.map((leg) => (
                                <tr key={leg.id}>
                                  <td>
                                    <span className={`badge ${leg.action === "BUY" ? "badge-buy" : "badge-sell"}`}>{leg.action}</span>
                                  </td>
                                  <td className="symbol">{leg.symbol}</td>
                                  <td className="num">{leg.entry_price.toFixed(2)}</td>
                                  <td className="num">{leg.exit_price != null ? leg.exit_price.toFixed(2) : "-"}</td>
                                  <td className={`num ${leg.pnl != null ? (leg.pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                                    {leg.pnl != null ? `${leg.pnl >= 0 ? "+" : ""}${leg.pnl.toFixed(2)}` : "-"}
                                  </td>
                                  <td>{leg.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="legs-detail-footer">
                            <span>
                              Exit combined px: <strong>{combinedExitPrice(g)?.toFixed(2) ?? "-"}</strong>
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </main>
  );
}

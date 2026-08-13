import { useEffect, useRef, useState } from "react";

import {
  type OptionPositionStyle,
  type OptionStrikeMoneyness,
  type Segment,
  createManualPosition,
  defaultSquareOffTime,
  fetchExecPositions,
  fetchLtp,
  fetchOptionGroups,
  findOrCreateManualStrategy,
  sendManualSignal,
  squareOffManualPosition,
  squareOffOptionGroup,
  updateOptionStopLoss,
  updateStopLoss,
  updateStrategy,
} from "./api";

const POLL_INTERVAL_MS = 5000;
const STORAGE_KEY = "manual-tab-rows-v1";

type InstrumentType = "spot" | "future" | "option";

// A row's live blotter is a list of these, not a single slot - "add
// again" (pyramid) while one's already open is just placing another.
type OrderInstance = {
  id: string;
  state: "pending" | "open";
  triggerPrice?: number;
  startedAboveTarget?: boolean; // recorded once, at pending-creation time
  quantity?: number; // as typed - undefined means auto-sized
  stopLossDraft: string;
  positionId?: string;
  groupId?: string;
  signalId?: string;
  entryPrice?: number;
  livePrice?: number;
  unrealizedPnl?: number;
  quantityLive?: number;
  stopLossPrice?: number | null;
  error?: string;
};

// Normalized shape for the "Previous trades" table - built either from a
// full position/group record (poll-detected close) or straight from a
// square-off response (button-initiated close), see handleSquareOff.
type HistoryEntry = {
  id: string;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  pnl: number | null;
  exit_reason: string | null;
  exit_time: string | null;
};

type ManualRow = {
  id: string;
  segment: Segment;
  instrumentType: InstrumentType;
  symbol: string;
  action: "BUY" | "SELL";
  optionStyle: OptionPositionStyle;
  moneyness: OptionStrikeMoneyness;
  draftQuantity: string;
  draftTriggerPrice: string;
  draftStopLoss: string;
  lastKnownLtp?: number;
  orders: OrderInstance[];
  history: HistoryEntry[];
  rowError?: string;
};

function newRow(): ManualRow {
  return {
    id: crypto.randomUUID(),
    segment: "CRYPTO",
    instrumentType: "spot",
    symbol: "",
    action: "BUY",
    optionStyle: "spread",
    moneyness: "ATM",
    draftQuantity: "",
    draftTriggerPrice: "",
    draftStopLoss: "",
    orders: [],
    history: [],
  };
}

// history/rowError/lastKnownLtp aren't persisted - always start fresh on
// reload (history is re-derivable as trades close during the session;
// persisting it indefinitely could grow unbounded).
function loadRows(): ManualRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ManualRow[];
    return parsed.map((r) => ({ ...r, history: [], rowError: undefined, lastKnownLtp: undefined }));
  } catch {
    return [];
  }
}

function saveRows(rows: ManualRow[]) {
  const persisted = rows.map(({ history, rowError, lastKnownLtp, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function fmt(n: number | null | undefined, digits = 2): string {
  return n == null ? "-" : n.toFixed(digits);
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 0 ? "pnl-positive" : "pnl-negative";
}

export default function ManualTab() {
  const [rows, setRows] = useState<ManualRow[]>(() => loadRows());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    saveRows(rows);
  }, [rows]);

  function updateRow(id: string, patch: Partial<ManualRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addOrderInstance(rowId: string, instance: OrderInstance) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, orders: [...r.orders, instance] } : r)));
  }

  function updateOrderInstance(rowId: string, instanceId: string, patch: Partial<OrderInstance>) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId ? { ...r, orders: r.orders.map((o) => (o.id === instanceId ? { ...o, ...patch } : o)) } : r,
      ),
    );
  }

  function moveInstanceToHistory(rowId: string, instanceId: string, entry: HistoryEntry) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId
          ? { ...r, orders: r.orders.filter((o) => o.id !== instanceId), history: [entry, ...r.history] }
          : r,
      ),
    );
  }

  async function placeOrder(row: ManualRow) {
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) return;
    const quantity = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    const triggerPrice = row.draftTriggerPrice ? Number(row.draftTriggerPrice) : undefined;
    const stopLoss = row.draftStopLoss ? Number(row.draftStopLoss) : undefined;

    // "reset that instrument row for next manual initiation" - clear the
    // per-order draft fields, keep segment/instrument/symbol/style as-is.
    updateRow(row.id, { draftTriggerPrice: "", draftStopLoss: "", rowError: undefined });

    if (triggerPrice === undefined) {
      const instanceId = crypto.randomUUID();
      addOrderInstance(row.id, { id: instanceId, state: "pending", quantity, stopLossDraft: stopLoss != null ? String(stopLoss) : "" });
      await executeOrder(row, symbol, instanceId, quantity, undefined, stopLoss);
      return;
    }

    let startedAboveTarget = true;
    try {
      const ltp = await fetchLtp(row.segment, symbol);
      startedAboveTarget = ltp >= triggerPrice;
      updateRow(row.id, { lastKnownLtp: ltp });
    } catch {
      // default true - corrected on the very next poll tick regardless
    }

    addOrderInstance(row.id, {
      id: crypto.randomUUID(),
      state: "pending",
      triggerPrice,
      startedAboveTarget,
      quantity,
      stopLossDraft: stopLoss != null ? String(stopLoss) : "",
    });
  }

  async function executeOrder(
    row: ManualRow,
    symbol: string,
    instanceId: string,
    quantity: number | undefined,
    price: number | undefined,
    stopLoss: number | undefined,
  ) {
    try {
      const resolvedPrice = price ?? (await fetchLtp(row.segment, symbol));
      if (row.instrumentType === "option") {
        const strategy = await findOrCreateManualStrategy(row.segment, row.optionStyle, row.moneyness);
        await updateStrategy(strategy.id, { option_fixed_lots: quantity ?? null });
        const result = await sendManualSignal({
          strategy_id: strategy.id,
          symbol,
          exchange: row.segment,
          action: row.action,
          price: resolvedPrice,
        });
        updateOrderInstance(row.id, instanceId, { state: "open", signalId: result.signal_id, entryPrice: resolvedPrice });
      } else {
        const squareOffTime = defaultSquareOffTime("intraday", row.segment) ?? "15:00";
        const created = await createManualPosition({
          segment: row.segment,
          symbol,
          action: row.action,
          instrument_type: row.instrumentType as "spot" | "future",
          price: resolvedPrice,
          quantity,
          stop_loss_price: stopLoss,
          square_off_time: `${squareOffTime}:00`,
        });
        if (created.status === "REJECTED") {
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, orders: r.orders.filter((o) => o.id !== instanceId), rowError: created.rejection_reason ?? "order rejected" } : r)));
          return;
        }
        updateOrderInstance(row.id, instanceId, {
          state: "open",
          positionId: created.id,
          signalId: created.signal_id,
          entryPrice: created.entry_price,
          quantityLive: created.quantity ?? undefined,
          stopLossPrice: created.stop_loss_price,
        });
      }
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, orders: r.orders.filter((o) => o.id !== instanceId), rowError: err instanceof Error ? err.message : "failed to place order" } : r)));
    }
  }

  async function refreshOpenInstance(row: ManualRow, instance: OrderInstance) {
    try {
      if (row.instrumentType === "option") {
        const groups = await fetchOptionGroups({ signalId: instance.signalId, withLivePnl: true });
        const group = groups[0];
        if (!group) return;
        if (group.status === "CLOSED") {
          moveInstanceToHistory(row.id, instance.id, {
            id: group.id,
            entry_price: null,
            exit_price: null,
            quantity: group.quantity,
            pnl: group.pnl,
            exit_reason: group.exit_reason,
            exit_time: null,
          });
        } else {
          updateOrderInstance(row.id, instance.id, {
            groupId: group.id,
            livePrice: group.live_combined_price ?? undefined,
            unrealizedPnl: group.unrealized_pnl ?? undefined,
            quantityLive: group.quantity ?? undefined,
            stopLossPrice: group.combined_stop_loss_price,
          });
        }
      } else {
        const positions = await fetchExecPositions({ signalId: instance.signalId, withLivePnl: true });
        const pos = positions[0];
        if (!pos) return;
        if (pos.status === "CLOSED") {
          moveInstanceToHistory(row.id, instance.id, {
            id: pos.id,
            entry_price: pos.entry_price,
            exit_price: pos.exit_price,
            quantity: pos.quantity,
            pnl: pos.pnl,
            exit_reason: pos.exit_reason,
            exit_time: pos.exit_time,
          });
        } else {
          updateOrderInstance(row.id, instance.id, {
            positionId: pos.id,
            livePrice: pos.live_price ?? undefined,
            unrealizedPnl: pos.unrealized_pnl ?? undefined,
            quantityLive: pos.quantity ?? undefined,
            stopLossPrice: pos.stop_loss_price,
            entryPrice: pos.entry_price,
          });
        }
      }
    } catch {
      // transient - retry next tick
    }
  }

  async function handleSquareOff(row: ManualRow, instance: OrderInstance, quantityToClose?: number) {
    try {
      if (row.instrumentType === "option") {
        const result = await squareOffOptionGroup(instance.groupId ?? "");
        moveInstanceToHistory(row.id, instance.id, {
          id: crypto.randomUUID(),
          entry_price: instance.entryPrice ?? null,
          exit_price: null,
          quantity: instance.quantityLive ?? null,
          pnl: result.pnl,
          exit_reason: "manual",
          exit_time: new Date().toISOString(),
        });
      } else {
        const result = await squareOffManualPosition(instance.positionId ?? "", quantityToClose);
        const entry: HistoryEntry = {
          id: crypto.randomUUID(),
          entry_price: instance.entryPrice ?? null,
          exit_price: result.exit_price,
          quantity: result.closed_quantity,
          pnl: result.pnl,
          exit_reason: "manual",
          exit_time: new Date().toISOString(),
        };
        if (result.remaining_quantity > 0) {
          updateOrderInstance(row.id, instance.id, { quantityLive: result.remaining_quantity });
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, history: [entry, ...r.history] } : r)));
        } else {
          moveInstanceToHistory(row.id, instance.id, entry);
        }
      }
    } catch (err) {
      updateOrderInstance(row.id, instance.id, { error: err instanceof Error ? err.message : "failed to square off" });
    }
  }

  async function handleUpdateSl(row: ManualRow, instance: OrderInstance) {
    const price = Number(instance.stopLossDraft);
    if (!price) return;
    try {
      if (row.instrumentType === "option") {
        await updateOptionStopLoss(instance.groupId ?? "", price);
      } else {
        await updateStopLoss(instance.positionId ?? "", price);
      }
      updateOrderInstance(row.id, instance.id, { stopLossPrice: price, error: undefined });
    } catch (err) {
      updateOrderInstance(row.id, instance.id, { error: err instanceof Error ? err.message : "failed to update stop-loss" });
    }
  }

  // Single global poll loop - pending instances check their trigger,
  // open instances refresh live P&L (and detect a close), idle rows with
  // a symbol typed just refresh the value preview.
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        for (const row of rowsRef.current) {
          const symbol = row.symbol.trim().toUpperCase();
          if (!symbol) continue;

          if (row.orders.length === 0) {
            try {
              const ltp = await fetchLtp(row.segment, symbol);
              updateRow(row.id, { lastKnownLtp: ltp });
            } catch {
              // keep last known value
            }
            continue;
          }

          for (const instance of row.orders) {
            if (instance.state === "pending" && instance.triggerPrice !== undefined) {
              try {
                const ltp = await fetchLtp(row.segment, symbol);
                updateRow(row.id, { lastKnownLtp: ltp });
                const crossed = instance.startedAboveTarget ? ltp <= instance.triggerPrice : ltp >= instance.triggerPrice;
                if (crossed) {
                  await executeOrder(row, symbol, instance.id, instance.quantity, ltp, instance.stopLossDraft ? Number(instance.stopLossDraft) : undefined);
                }
              } catch {
                // keep waiting, retry next tick
              }
            } else if (instance.state === "open") {
              await refreshOpenInstance(row, instance);
            }
          }
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orderValuePreview = (row: ManualRow): string => {
    const qty = row.draftQuantity ? Number(row.draftQuantity) : undefined;
    const price = row.draftTriggerPrice ? Number(row.draftTriggerPrice) : row.lastKnownLtp;
    if (!qty || !price) return "-";
    return (qty * price).toFixed(2);
  };

  return (
    <>
      <section className="panel">
        <h2>Manual trading</h2>
        <p className="hint">
          Opens real paper positions directly against execution - spot/future bypass Strategy entirely; option
          orders (naked/spread) route through a small auto-provisioned "[Manual] ..." Strategy behind the
          scenes (visible, tagged, in the Strategies tab) since strike/expiry selection lives there. Leave
          price blank to fire immediately at the current market price, or set one to wait until the market
          reaches it (fires once price reaches/crosses that level, from either side).
        </p>
        <button type="button" onClick={() => setRows((prev) => [...prev, newRow()])}>
          Add instrument
        </button>
      </section>

      {rows.map((row) => (
        <section className="panel" key={row.id}>
          <div className="strategy-form">
            <label>
              Segment
              <select value={row.segment} onChange={(e) => updateRow(row.id, { segment: e.target.value as Segment })}>
                <option value="NSE">NSE</option>
                <option value="MCX">MCX</option>
                <option value="CRYPTO">CRYPTO</option>
              </select>
            </label>
            <label>
              Instrument
              <select
                value={row.instrumentType}
                onChange={(e) => updateRow(row.id, { instrumentType: e.target.value as InstrumentType })}
              >
                <option value="spot">Spot</option>
                <option value="future">Future</option>
                <option value="option">Option</option>
              </select>
            </label>
            <label>
              Symbol
              <input
                value={row.symbol}
                onChange={(e) => updateRow(row.id, { symbol: e.target.value.toUpperCase() })}
                placeholder="e.g. BTCUSD, TCS"
              />
            </label>
            <label>
              Action
              <select value={row.action} onChange={(e) => updateRow(row.id, { action: e.target.value as "BUY" | "SELL" })}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>
            {row.instrumentType === "option" && (
              <>
                <label>
                  Style
                  <select value={row.optionStyle} onChange={(e) => updateRow(row.id, { optionStyle: e.target.value as OptionPositionStyle })}>
                    <option value="spread">Spread</option>
                    <option value="naked">Naked</option>
                  </select>
                </label>
                <label>
                  Strike
                  <select value={row.moneyness} onChange={(e) => updateRow(row.id, { moneyness: e.target.value as OptionStrikeMoneyness })}>
                    <option value="ITM2">ITM2</option>
                    <option value="ITM1">ITM1</option>
                    <option value="ATM">ATM</option>
                    <option value="OTM1">OTM1</option>
                    <option value="OTM2">OTM2</option>
                  </select>
                </label>
              </>
            )}
            <label>
              {row.instrumentType === "spot" ? "Quantity" : "Lots"} (optional)
              <input
                type="number"
                min="0"
                step="0.01"
                value={row.draftQuantity}
                onChange={(e) => updateRow(row.id, { draftQuantity: e.target.value })}
                placeholder="Auto"
              />
            </label>
            <label>
              Trigger price (optional)
              <input
                type="number"
                min="0"
                step="0.01"
                value={row.draftTriggerPrice}
                onChange={(e) => updateRow(row.id, { draftTriggerPrice: e.target.value })}
                placeholder="Market"
              />
            </label>
            {row.instrumentType !== "option" && (
              <label>
                Stop-loss price (optional)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={row.draftStopLoss}
                  onChange={(e) => updateRow(row.id, { draftStopLoss: e.target.value })}
                  placeholder="None"
                />
              </label>
            )}
            <span className="muted">Order value &#8776; {orderValuePreview(row)}</span>
            <button type="button" onClick={() => placeOrder(row)} disabled={!row.symbol.trim()}>
              Place order
            </button>
            {row.orders.length === 0 && (
              <button type="button" className="secondary" onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}>
                Remove
              </button>
            )}
          </div>
          {row.rowError && <p className="error">{row.rowError}</p>}

          {row.orders.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Qty</th>
                    <th>Entry</th>
                    <th>CMP</th>
                    <th>Unrealized P&amp;L</th>
                    <th>Stop-loss</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {row.orders.map((instance) => (
                    <tr key={instance.id}>
                      <td className="symbol">
                        {instance.state === "pending" ? `Pending @ ${instance.triggerPrice}` : "Open"}
                      </td>
                      <td className="num">{fmt(instance.quantityLive ?? instance.quantity, 4)}</td>
                      <td className="num">{fmt(instance.entryPrice)}</td>
                      <td className="num">{fmt(instance.livePrice)}</td>
                      <td className={`num ${pnlClass(instance.unrealizedPnl)}`}>{fmt(instance.unrealizedPnl)}</td>
                      <td>
                        {instance.state === "open" ? (
                          <>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={instance.stopLossDraft}
                              onChange={(e) => updateOrderInstance(row.id, instance.id, { stopLossDraft: e.target.value })}
                              placeholder={fmt(instance.stopLossPrice)}
                              className="cell-input"
                            />
                            <button type="button" className="tiny secondary" onClick={() => handleUpdateSl(row, instance)}>
                              Set SL
                            </button>
                          </>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        {instance.state === "open" && (
                          <>
                            {row.instrumentType !== "option" && (
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="Qty (blank=all)"
                                className="cell-input"
                                onChange={(e) => updateOrderInstance(row.id, instance.id, { quantity: e.target.value ? Number(e.target.value) : undefined })}
                              />
                            )}
                            <button
                              type="button"
                              className="tiny secondary"
                              onClick={() =>
                                handleSquareOff(
                                  row,
                                  instance,
                                  row.instrumentType !== "option" && instance.quantity ? instance.quantity : undefined,
                                )
                              }
                            >
                              Square off
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {row.orders.some((o) => o.error) && (
                <p className="error">{row.orders.find((o) => o.error)?.error}</p>
              )}
            </div>
          )}

          {row.history.length > 0 && (
            <details>
              <summary>Previous trades ({row.history.length})</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&amp;L</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.history.map((h) => (
                      <tr key={h.id}>
                        <td className="num">{fmt(h.quantity, 4)}</td>
                        <td className="num">{fmt(h.entry_price)}</td>
                        <td className="num">{fmt(h.exit_price)}</td>
                        <td className={`num ${pnlClass(h.pnl)}`}>{fmt(h.pnl)}</td>
                        <td>{h.exit_reason ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      ))}
    </>
  );
}

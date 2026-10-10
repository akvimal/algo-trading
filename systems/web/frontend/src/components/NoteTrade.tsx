import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { placePlanTrade, type NoteTrade as NoteTradeState } from "../api/planTrade";
import { cancelWaitingOrder, getLtp } from "../api/trade";
import type { StudyNote } from "../api/types";
import { formatPrice } from "../format";
import { EMPTY_PLAN, buildPlanOrder, canTradePlan, planProblem, planRewardRisk, tradeStatusText, type PlanForm } from "./planTradeModel";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** "Trade this plan" under a plan note: turn what you wrote into a paper trade on your positional account (long, spot, a Market or Limit
 * entry with a stop-loss and a target, sized by risk), and see where it stands on the note afterwards. Once there is a trade the note shows
 * its status instead: waiting for its price, open, or closed with how it ended in R. */
export function NoteTrade({ note, trade, onChanged }: { note: StudyNote; trade: NoteTradeState | undefined; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN);
  const [ltp, setLtp] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // The live price is read when the form opens, and used for a Market entry and for the stop/target checks.
  useEffect(() => {
    if (!open) return;
    let live = true;
    getLtp(note.segment, note.symbol)
      .then((q) => live && setLtp(q.ltp))
      .catch(() => live && setLtp(null));
    return () => {
      live = false;
    };
  }, [open, note.segment, note.symbol]);

  if (!canTradePlan(note)) return null;

  const set = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  // A trade that is waiting, open or closed is shown as a status. An ended order can be armed again.
  if (trade && trade.state !== "ended") {
    const pos = trade.position;
    return (
      <div className="stack" data-testid="note-trade-status">
        <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <span className={`pill ${trade.state === "closed" && (trade.r_multiple ?? 0) < 0 ? "dn" : "up"}`}>{tradeStatusText(trade, formatPrice)}</span>
          {trade.state === "waiting" && trade.order && (
            <span className="faint">
              stop {trade.order.stop_loss_price != null ? formatPrice(trade.order.stop_loss_price) : "none"}
              {trade.order.target_price != null ? ` · target ${formatPrice(trade.order.target_price)}` : ""}
            </span>
          )}
          {(trade.state === "open" || trade.state === "closed") && pos && (
            <span className="faint">
              {pos.quantity != null ? `${pos.quantity} @ ${pos.entry_price != null ? formatPrice(pos.entry_price) : "?"}` : ""}
              {pos.stop_loss_price != null ? ` · stop ${formatPrice(pos.stop_loss_price)}` : ""}
              {pos.target_price != null ? ` · target ${formatPrice(pos.target_price)}` : ""}
            </span>
          )}
          {trade.state === "waiting" && trade.order && (
            <button
              className="btn btn-small"
              disabled={busy}
              onClick={async () => {
                if (!confirmCancel) {
                  setConfirmCancel(true);
                  window.setTimeout(() => setConfirmCancel(false), 4000);
                  return;
                }
                setBusy(true);
                try {
                  await cancelWaitingOrder(trade.order!.id);
                  onChanged();
                } catch (e) {
                  setError(message(e, "Could not cancel the order."));
                } finally {
                  setBusy(false);
                  setConfirmCancel(false);
                }
              }}
            >
              {confirmCancel ? "Cancel the order?" : "Cancel order"}
            </button>
          )}
          {trade.state === "open" && (
            <Link className="link-btn" to="/portfolio" title="Manage the position: move the stop or target, add a note, square off">
              Manage
            </Link>
          )}
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
      </div>
    );
  }

  const problem = planProblem(form, ltp);
  const rr = planRewardRisk(form, ltp);

  async function place() {
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await placePlanTrade(buildPlanOrder(note, form, ltp));
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDone(result.message);
      setOpen(false);
      setForm(EMPTY_PLAN);
      onChanged();
    } catch (e) {
      setError(message(e, "Could not place the trade. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="stack">
        {trade?.state === "ended" && trade.order && <span className="faint">Last order {trade.order.status}{trade.order.status_reason ? `: ${trade.order.status_reason}` : ""}</span>}
        {done && <div className="notice" role="status">{done}</div>}
        <button className="btn btn-small" style={{ alignSelf: "flex-start" }} onClick={() => { setOpen(true); setDone(null); setError(null); }}>
          Trade this plan
        </button>
      </div>
    );
  }

  return (
    <div className="card stack" data-testid="note-trade-form">
      <strong>Trade this plan</strong>
      <span className="faint" style={{ fontSize: 12 }}>
        Buys {note.symbol} on your positional account (paper money, a multi-day hold that is never closed at the end of the day), sized by how far the stop is.
      </span>
      <div className="chips" role="group" aria-label="Entry">
        <button aria-pressed={form.entryType === "market"} onClick={() => set("entryType", "market")}>Market</button>
        <button aria-pressed={form.entryType === "limit"} onClick={() => set("entryType", "limit")}>Limit</button>
      </div>
      <span className="faint" style={{ fontSize: 12 }}>Live price {ltp != null ? formatPrice(ltp) : "…"}</span>
      {form.entryType === "limit" && (
        <label className="field">
          <span>Buy when the price reaches</span>
          <input inputMode="decimal" aria-label="Limit price" value={form.limitPrice} onChange={(e) => set("limitPrice", e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Stop-loss</span>
        <input inputMode="decimal" aria-label="Stop-loss" value={form.stop} onChange={(e) => set("stop", e.target.value)} />
      </label>
      <label className="field">
        <span>Target (optional)</span>
        <input inputMode="decimal" aria-label="Target" value={form.target} onChange={(e) => set("target", e.target.value)} />
      </label>
      <label className="field">
        <span>Quantity (blank = sized by risk)</span>
        <input inputMode="decimal" aria-label="Quantity" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
      </label>
      {form.entryType === "limit" && (
        <label className="field">
          <span>Keep the order for</span>
          <select aria-label="Keep the order for" value={form.days} onChange={(e) => set("days", Number(e.target.value) as PlanForm["days"])}>
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
          </select>
        </label>
      )}
      {rr != null && <span className="faint" style={{ fontSize: 12 }}>Reward : risk {rr.toFixed(1)} : 1</span>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-primary btn-small" disabled={busy || problem !== null} title={problem ?? undefined} onClick={() => void place()}>
          {busy ? "Placing…" : form.entryType === "market" ? "Buy now" : "Arm the order"}
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

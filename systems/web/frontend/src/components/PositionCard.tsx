import { useState } from "react";
import { api, ApiError } from "../api/http";
import type { OptionGroup, Position } from "../api/types";
import { formatPnl, formatPrice, formatTime } from "../format";
import { Signed } from "./bits";

type Props =
  | { kind: "position"; item: Position; onChanged: () => void }
  | { kind: "group"; item: OptionGroup; onChanged: () => void };

/** One open trade. Squaring off is a deliberate two-step (tap, then confirm in place): an
 * accidental tap on a phone must not close a position, and a browser confirm() dialog is
 * both ugly and blocked in installed PWAs on some platforms. */
export function PositionCard(props: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPos = props.kind === "position";
  const { item } = props;
  const p = props.kind === "position" ? props.item : null;
  const g = props.kind === "group" ? props.item : null;
  const title = p ? p.symbol : g!.underlying_symbol;
  const side = item.action;
  const pnl = item.unrealized_pnl ?? null;
  const detail = p
    ? `${p.instrument_type} · qty ${p.quantity} @ ${formatPrice(p.entry_price)}`
    : `${g!.strategy_type.replace(/_/g, " ")} · lots ${g!.quantity}`;
  const stop = p ? p.stop_loss_price : (g!.spot_stop_loss_price ?? g!.combined_stop_loss_price);
  const target = p ? p.target_price : g!.spot_target_price;

  async function squareOff() {
    setBusy(true);
    setError(null);
    try {
      const path = isPos ? `/positions/${item.id}/square-off` : `/option-groups/${item.id}/square-off`;
      await api("execution", path, { method: "POST" });
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not square off");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pos" data-testid="position-card">
      <div className="pos-head">
        <strong>
          {title} <span className={`pill ${side === "BUY" ? "up" : "dn"}`}>{side}</span>
        </strong>
        <Signed value={pnl} text={pnl == null ? "–" : formatPnl(pnl)} />
      </div>
      <div className="pos-sub">
        <span>{detail}</span>
        <span>since {formatTime(item.entry_time)}</span>
      </div>
      <div className="pos-sub">
        <span>SL {stop == null ? "not set" : formatPrice(stop)}</span>
        <span>Target {target == null ? "not set" : formatPrice(target)}</span>
      </div>
      {error && <div className="dn" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {confirming ? (
          <>
            <button className="btn btn-small" disabled={busy} onClick={() => setConfirming(false)}>
              Keep open
            </button>
            <button className="btn btn-small btn-danger" disabled={busy} onClick={squareOff}>
              {busy ? "Closing…" : "Confirm square off"}
            </button>
          </>
        ) : (
          <button className="btn btn-small" onClick={() => setConfirming(true)}>
            Square off
          </button>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { api, ApiError } from "../api/http";
import { moveOpenLevel } from "../api/trade";
import type { OptionGroup, Position } from "../api/types";
import { formatPct, formatPnl, formatPrice, formatTime } from "../format";
import { ScanChartPanel } from "../pages/ScanChartPanel";
import { isNakedOption, isSpreadOption, nakedMetrics, spreadMetrics } from "./positionMetrics";
import { Signed } from "./bits";

type Field = "stop" | "target";

/** Chart help for an open trade's stop/target, offered when the card sits next to a chart (the trade
 * ticket): put a starting line on the chart, or arm the chart so the next click sets the price. */
type ChartHelp = { pickingField: Field | null; onAddLine: (field: Field) => void; onPick: (field: Field | null) => void };

type Props =
  | { kind: "position"; item: Position; onChanged: () => void; compact?: boolean; chart?: ChartHelp }
  | { kind: "group"; item: OptionGroup; onChanged: () => void; compact?: boolean; chart?: ChartHelp };

/** One open trade: what it is, its P&L, and its stop/target - either as plain text or, tapped, a
 * small inline editor (moveOpenLevel, the same route a chart-line drag already uses). An option
 * group also gets a second economics line - naked shows % move of the underlying and of the
 * option's own premium since entry; a spread shows how far its live P&L is toward its own defined
 * max profit, and against the capital actually committed to it (see positionMetrics.ts) - and a
 * "Chart" toggle (option groups only - a spot/future row has no strike/expiry decision riding on
 * the underlying's own shape) that drops in ScanChartPanel inline, so squaring off is an informed
 * decision rather than a guess from the P&L number alone. Squaring off is a deliberate two-step
 * (tap, then confirm in place): an accidental tap on a phone must not close a position, and a
 * browser confirm() dialog is both ugly and blocked in installed PWAs on some platforms. `compact`
 * trims it to fit a narrow sidebar (the trade ticket) - same information,
 * tighter spacing, no entry-time line. */
export function PositionCard(props: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Field | null>(null);
  const [draft, setDraft] = useState("");
  const [chartOpen, setChartOpen] = useState(false);

  const isPos = props.kind === "position";
  const { item, compact } = props;
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
  const stopTrailing = (p ? p.trailing_stop_enabled : g!.spot_stop_loss_trailing_enabled) === true;
  // Naked: % move of the underlying and of the option's own premium, since entry. Spread: how far
  // the live P&L is toward the position's own defined max profit, and against the capital
  // actually committed to it - see positionMetrics.ts for the debit/credit math either needs.
  const naked = g && isNakedOption(g.strategy_type) ? nakedMetrics(g) : null;
  const spread = g && isSpreadOption(g.strategy_type) ? spreadMetrics(g) : null;
  const pctText = (v: number | null) => (v == null ? "–" : formatPct(v, 1, true));

  async function squareOff() {
    setBusy(true);
    setError(null);
    try {
      const path = isPos ? `/positions/${item.id}/square-off` : `/option-groups/${item.id}/square-off`;
      await api("execution", path, { method: "POST" });
      // Stay disabled/"Closing…" on success - props.onChanged() reloads the parent's list, which
      // is what actually makes this card go away (it's now CLOSED). Flipping busy back to false
      // here would re-enable "Confirm square off" for the moment before that reload lands,
      // wrongly suggesting the close hadn't taken.
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not square off");
      setConfirming(false);
      setBusy(false);
    }
  }

  function startEdit(field: Field, current: number | null) {
    setEditing(field);
    setDraft(current != null ? String(current) : "");
    setError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const price = Number(draft);
    if (!draft.trim() || !Number.isFinite(price) || price <= 0) {
      setError("Enter a valid price.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await moveOpenLevel({ kind: props.kind, field: editing, tradeId: item.id }, price);
      setEditing(null);
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not move it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function level(field: Field, value: number | null) {
    const label = field === "stop" ? "SL" : "Target";
    const trailing = field === "stop" && stopTrailing;
    if (editing === field) {
      return (
        <span className="pos-level-edit" key={field}>
          <label className="sr-only" htmlFor={`pos-${item.id}-${field}`}>
            {label}
          </label>
          <input
            id={`pos-${item.id}-${field}`}
            className="pos-level-input"
            inputMode="decimal"
            value={draft}
            disabled={busy}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveEdit();
              if (e.key === "Escape") setEditing(null);
            }}
          />
          <button className="icon-btn" aria-label={`Save ${label.toLowerCase()}`} disabled={busy} onClick={() => void saveEdit()}>
            ✓
          </button>
          <button className="icon-btn" aria-label={`Cancel editing ${label.toLowerCase()}`} disabled={busy} onClick={() => setEditing(null)}>
            ✕
          </button>
        </span>
      );
    }
    const help = props.chart && !trailing ? props.chart : null;
    return (
      <span className="pos-level-group" key={field}>
        <button
          type="button"
          className="link-btn pos-level"
          disabled={trailing}
          aria-label={`Edit ${label.toLowerCase()}`}
          title={trailing ? "Trailing stop - cannot be edited by hand" : `Edit ${label.toLowerCase()}`}
          onClick={() => startEdit(field, value)}
        >
          {label} {value == null ? "not set" : formatPrice(value)}
          {trailing ? " (trailing)" : ""}
        </button>
        {help && value == null && (
          <button type="button" className="link-btn" aria-label={`Add ${field} line`} title="Put a starting line on the chart and save it - then drag it where you want it" onClick={() => help.onAddLine(field)}>
            Add line
          </button>
        )}
        {help && (
          <button type="button" className="link-btn" aria-label={`Pick ${field} on chart`} aria-pressed={help.pickingField === field} onClick={() => help.onPick(help.pickingField === field ? null : field)}>
            {help.pickingField === field ? "Click the chart…" : "Pick on chart"}
          </button>
        )}
      </span>
    );
  }

  return (
    <div className={`card pos ${compact ? "pos-compact" : ""}`} data-testid="position-card">
      <div className="pos-head">
        <strong>
          {title} <span className={`pill ${side === "BUY" ? "up" : "dn"}`}>{side}</span>
        </strong>
        <Signed value={pnl} text={pnl == null ? "–" : formatPnl(pnl)} />
      </div>
      <div className="pos-sub">
        <span>{detail}</span>
        {!compact && <span>since {formatTime(item.entry_time)}</span>}
      </div>
      {naked && (
        <div className="pos-sub" data-testid="pos-option-metrics">
          <span>
            Spot <Signed value={naked.spotPct} text={pctText(naked.spotPct)} />
          </span>
          <span>
            Premium <Signed value={naked.premiumPct} text={pctText(naked.premiumPct)} />
          </span>
        </div>
      )}
      {spread && (
        <div className="pos-sub" data-testid="pos-option-metrics">
          <span>
            Max profit <Signed value={spread.maxProfitPct} text={pctText(spread.maxProfitPct)} />
          </span>
          <span>
            Fund used <Signed value={spread.fundUsedPct} text={pctText(spread.fundUsedPct)} />
          </span>
        </div>
      )}
      <div className="pos-sub">
        {level("stop", stop)}
        {level("target", target)}
      </div>
      {error && (
        <div className="dn" role="alert">
          {error}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {/* Option positions only, per the card's own docstring - a spot/future row has no strike/
            expiry decision riding on the underlying's shape the way an option position does. */}
        {g && (
          <button className="btn btn-small" aria-pressed={chartOpen} onClick={() => setChartOpen((v) => !v)}>
            {chartOpen ? "Hide chart" : "Chart"}
          </button>
        )}
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
      {chartOpen && g && (
        <div style={{ marginTop: 12 }}>
          <ScanChartPanel exchange={g.segment ?? "NSE"} symbol={g.underlying_symbol} />
        </div>
      )}
    </div>
  );
}

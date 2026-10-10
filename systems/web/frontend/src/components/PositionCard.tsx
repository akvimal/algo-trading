import { useEffect, useState } from "react";
import { api, ApiError } from "../api/http";
import { listTradeEvents, moveOpenLevel, setAutoTrail, squareOffPosition, type TradeEvent } from "../api/trade";
import type { OptionGroup, Position } from "../api/types";
import { formatPct, formatPnl, formatPrice, formatTime } from "../format";
import { ScanChartPanel } from "../pages/ScanChartPanel";
import { isNakedOption, isSpreadOption, nakedMetrics, spreadMetrics } from "./positionMetrics";
import { CrosshairIcon, SparkIcon } from "../chart/icons";
import { Signed } from "./bits";
import { TradeSnapshots } from "./TradeSnapshots";
import type { PictureLevels } from "../chart/tradePicture";

type Field = "stop" | "target";

/** Chart help for an open trade's stop/target, offered when the card sits next to a chart (the trade
 * ticket): put a starting line on the chart, or arm the chart so the next click sets the price. */
type ChartHelp = { pickingField: Field | null; onAddLine: (field: Field) => void; onPick: (field: Field | null) => void };

/** Takes a picture of the chart as it is on screen now, as a finished PNG with its header, these levels and this caption (or null when it cannot).
 * Offered where a chart is open for this instrument (the Trade page); elsewhere the Snapshots view only lists and shows what was saved. */
export type SnapshotCapture = (label: string, levels: PictureLevels, caption: string) => Promise<string | null>;

type Props =
  | { kind: "position"; item: Position; onChanged: () => void; compact?: boolean; chart?: ChartHelp; interval?: string; snapshotCapture?: SnapshotCapture }
  | { kind: "group"; item: OptionGroup; onChanged: () => void; compact?: boolean; chart?: ChartHelp; interval?: string; snapshotCapture?: SnapshotCapture };

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
  const [why, setWhy] = useState(""); // optional reason for a stop/target move
  const [exitNote, setExitNote] = useState(""); // optional reason for getting out
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [events, setEvents] = useState<TradeEvent[] | null>(null);

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
  // The one-tap auto-trail (breakeven at +1R, then an ATR trail) is the one kind of trailing the person switches on and off
  // here; any other kind (a strategy's own SuperTrend, say) is shown as trailing and left alone.
  const autoTrail = stopTrailing && (p ? p.stop_loss_method === "atr_trail" : g!.spot_stop_loss_indicator_type === "atr_trail");
  const canAutoTrail = stop != null && (!stopTrailing || autoTrail);
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
      if (isPos) await squareOffPosition(item.id, exitNote);
      else await api("execution", `/option-groups/${item.id}/square-off`, { method: "POST" });
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

  async function toggleAutoTrail() {
    setBusy(true);
    setError(null);
    try {
      await setAutoTrail(props.kind, item.id, !autoTrail, props.interval);
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not change the auto-trail. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(field: Field, current: number | null) {
    setEditing(field);
    setWhy("");
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
      await moveOpenLevel({ kind: props.kind, field: editing, tradeId: item.id }, price, undefined, why);
      setEditing(null);
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not move it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // The trade's timeline of stop/target moves, fetched when it is opened (spot/future only: an option group keeps none).
  useEffect(() => {
    if (!historyOpen || !isPos) return;
    let live = true;
    setEvents(null);
    listTradeEvents(item.id)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [historyOpen, isPos, item.id, stop, target]);

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
          {isPos && (
            <input
              className="pos-level-input"
              style={{ width: 150 }}
              placeholder="Why? (optional)"
              aria-label={`Why are you moving the ${label.toLowerCase()}? (optional)`}
              maxLength={500}
              value={why}
              disabled={busy}
              onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveEdit();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          )}
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
          title={trailing ? (autoTrail ? "Auto-trail is on - switch it off to move the stop by hand" : "Trailing stop - cannot be edited by hand") : `Edit ${label.toLowerCase()}`}
          onClick={() => startEdit(field, value)}
        >
          {label} {value == null ? "not set" : formatPrice(value)}
          {trailing ? (autoTrail ? " (auto-trail)" : " (trailing)") : ""}
        </button>
        {help && value == null && (
          <button type="button" className="link-btn with-icon" aria-label={`Add ${field} line`} title="Suggest a price from the chart's typical move, save it and put its line on the chart - then drag it where you want it" onClick={() => help.onAddLine(field)}>
            <SparkIcon />
            Suggest
          </button>
        )}
        {help && (
          <button type="button" className="link-btn with-icon" aria-label={`Pick ${field} on chart`} title="Click the chart to set it there" aria-pressed={help.pickingField === field} onClick={() => help.onPick(help.pickingField === field ? null : field)}>
            <CrosshairIcon />
            {help.pickingField === field ? "Click chart…" : "Pick"}
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
      {canAutoTrail && (
        <div className="pos-sub">
          <button
            type="button"
            className="link-btn"
            aria-pressed={autoTrail}
            disabled={busy}
            title={
              autoTrail
                ? "On: the stop moves to breakeven at +1R, then trails behind price by an ATR multiple. Click to switch it off."
                : "Off. Switch on to let the stop move to breakeven at +1R and then trail behind price by an ATR multiple, so you do not trail it by hand."
            }
            onClick={() => void toggleAutoTrail()}
          >
            Auto-trail {autoTrail ? "on" : "off"}
          </button>
        </div>
      )}
      {error && (
        <div className="dn" role="alert">
          {error}
        </div>
      )}
      {confirming && isPos && (
        <input
          className="pos-level-input"
          style={{ width: "100%" }}
          placeholder="Why are you getting out? (optional)"
          aria-label="Why are you getting out? (optional)"
          maxLength={500}
          value={exitNote}
          disabled={busy}
          onChange={(e) => setExitNote(e.target.value)}
        />
      )}
      {historyOpen && isPos && (
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }} data-testid="trade-history">
          {events === null && <li className="faint">Loading…</li>}
          {events !== null && events.length === 0 && <li className="faint">No stop or target moves yet.</li>}
          {events?.map((e) => (
            <li key={e.id}>
              <span className="dim">{formatTime(e.created_at)}</span> {e.field === "stop_loss" ? "SL" : "Target"}{" "}
              {e.old_price != null ? formatPrice(e.old_price) : "none"} → {e.new_price != null ? formatPrice(e.new_price) : "none"}
              {!e.accepted && <span className="dn"> (refused)</span>}
              {e.source !== "user" && <span className="faint"> · {e.source.replace("_", "-")}</span>}
              {e.note && <div className="faint">"{e.note}"</div>}
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {isPos && (
          <button className="btn btn-small" aria-pressed={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
            {historyOpen ? "Hide history" : "History"}
          </button>
        )}
        <button className="btn btn-small" aria-pressed={snapshotsOpen} onClick={() => setSnapshotsOpen((v) => !v)} title="The chart saved with this trade: the plan at entry and every update">
          {snapshotsOpen ? "Hide snapshots" : "Snapshots"}
        </button>
        {/* Option positions only, per the card's own docstring - a spot/future row has no strike/
            expiry decision riding on the underlying's shape the way an option position does. */}
        {g && !props.chart && (
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
      {snapshotsOpen && (
        <TradeSnapshots
          trade={{ kind: props.kind, id: item.id }}
          symbol={title}
          segment={p ? p.segment : (g!.segment ?? "NSE")}
          levels={() => ({ entry: p ? p.entry_price : (g!.entry_spot_price ?? null), stop: p ? p.stop_loss_price : g!.spot_stop_loss_price, target: p ? p.target_price : g!.spot_target_price })}
          capture={props.snapshotCapture}
        />
      )}
      {chartOpen && g && !props.chart && (
        <div style={{ marginTop: 12 }}>
          <ScanChartPanel exchange={g.segment ?? "NSE"} symbol={g.underlying_symbol} />
        </div>
      )}
    </div>
  );
}

import { useState, type ReactNode } from "react";
import type { EntryContext, OptionGroup, Position } from "../api/types";
import { formatPnl, formatPrice, formatTime } from "../format";
import { TicketStep } from "./TradeTicket";

const STATE_WORD: Record<string, string> = { trending_up: "Trending up", trending_down: "Trending down", ranging: "Ranging", transitional: "Changing" };

type Trade = { setup: string | null; confidence: number | null; notes: string | null; context: EntryContext | null; enteredAt: string };
const tradeOf = (x: Position | OptionGroup): Trade => ({
  setup: x.setup_tag ?? null, confidence: x.confidence ?? null, notes: x.notes ?? null, context: x.entry_context ?? null, enteredAt: x.entry_time,
});

/** What the order-time read said, in words: followed the system, or overrode it. */
export function readLine(c: EntryContext | null): string {
  if (!c || (!c.regime && !c.person_read)) return "The read of the market was not recorded for this trade.";
  const system = c.regime ? `${STATE_WORD[c.regime] ?? c.regime}${typeof c.adx === "number" ? ` (ADX ${Math.round(c.adx)})` : ""}` : null;
  if (c.overridden && c.person_read) return `System read: ${system}. You overrode it: ${STATE_WORD[c.person_read] ?? c.person_read}.`;
  return system ? `System read: ${system}. You followed it.` : `Your read: ${STATE_WORD[c.person_read ?? ""] ?? c.person_read}.`;
}

/** Planned reward-to-risk from the levels on a spot or futures position; null without both, or without room between entry and stop. */
export function plannedRR(p: Pick<Position, "entry_price" | "stop_loss_price" | "target_price">): number | null {
  if (p.stop_loss_price == null || p.target_price == null) return null;
  const risk = Math.abs(p.entry_price - p.stop_loss_price);
  return risk > 0 ? Math.abs(p.target_price - p.entry_price) / risk : null;
}

function planLines(positions: Position[], groups: OptionGroup[]): string[] {
  const out: string[] = [];
  for (const p of positions) {
    const rr = plannedRR(p);
    out.push(
      `${p.action === "BUY" ? "Bought" : "Sold"} ${p.quantity} ${p.symbol} at ${formatPrice(p.entry_price)} · stop ${p.stop_loss_price == null ? "not set" : formatPrice(p.stop_loss_price)} · target ${p.target_price == null ? "not set" : formatPrice(p.target_price)}${rr != null ? ` · ${rr.toFixed(1)} : 1` : ""}`,
    );
  }
  for (const g of groups) {
    const stop = g.spot_stop_loss_price ?? g.combined_stop_loss_price;
    out.push(`${g.strategy_type.replace(/_/g, " ")} on ${g.underlying_symbol}, ${g.quantity} lot${g.quantity === 1 ? "" : "s"} · stop ${stop == null ? "not set" : formatPrice(stop)} · target ${g.spot_target_price == null ? "not set" : formatPrice(g.spot_target_price)}`);
  }
  return out;
}

/** After an order is placed: the same three parts as the ticket, so the trade keeps its shape. Study and Plan show what was recorded at entry (read-only);
 * Trade holds the open position(s), where they are managed. No second order from here: that is the ticket's rule while one is open. */
export function TradeStages({ positions, groups, children }: { positions: Position[]; groups: OptionGroup[]; children: ReactNode }) {
  const [step, setStep] = useState<1 | 2 | null>(null); // one of Study / Plan at a time on a phone; Trade is always open
  const all = [...positions, ...groups];
  const latest = [...all].sort((a, b) => b.entry_time.localeCompare(a.entry_time))[0];
  const trade = latest ? tradeOf(latest) : null;
  const count = all.length;
  const open = [...positions, ...groups].reduce((n, x) => n + (x.unrealized_pnl ?? 0), 0);
  const lines = planLines(positions, groups);
  const stopSet = positions.every((p) => p.stop_loss_price != null) && groups.every((g) => (g.spot_stop_loss_price ?? g.combined_stop_loss_price) != null);

  return (
    <div className="card ticket" data-testid="ticket-stages">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>Paper order</h2>
        <span className="pill">Paper</span>
      </div>

      <TicketStep n={1} title="Study" summary={[trade?.setup ?? "No setup noted", trade?.confidence != null ? `${trade.confidence}/5` : null].filter(Boolean).join(" · ")} tone={trade?.setup ? "good" : "na"} open={step === 1} onToggle={() => setStep(step === 1 ? null : 1)} testId="step-study">
        <div className="stack" style={{ gap: 6 }} data-testid="study-recorded">
          <p style={{ margin: 0 }}>{readLine(trade?.context ?? null)}</p>
          {trade?.setup && <p style={{ margin: 0 }}>Setup: <strong>{trade.setup}</strong>{trade.confidence != null ? ` · confidence ${trade.confidence} of 5` : ""}</p>}
          {trade?.notes && <p className="dim" style={{ margin: 0, fontSize: 13 }}>{trade.notes}</p>}
          {count > 1 && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Showing the latest of {count} open trades.</p>}
        </div>
      </TicketStep>

      <TicketStep n={2} title="Plan" summary={lines.length ? `${count} open · stop ${stopSet ? "set" : "missing"}` : "No plan recorded"} tone={stopSet ? "good" : "warn"} open={step === 2} onToggle={() => setStep(step === 2 ? null : 2)} testId="step-plan">
        <div className="stack" style={{ gap: 6 }} data-testid="plan-recorded">
          {lines.map((l) => <p key={l} style={{ margin: 0 }}>{l}</p>)}
          {trade && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Entered {formatTime(trade.enteredAt)}. Move the stop or target on the position below.</p>}
        </div>
      </TicketStep>

      <TicketStep n={3} title="Trade" summary={`${count} open · ${formatPnl(open)}`} tone={open >= 0 ? "good" : "warn"} open onToggle={() => undefined} testId="step-trade">
        <h3 className="section-title" style={{ margin: "0 0 2px", fontSize: 14 }}>Open positions</h3>
        <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }} data-testid="no-second-order">
          To add to it, close it first or let its stop or target do it.
        </p>
        {children}
      </TicketStep>
    </div>
  );
}

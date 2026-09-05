import { useEffect, useState } from "react";

import ManualCalendarFilter from "./ManualCalendarFilter";
import { breakdown, BreakdownTable } from "./statsBreakdown";
import TradeImageThumb from "./TradeImageThumb";
import {
  type ChecklistAnswer,
  type Segment,
  type TradeImage,
  type TradingSession,
  fetchExecPositions,
  fetchOptionGroupImages,
  fetchOptionGroups,
  fetchPositionImages,
  fetchTradingSessions,
} from "./api";


// One closed manual trade, normalized from either a Position (spot/
// future) or an OptionPositionGroup - stop_loss_price/exit_price stay
// null for options (see ManualTab.tsx's HistoryEntry - no clean
// R-multiple exists for a spot-denominated SL against a premium-
// denominated pnl, and there's no single "exit price" for a multi-leg
// group). plan_checklist/review_* carry straight through from the
// backend - see docs/architecture.md § 'Trade discipline checklist'.
type ClosedTrade = {
  id: string;
  kind: "position" | "option_group";
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number | null;
  entry_price: number | null;
  exit_price: number | null;
  stop_loss_price: number | null;
  exit_time: string;
  pnl: number | null;
  plan_checklist: ChecklistAnswer[] | null;
  reviewed_at: string | null;
  review_violation: boolean | null;
  review_notes: string | null;
  review_checklist: ChecklistAnswer[] | null;
  // Which of ManualTab.tsx's two entry modes placed this trade - null for
  // trades closed before this field existed (added 2026-08-26). Shown on
  // each trade card below; not yet broken out into its own aggregate
  // stat - the data's captured now so that slice can be added later
  // without a backfill.
  order_type: "market" | "limit" | null;
  // ISO entry time - for the by-hour breakdown.
  entry_time: string | null;
  // Live Chart trade panel discipline flags + trade journal - the axes
  // the breakdown tables below slice win-rate / expectancy on.
  trend_followed: boolean | null;
  risk_managed: boolean | null;
  setup_tag: string | null;
  confidence: number | null;
};

type DayStats = {
  day: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  rSum: number;
  rCount: number;
};

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function pnlClass(n: number): string {
  return n > 0 ? "pnl-positive" : n < 0 ? "pnl-negative" : "";
}

// Local-date grouping key (YYYY-MM-DD, en-CA gives that ordering directly)
// - a browser-local view of "which day this trade closed on", not the
// server timezone execution.settings.timezone otherwise uses (the daily
// checklist's own "today"). Good enough for a performance breakdown -
// nothing here gates trading the way that server-side "today" does.
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function todayKey(): string {
  return dayKey(new Date().toISOString());
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

// A (day, segment) can have several check-in/check-out instances (a
// break resets the pair) - only the most recent one per segment is shown
// in full, with any earlier ones on that same day rolled into a "+N
// earlier (Xh)" summary, same reasoning ManualTab.tsx's own session bar
// follows (listing every interval in full got unreadable once a segment
// had several check-in/check-out cycles in one day).
function formatDurationMs(ms: number): string {
  const totalMinutes = ms / 60000;
  if (totalMinutes < 60) return `${Math.round(totalMinutes)}m`;
  return `${(totalMinutes / 60).toFixed(1)}h`;
}

function formatSessionHistory(sessions: TradingSession[]): string {
  const bySegment = new Map<Segment, TradingSession[]>();
  for (const s of sessions) {
    const list = bySegment.get(s.segment) ?? [];
    list.push(s);
    bySegment.set(s.segment, list);
  }
  return [...bySegment.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([segment, segSessions]) => {
      const sorted = [...segSessions].sort((a, b) => a.checked_in_at.localeCompare(b.checked_in_at));
      const mostRecent = sorted[sorted.length - 1];
      const recent = `${segment} ${formatTime(mostRecent.checked_in_at)}–${mostRecent.checked_out_at ? formatTime(mostRecent.checked_out_at) : "active"}`;
      const previous = sorted.slice(0, -1);
      if (previous.length === 0) return recent;
      const totalMs = previous.reduce((sum, s) => {
        if (!s.checked_out_at) return sum; // shouldn't happen for a non-most-recent session, but guard anyway
        return sum + (new Date(s.checked_out_at).getTime() - new Date(s.checked_in_at).getTime());
      }, 0);
      return `${recent} (+${previous.length} earlier, ${formatDurationMs(totalMs)})`;
    })
    .join(", ");
}

export default function ManualStatsPage() {
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [selectedDate, setSelectedDate] = useState<string>(todayKey());
  const [imagesByTradeId, setImagesByTradeId] = useState<Record<string, TradeImage[]>>({});
  // Explicit check-in/check-out bookends, keyed by their own log_date
  // (server-computed, execution.settings.timezone) - joined against
  // `days`/`selectedDate` below by that same YYYY-MM-DD string, same
  // approximation dayKey's own comment already accepts for trades.
  const [sessions, setSessions] = useState<TradingSession[]>([]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const [positions, groups, sessionRows] = await Promise.all([
        fetchExecPositions({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchOptionGroups({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchTradingSessions(),
      ]);
      setSessions(sessionRows);
      const fromPositions: ClosedTrade[] = positions
        // Individual option legs also come back as Positions with
        // strategy_id null (manualOnly's own filter) - exclude them here,
        // same "the group is the trade, not its legs" reasoning
        // find_pending_manual_review already applies server-side.
        .filter((p) => p.option_group_id == null && p.exit_time != null)
        .map((p) => ({
          id: p.id,
          kind: "position",
          segment: p.segment,
          symbol: p.symbol,
          action: p.action,
          exit_time: p.exit_time!,
          pnl: p.pnl,
          entry_price: p.entry_price,
          exit_price: p.exit_price,
          stop_loss_price: p.stop_loss_price,
          quantity: p.quantity,
          plan_checklist: p.plan_checklist,
          reviewed_at: p.reviewed_at,
          review_violation: p.review_violation,
          review_notes: p.review_notes,
          review_checklist: p.review_checklist,
          order_type: p.order_type,
          entry_time: p.entry_time,
          trend_followed: p.trend_followed,
          risk_managed: p.risk_managed,
          setup_tag: p.setup_tag,
          confidence: p.confidence,
        }));
      const fromGroups: ClosedTrade[] = groups
        .filter((g) => g.exit_time != null)
        .map((g) => ({
          id: g.id,
          kind: "option_group",
          segment: g.segment,
          symbol: g.underlying_symbol,
          action: g.action,
          exit_time: g.exit_time!,
          pnl: g.pnl,
          entry_price: g.net_debit,
          exit_price: null,
          stop_loss_price: null,
          quantity: g.quantity,
          plan_checklist: g.plan_checklist,
          reviewed_at: g.reviewed_at,
          review_violation: g.review_violation,
          review_notes: g.review_notes,
          review_checklist: g.review_checklist,
          order_type: g.order_type,
          entry_time: g.entry_time,
          trend_followed: g.trend_followed,
          risk_managed: g.risk_managed,
          setup_tag: g.setup_tag,
          confidence: g.confidence,
        }));
      setTrades([...fromPositions, ...fromGroups]);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadImagesForTrade(t: ClosedTrade) {
    if (t.id in imagesByTradeId) return;
    try {
      const images = t.kind === "position" ? await fetchPositionImages(t.id) : await fetchOptionGroupImages(t.id);
      setImagesByTradeId((prev) => ({ ...prev, [t.id]: images }));
    } catch {
      // leave unset - the panel just shows no thumbnails, retried next selection
    }
  }

  if (error) {
    return (
      <div className="manual-wide-page">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (trades == null) {
    return (
      <div className="manual-wide-page">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  const byDay = new Map<string, DayStats>();
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let rSum = 0;
  let rCount = 0;

  for (const t of trades) {
    if (t.pnl == null) continue;
    const key = dayKey(t.exit_time);
    const day = byDay.get(key) ?? { day: key, trades: 0, wins: 0, losses: 0, pnl: 0, rSum: 0, rCount: 0 };
    day.trades += 1;
    day.pnl += t.pnl;
    if (t.pnl > 0) day.wins += 1;
    else if (t.pnl < 0) day.losses += 1;
    if (t.entry_price != null && t.stop_loss_price != null && t.quantity != null && t.entry_price !== t.stop_loss_price) {
      const risk = Math.abs(t.entry_price - t.stop_loss_price) * t.quantity;
      if (risk > 0) {
        day.rSum += t.pnl / risk;
        day.rCount += 1;
      }
    }
    byDay.set(key, day);

    totalPnl += t.pnl;
    if (t.pnl > 0) totalWins += 1;
    else if (t.pnl < 0) totalLosses += 1;
  }
  for (const day of byDay.values()) {
    rSum += day.rSum;
    rCount += day.rCount;
  }
  const totalTrades = trades.filter((t) => t.pnl != null).length;
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : null;
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : null;
  const avgR = rCount > 0 ? rSum / rCount : null;

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const selectedTrades = trades.filter((t) => t.exit_time && dayKey(t.exit_time) === selectedDate);

  const sessionsByDay = new Map<string, TradingSession[]>();
  for (const s of sessions) {
    const list = sessionsByDay.get(s.log_date) ?? [];
    list.push(s);
    sessionsByDay.set(s.log_date, list);
  }
  const selectedSessions = sessionsByDay.get(selectedDate) ?? [];

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>Trading Performance</h3>
        {/* The "Discipline — trend"/"Discipline — sizing" breakdowns that
            used to sit below moved to their own page 2026-09-05 (the
            overall discipline score + more graphics live there) - same
            postMessage jump OiSummaryPage's "Intraday Chart ↗" link uses. */}
        <button
          type="button"
          className="ctp-link"
          onClick={() => window.parent.postMessage({ source: "algo-trading-app", type: "navigate-discipline" }, "*")}
        >
          Discipline score ↗
        </button>
      </div>

      {/* Collapsed by default (ManualCalendarFilter's own documented
          default) - this page used to force it open, pushing a full
          month grid above the actually useful stats/trade list every
          time you opened Performance. Still one click away. */}
      <ManualCalendarFilter selectedDate={selectedDate} onSelectDate={setSelectedDate} />

      {totalTrades === 0 ? (
        <p className="muted">No closed manual trades yet.</p>
      ) : (
        <>
          <section className="manual-settings-section">
            <div className="manual-stats-summary">
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Total trades</span>
                <span className="manual-stats-card-value">{totalTrades}</span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Win rate</span>
                <span className="manual-stats-card-value">{winRate != null ? `${fmt(winRate, 1)}%` : "-"}</span>
                <span className="muted">{totalWins}W / {totalLosses}L</span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Total PnL</span>
                <span className={`manual-stats-card-value ${pnlClass(totalPnl)}`}>{fmt(totalPnl)}</span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Avg PnL / trade</span>
                <span className={`manual-stats-card-value ${avgPnl != null ? pnlClass(avgPnl) : ""}`}>
                  {avgPnl != null ? fmt(avgPnl) : "-"}
                </span>
              </div>
              <div className="manual-stats-card">
                <span className="manual-stats-card-label">Avg R-multiple</span>
                <span className={`manual-stats-card-value ${avgR != null ? pnlClass(avgR) : ""}`}>
                  {avgR != null ? `${avgR >= 0 ? "+" : ""}${fmt(avgR)}R` : "-"}
                </span>
                <span className="muted" title="Realized pnl / (|entry - stop-loss| x quantity). Spot/future trades with a flat stop-loss only - options have no comparable premium-vs-spot risk figure.">
                  {rCount} trade{rCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </section>

          <section className="manual-settings-section">
            <h4>By day</h4>
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Trades</th>
                    <th>Win rate</th>
                    <th>PnL</th>
                    <th>Avg R</th>
                    <th>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => {
                    const daySessions = sessionsByDay.get(d.day) ?? [];
                    return (
                      <tr key={d.day} className={d.day === selectedDate ? "selected-row" : ""} onClick={() => setSelectedDate(d.day)}>
                        <td>{d.day}</td>
                        <td>{d.trades}</td>
                        <td>{d.trades > 0 ? `${fmt((d.wins / d.trades) * 100, 0)}%` : "-"}</td>
                        <td className={pnlClass(d.pnl)}>{fmt(d.pnl)}</td>
                        <td className={d.rCount > 0 ? pnlClass(d.rSum / d.rCount) : ""}>
                          {d.rCount > 0 ? `${d.rSum / d.rCount >= 0 ? "+" : ""}${fmt(d.rSum / d.rCount)}R` : "-"}
                        </td>
                        <td className="muted">{daySessions.length === 0 ? "-" : formatSessionHistory(daySessions)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* A grid instead of 4 full-width stacked tables - most of these
              are a handful of short rows (confidence has at most 5) that
              never needed the whole page width a single column gave them.
              Shared with the Discipline page - see .stats-grid. */}
          <div className="stats-grid">
            <BreakdownTable
              title="By setup"
              header="Setup"
              rows={breakdown(trades, (t) => t.setup_tag ?? "— untagged —").sort((a, b) => b.pnl - a.pnl)}
            />
            <BreakdownTable
              title="By confidence"
              header="Rated"
              rows={breakdown(trades, (t) => (t.confidence == null ? null : `${t.confidence} / 5`)).sort((a, b) =>
                a.key < b.key ? -1 : 1,
              )}
            />
            <BreakdownTable
              title="By symbol"
              header="Symbol"
              rows={breakdown(trades, (t) => t.symbol).sort((a, b) => b.pnl - a.pnl)}
            />
            <BreakdownTable
              title="By entry hour"
              header="Hour"
              rows={breakdown(trades, (t) =>
                t.entry_time ? `${String(new Date(t.entry_time).getHours()).padStart(2, "0")}:00` : null,
              ).sort((a, b) => (a.key < b.key ? -1 : 1))}
            />
          </div>

          <section className="manual-settings-section">
            <h4>Trades on {selectedDate}</h4>
            {selectedSessions.length > 0 && <p className="muted">Session: {formatSessionHistory(selectedSessions)}</p>}
            {selectedTrades.length === 0 ? (
              <p className="muted">No closed manual trades on this date.</p>
            ) : (
              <div className="manual-stats-trade-list">
                {selectedTrades.map((t) => (
                  <ManualStatsTradeCard key={t.id} trade={t} images={imagesByTradeId[t.id]} onExpand={() => void loadImagesForTrade(t)} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ManualStatsTradeCard({
  trade,
  images,
  onExpand,
}: {
  trade: ClosedTrade;
  images: TradeImage[] | undefined;
  onExpand: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="manual-stats-trade-card">
      <button
        type="button"
        className="manual-stats-trade-header"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onExpand();
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="muted">{new Date(trade.exit_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
        <strong>{trade.symbol}</strong>
        <span className="muted">{trade.action}</span>
        <span className="muted">Qty {trade.quantity ?? "-"}</span>
        {trade.order_type && (
          <span className="manual-order-type-badge" title={trade.order_type === "market" ? "Market order" : "Limit order"}>
            {trade.order_type === "market" ? "MKT" : "LMT"}
          </span>
        )}
        {trade.trend_followed && (
          <span className="manual-order-type-badge" title="Placed with the trend (Trend-only lock)">
            TR
          </span>
        )}
        {trade.risk_managed && (
          <span className="manual-order-type-badge" title="Risk-managed placement">
            RM
          </span>
        )}
        {trade.setup_tag && (
          <span className="manual-order-type-badge" title="Setup">
            {trade.setup_tag}
          </span>
        )}
        {trade.confidence != null && (
          <span className="muted" title={`Confidence ${trade.confidence}/5`}>
            {"●".repeat(trade.confidence)}
            {"○".repeat(5 - trade.confidence)}
          </span>
        )}
        <span className={pnlClass(trade.pnl ?? 0)}>{trade.pnl != null ? fmt(trade.pnl) : "-"}</span>
      </button>
      {open && (
        <div className="manual-stats-trade-detail">
          {trade.plan_checklist && trade.plan_checklist.length > 0 && (
            <div className="manual-checklist">
              <span className="manual-checklist-title">Pre-trade plan checklist</span>
              <div className="manual-checklist-items">
                {trade.plan_checklist.map((a) => (
                  <span className="manual-review-readonly-item" key={a.label}>
                    {a.checked ? "✓" : "✗"} {a.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {trade.reviewed_at == null ? (
            <p className="muted">Not reviewed yet.</p>
          ) : (
            <>
              <div className="manual-review-banner-row">
                <span>Followed plan without deviation?</span>
                <span className={trade.review_violation ? "pnl-negative" : "pnl-positive"}>
                  {trade.review_violation ? "No" : "Yes"}
                </span>
              </div>
              {trade.review_violation && trade.review_notes && (
                <p className="manual-review-readonly-notes">&ldquo;{trade.review_notes}&rdquo;</p>
              )}
              {trade.review_checklist && trade.review_checklist.length > 0 && (
                <div className="manual-checklist">
                  <span className="manual-checklist-title">Post-trade self-check</span>
                  <div className="manual-checklist-items">
                    {trade.review_checklist.map((a) => (
                      <span className="manual-review-readonly-item" key={a.label}>
                        {a.checked ? "✓" : "✗"} {a.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {images != null && images.length > 0 && (
            <div className="manual-history-images">
              {images.map((img) => (
                <span className="manual-history-image-thumb" key={img.id}>
                  <TradeImageThumb id={img.id} />
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { Book, OptionGroup, Performance, Position, Segment } from "../api/types";
import { formatPct, formatPnl, formatTime } from "../format";
import { useResource } from "../hooks/useResource";
import { tapeStats, type TapeTrade } from "../pages/todayModel";
import { Signed } from "./bits";
import { LinkRow, NextStep } from "./nav";

const shortDay = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(new Date(iso));

/** A trade's dot grows with how much it made or lost (14 to 28px), relative to the biggest of the day. */
export const dotSize = (pnl: number, maxAbs: number): number => 14 + Math.round(14 * (maxAbs > 0 ? Math.min(1, Math.abs(pnl) / maxAbs) : 0));

function WinRing({ rate, label }: { rate: number | null; label: string }) {
  const R = 22;
  const C = 2 * Math.PI * R;
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" role="img" aria-label={label} data-testid="win-ring">
      <circle cx="30" cy="30" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="7" />
      {rate != null && (
        <circle cx="30" cy="30" r={R} fill="none" stroke={rate >= 0.5 ? "var(--up)" : "var(--dn)"} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${rate * C} ${C}`} transform="rotate(-90 30 30)" />
      )}
      <text x="30" y="34" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor">{rate == null ? "–" : `${Math.round(rate * 100)}%`}</text>
    </svg>
  );
}

/** The longer record, since the account's reset: wins over every trade that won or lost, summed over the markets on show. */
function useSinceReset(book: Book, segments: Segment[]) {
  const key = `${book}:${segments.join(",")}`;
  return useResource(async () => {
    const rows = await Promise.all(segments.map((s) => api<Performance>("execution", `/performance/${s}${book === "positional" ? "?book=positional" : ""}`).catch(() => null)));
    const stats = rows.map((r) => r?.performance).filter((p): p is NonNullable<typeof p> => p != null);
    const wins = stats.reduce((n, p) => n + p.wins, 0);
    const lost = stats.reduce((n, p) => n + p.losses, 0);
    return { wins, trades: wins + lost, rate: wins + lost > 0 ? wins / (wins + lost) : null };
  }, [key]);
}

type Props = { tape: TapeTrade[]; book: Book; segments: Segment[]; onPick: (t: TapeTrade) => void };

/** The day's trades as one row of dots (closed ones filled green or red, open ones outlined and live) with the win rate beside it.
 * Tapping a dot opens that trade; the full list and its actions live on Portfolio. */
export function TradeTape({ tape, book, segments, onPick }: Props) {
  const stats = tapeStats(tape);
  const maxAbs = Math.max(0, ...tape.map((t) => Math.abs(t.pnl)));
  const since = useSinceReset(book, segments);
  const positionsHref = `/portfolio?tab=positions${book === "positional" ? "&book=positional" : ""}`;
  const sinceData = since.data && since.data.trades > 0 ? since.data : null;

  return (
    <div className="card tape" data-testid="trade-tape">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>Today&apos;s trades</h2>
        <span className="dim" style={{ fontSize: 13 }}>{stats.closed} closed · {stats.open} open{stats.carried > 0 ? ` (${stats.carried} carried over)` : ""}</span>
      </div>
      {tape.length === 0 ? (
        <p className="dim" style={{ margin: "8px 0 0" }}>No trades yet today.</p>
      ) : (
        <>
          <div className="tape-dots" role="list" aria-label="Trades today">
            {tape.map((t) => {
              const size = dotSize(t.pnl, maxAbs);
              const tone = t.pnl > 0 ? "win" : t.pnl < 0 ? "loss" : "flat";
              const state = t.open ? (t.carried ? "open, carried over from an earlier day" : "open") : "closed";
              const common = {
                role: "listitem",
                className: `tape-dot ${tone}${t.open ? " open" : ""}${t.carried ? " carried" : ""}`,
                style: { width: size, height: size },
                "aria-label": `${t.symbol} ${t.action === "BUY" ? "buy" : "sell"}, ${state}, ${formatPnl(t.pnl)}`,
                title: t.open ? `${t.symbol} · ${formatPnl(t.pnl)} (${t.carried ? `carried over, opened ${shortDay(t.at)}` : "open"})` : `${t.symbol} · ${formatPnl(t.pnl)} · ${formatTime(t.at)}`,
              };
              // An open trade is managed on Portfolio → Positions (no pop-up here); a finished one opens its summary.
              return t.open ? <Link key={t.id} to={positionsHref} {...common} /> : <button key={t.id} onClick={() => onPick(t)} {...common} />;
            })}
          </div>
          <div className="tape-stats">
            <WinRing rate={stats.winRate} label={stats.winRate == null ? "Win rate: no closed trades yet" : `Win rate today ${Math.round(stats.winRate * 100)} percent`} />
            <div className="tape-facts">
              <span>
                <strong>{stats.winRate == null ? "No closed trades yet" : `${stats.wins} of ${stats.wins + stats.losses} won`}</strong>
                {stats.streak && <span className="dim"> · {stats.streak.n} {stats.streak.kind === "win" ? "win" : "loss"}{stats.streak.n === 1 ? "" : stats.streak.kind === "win" ? "s" : "es"} in a row</span>}
              </span>
              {stats.best != null && stats.worst != null && (
                <span className="dim" style={{ fontSize: 13 }}>
                  Best <Signed value={stats.best} text={formatPnl(stats.best)} /> · Worst <Signed value={stats.worst} text={formatPnl(stats.worst)} />
                </span>
              )}
              {sinceData && (
                <span className="faint" style={{ fontSize: 12 }}>
                  Since the reset: {formatPct((sinceData.rate ?? 0) * 100, 0)} won, over {sinceData.trades} trades
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One line on what is open and what needs attention, instead of a card per position. */
export function OpenNow({ count, pnl, noStop, carried, waiting, book, neverTraded, onWaiting }: {
  count: number; pnl: number; noStop: number; carried: number; waiting: number; book: Book; neverTraded: boolean; onWaiting: () => void;
}) {
  return (
    <div className="card" data-testid="open-now">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>Open now</h2>
        {count > 0 && <span className="num"><Signed value={pnl} text={formatPnl(pnl)} /></span>}
      </div>
      {count === 0 ? (
        <p className="dim" style={{ margin: "8px 0 0" }}>
          {neverTraded ? (
            <>Your trades will show up here once you place one. <NextStep to="/trade">Place your first trade</NextStep></>
          ) : (
            "Nothing open right now."
          )}
        </p>
      ) : (
        <p style={{ margin: "8px 0 0" }}>
          <strong>{count} open</strong>
          {carried > 0 && (
            <span className="pill" style={{ marginLeft: 8 }} data-testid="carried" title="Opened on an earlier day and still open, so it is not an intraday trade now">{carried} carried over</span>
          )}
          {noStop > 0 ? (
            <span className="pill warn" style={{ marginLeft: 8 }} data-testid="no-stop">{noStop} without a stop</span>
          ) : (
            <span className="faint" style={{ marginLeft: 8, fontSize: 13 }}>every one has a stop</span>
          )}
        </p>
      )}
      {waiting > 0 && (
        <p style={{ margin: "8px 0 0" }}>
          <button className="pill" onClick={onWaiting}>{waiting} waiting for a price ›</button>
        </p>
      )}
      <LinkRow to={`/portfolio?tab=positions${book === "positional" ? "&book=positional" : ""}`} title="Positions" hint="Move a stop, square off, or add a note" />
    </div>
  );
}

/** A finished trade, as the sheet shows it when its dot is tapped. */
export function ClosedTrade({ trade, onClose }: { trade: Position | OptionGroup; onClose: () => void }) {
  const isPos = "symbol" in trade;
  const name = isPos ? trade.symbol : trade.underlying_symbol;
  const pnl = trade.pnl ?? 0;
  return (
    <div className="card" style={{ margin: 0 }} data-testid="closed-trade">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <strong>
          {name} <span className={`pill ${trade.action === "BUY" ? "up" : "dn"}`}>{trade.action}</span>
          {!isPos && <span className="pill" style={{ marginLeft: 4 }}>Option</span>}
        </strong>
        <button className="btn btn-small" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="big num" style={{ fontSize: 26, fontWeight: 600 }}><Signed value={pnl} text={formatPnl(pnl)} /></div>
      <p className="dim" style={{ margin: "4px 0" }}>
        Closed {formatTime(trade.exit_time)}{trade.exit_reason ? ` · ${trade.exit_reason.replace(/_/g, " ")}` : ""}
        {isPos && trade.exit_price != null ? ` · ${trade.entry_price} → ${trade.exit_price}` : ""}
      </p>
      <LinkRow to="/performance?tab=review&section=journal" title="Review this trade" hint="Say what went wrong, or that nothing did" />
    </div>
  );
}

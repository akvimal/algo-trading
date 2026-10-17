import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { Account, Book, DisciplineV2, EquityHistory, MistakeSummary, Segment } from "../api/types";
import { useResource } from "../hooks/useResource";
import { formatInr, formatPct, formatPnl } from "../format";
import { focusHabit, habitRows } from "../pages/learnModel";
import { tagLabel } from "../pages/journalModel";
import { disciplineBand } from "../pages/portfolioModel";
import { recentTrend, type DayPnl } from "../pages/todayModel";
import { Signed } from "./bits";

export const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };
const BAND_TEXT = { none: "Not enough trades yet", low: "Needs work", fair: "Getting there", good: "Good" } as const;

/** A line with no axes: the shape of the last ten days, green when it ended above where it started, red when below. */
function Trend({ values }: { values: number[] }) {
  const W = 240;
  const H = 40;
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (W - 8) + 4;
  const y = (v: number) => H - 5 - ((v - lo) / span) * (H - 10);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  const color = up ? "var(--up)" : "var(--dn)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="acct-trend" role="img" aria-label={`Last ${values.length - 1} days, ${up ? "up" : "down"}`} data-testid="trend">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3" fill={color} />
    </svg>
  );
}

type Props = {
  segment: Segment;
  book: Book;
  account: Account;
  /** Today's result across the whole account (every kind of trade on its balance): also what the daily loss limit is measured against. */
  pnl: DayPnl;
  /** Movement of the open positions since the server last reported them (live prices). */
  liveDelta: number;
  live: boolean;
};

/** One account on the home page: its balance, today's result, the last ten days, the daily loss limit and a short discipline read.
 * The whole card opens the account's detail; the review chip is the one separate link inside it. */
export function AccountCard({ segment, book, account, pnl, liveDelta, live }: Props) {
  const bookQuery = book === "positional" ? "&book=positional" : "";
  const balance = account.current_balance + account.unrealized_pnl + liveDelta;
  const equity = useResource(() => api<EquityHistory>("execution", `/equity-history/${segment}?days=30${bookQuery}`), [segment, book]);
  // Discipline is about the everyday habit only; the positional book has none.
  const discipline = useResource(() => api<DisciplineV2>("execution", `/discipline/${segment}`), [segment], { enabled: book === "intraday" });
  const mistakes = useResource(() => api<MistakeSummary>("execution", `/trade-review/summary/${segment}`), [segment], { enabled: book === "intraday" });

  const trend = equity.data ? recentTrend(equity.data.points, balance) : [];
  const since = equity.data?.stats ? { pct: equity.data.stats.return_pct, day: equity.data.stats.since } : null;
  const limit = account.max_daily_loss ?? 0;
  const used = Math.max(0, -pnl.total);
  const score = discipline.data?.score ?? null;
  const band = disciplineBand(score);
  const fix = mistakes.data ? focusHabit(habitRows(mistakes.data)) : null;
  const toReview = mistakes.data?.pending ?? 0;
  const to = `/performance?segment=${segment}&tab=overview${bookQuery}`;

  return (
    <div className="card acct-card" data-testid="account-card" aria-label={SEGMENT_LABEL[segment]}>
      <div className="row">
        <Link to={to} className="acct-link">
          <strong>{SEGMENT_LABEL[segment]}</strong>
          {book === "positional" && <span className="faint"> · positional</span>}
        </Link>
        <span aria-hidden="true" className="link-row-chevron">›</span>
      </div>

      <div className="acct-figures">
        <div>
          <div className="big num">{formatInr(balance)}</div>
          {since && <div className="faint" style={{ fontSize: 12 }}>{formatPct(since.pct, 2, true)} since the reset</div>}
        </div>
        <div className="acct-today">
          <span className="dim" style={{ fontSize: 12 }}>
            Today
            {live && (
              <span className="live-dot on" data-testid="live-today" title="Live: open results update as prices move">
                <span className="sr-only">Live</span>
              </span>
            )}
          </span>
          <Signed className="num" value={pnl.total} text={formatPnl(pnl.total)} />
          <span className="faint" style={{ fontSize: 12 }}>{pnl.closedToday} closed</span>
        </div>
      </div>

      {trend.length >= 2 ? (
        <Trend values={trend} />
      ) : (
        !equity.loading && <p className="faint" style={{ margin: "4px 0", fontSize: 12 }}>The trend starts after your first trading day ends.</p>
      )}

      {limit > 0 && (
        <div>
          <div className="meter" role="meter" aria-label="Daily loss budget used" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
            <i style={{ width: `${Math.min(1, used / limit) * 100}%` }} />
          </div>
          <span className="faint" style={{ fontSize: 12 }}>{formatInr(used)} of {formatInr(limit)} daily loss limit used</span>
        </div>
      )}

      {book === "intraday" && discipline.data && (
        <div className="acct-discipline">
          <span>
            Discipline <strong className="num">{score ?? "–"}</strong> <span className="dim">· {BAND_TEXT[band]}</span>
          </span>
          {fix && <span className="dim" style={{ fontSize: 13 }}>Fix next: {tagLabel(fix.habit.tag)}</span>}
        </div>
      )}

      {toReview > 0 && (
        <Link to={`/performance?segment=${segment}&tab=review&section=journal`} className="pill warn acct-chip">
          {toReview} to review ›
        </Link>
      )}
    </div>
  );
}

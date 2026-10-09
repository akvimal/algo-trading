import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { Account } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { Empty, ErrorNotice, Signed, Skeleton } from "../components/bits";
import { FirstWeekCard } from "../components/FirstWeekCard";
import { MarketsCard } from "../components/MarketsCard";
import { PerformanceSnapshot } from "../components/PerformanceSnapshot";
import { PositionCard } from "../components/PositionCard";
import { formatInr, formatPnl } from "../format";
import { useLivePositions } from "../hooks/useLivePositions";
import { useResource } from "../hooks/useResource";
import { firstWeek } from "./onboardingModel";
import { dayPnl, inMode, lossBudget, openGroups, openPositions, paperBalance, type Mode } from "./todayModel";
import { groupsApi, positionsApi } from "../api/rupees";

const POLL_MS = 15_000;
const MODES: { id: Mode; label: string }[] = [
  { id: "intraday", label: "Intraday" },
  { id: "positional", label: "Positional" },
  { id: "options", label: "Options" },
];

async function loadToday() {
  const [accounts, positions, groups] = await Promise.all([
    api<Account[]>("execution", "/accounts"),
    positionsApi("/positions?with_live_pnl=true&limit=200"),
    groupsApi("/option-groups?with_live_pnl=true&limit=200"),
  ]);
  return { accounts, positions, groups };
}

export function TodayPage() {
  const [mode, setMode] = useState<Mode>("intraday");
  const { guided, markets } = useProfile();
  const today = useResource(loadToday, [], { pollMs: POLL_MS });
  // Open spot and futures results follow the price socket between polls.
  const live = useLivePositions(today.data?.positions);

  if (today.loading) return <Skeleton lines={5} />;
  if (today.error && !today.data) return <ErrorNotice error={today.error} onRetry={today.reload} />;
  if (!today.data) return null;

  const { groups } = today.data;
  const positions = live.positions;
  // Every market has an account, but only the ones the person chose count towards their totals.
  const accounts = today.data.accounts.filter((a) => markets.includes(a.segment));
  const pnl = dayPnl(positions, groups);
  const liveDelta = accounts.reduce((n, a) => n + (live.delta[a.segment] ?? 0), 0);
  const budget = lossBudget(accounts, pnl.total);
  const shownPositions = mode === "options" ? [] : openPositions(positions).filter((p) => inMode(p, mode));
  const shownGroups = mode === "options" ? openGroups(groups) : [];

  return (
    <div className="stack">
      <div className="hero-row">
      <div className="card hero">
        <span className="dim">Paper balance</span>
        <span className="big num">{formatInr(paperBalance(accounts) + liveDelta)}</span>
      </div>

      <div className="card hero" aria-label="Today's profit and loss">
        <span className="dim">
          Today
          {live.live && (
            <span className="live-dot on" data-testid="live-today" title="Live: open results update as prices move">
              <span className="sr-only">Live</span>
            </span>
          )}
        </span>
        <Signed className="big" value={pnl.total} text={formatPnl(pnl.total)} />
        <span className="dim" style={{ fontSize: 13 }}>
          {formatPnl(pnl.realized)} booked from {pnl.closedToday} closed · {formatPnl(pnl.unrealized)} open
        </span>
        {budget && (
          <>
            <div
              className="meter"
              role="meter"
              aria-label="Daily loss budget used"
              aria-valuemin={0}
              aria-valuemax={budget.limit}
              aria-valuenow={budget.used}
            >
              <i style={{ width: `${budget.fraction * 100}%` }} />
            </div>
            <span className="faint" style={{ fontSize: 12 }}>
              {formatInr(budget.used)} of {formatInr(budget.limit)} daily loss limit used
            </span>
          </>
        )}
      </div>
      </div>

      {today.error && <ErrorNotice error={today.error} onRetry={today.reload} />}

      {/* One column on a phone (Markets folded under the P&L); from 900px positions on the left and Markets in a sticky column on the right. */}
      <div className="today-grid">
      {markets.length > 0 && (
        <aside className="today-aside">
          <MarketsCard markets={markets} />
        </aside>
      )}
      <div className="stack today-main">
      {guided && <FirstWeekCard steps={firstWeek(positions, groups)} />}

      <div className="tabs" role="group" aria-label="Trade type">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <h2 className="section-title">Open now</h2>
      {shownPositions.length + shownGroups.length === 0 ? (
        <Empty title="Nothing open here">
          {positions.length + groups.length === 0 ? (
            <>
              Your trades will show up here once you place one. <Link to="/trade">Place your first trade</Link>
            </>
          ) : (
            "No open trades in this view."
          )}
        </Empty>
      ) : (
        <div className="stack">
          {shownPositions.map((p) => (
            <PositionCard key={p.id} kind="position" item={p} onChanged={today.reload} />
          ))}
          {shownGroups.map((g) => (
            <PositionCard key={g.id} kind="group" item={g} onChanged={today.reload} />
          ))}
        </div>
      )}

      <PerformanceSnapshot markets={accounts.map((a) => a.segment)} />
      </div>
      </div>
    </div>
  );
}

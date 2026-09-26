import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { Account, MarketSentiment, OptionGroup, Position } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { Empty, ErrorNotice, Signed, Skeleton } from "../components/bits";
import { FirstWeekCard } from "../components/FirstWeekCard";
import { PositionCard } from "../components/PositionCard";
import { formatInr, formatPnl } from "../format";
import { useResource } from "../hooks/useResource";
import { firstWeek } from "./onboardingModel";
import { dayPnl, inMode, lossBudget, openGroups, openPositions, paperBalance, type Mode } from "./todayModel";

const POLL_MS = 15_000;
const MODES: { id: Mode; label: string }[] = [
  { id: "intraday", label: "Intraday" },
  { id: "positional", label: "Positional" },
  { id: "options", label: "Options" },
];

async function loadToday() {
  const [accounts, positions, groups] = await Promise.all([
    api<Account[]>("execution", "/accounts"),
    api<Position[]>("execution", "/positions?with_live_pnl=true&limit=200"),
    api<OptionGroup[]>("execution", "/option-groups?with_live_pnl=true&limit=200"),
  ]);
  return { accounts, positions, groups };
}

export function TodayPage() {
  const [mode, setMode] = useState<Mode>("intraday");
  const { guided, markets } = useProfile();
  const today = useResource(loadToday, [], { pollMs: POLL_MS });
  // Sentiment is context, not the point of the screen: it loads on its own and its failure
  // never blocks (or replaces) the positions above it.
  const pulse = useResource(() => api<MarketSentiment>("marketData", "/options/sentiment"), [], { pollMs: 60_000 });

  if (today.loading) return <Skeleton lines={5} />;
  if (today.error && !today.data) return <ErrorNotice error={today.error} onRetry={today.reload} />;
  if (!today.data) return null;

  const { positions, groups } = today.data;
  // Every market has an account, but only the ones the person chose count towards their totals.
  const accounts = today.data.accounts.filter((a) => markets.includes(a.segment));
  const pnl = dayPnl(positions, groups);
  const budget = lossBudget(accounts, pnl.total);
  const shownPositions = mode === "options" ? [] : openPositions(positions).filter((p) => inMode(p, mode));
  const shownGroups = mode === "options" ? openGroups(groups) : [];

  return (
    <div className="stack">
      <div className="card hero">
        <span className="dim">Paper balance</span>
        <span className="big num">{formatInr(paperBalance(accounts))}</span>
      </div>

      <div className="card hero" aria-label="Today's profit and loss">
        <span className="dim">Today</span>
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

      {today.error && <ErrorNotice error={today.error} onRetry={today.reload} />}

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

      <h2 className="section-title">Market pulse</h2>
      {pulse.loading && <Skeleton lines={2} />}
      {pulse.error && <ErrorNotice error={pulse.error} onRetry={pulse.reload} />}
      {pulse.data && (
        <div className="card stack">
          {Object.entries(pulse.data.exchanges).map(([exchange, s]) => (
            <div className="row" key={exchange}>
              <span>{exchange}</span>
              <span className="pill">
                {s.direction} · {s.strength}
              </span>
            </div>
          ))}
          <span className="faint" style={{ fontSize: 12 }}>
            Open-interest reading, for context only. It is not a recommendation.
          </span>
        </div>
      )}
    </div>
  );
}

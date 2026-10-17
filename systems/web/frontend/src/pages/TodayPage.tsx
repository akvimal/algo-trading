import { useState } from "react";
import { NextStep } from "../components/nav";
import { api } from "../api/http";
import { listWaitingOrders } from "../api/trade";
import type { Account, PendingOrder } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { Empty, ErrorNotice, Signed, Skeleton } from "../components/bits";
import { FirstWeekCard } from "../components/FirstWeekCard";
import { AccountCard } from "../components/AccountCard";
import { MarketsCard } from "../components/MarketsCard";
import { PositionCard } from "../components/PositionCard";
import { WaitingOrders } from "../components/WaitingOrders";
import { formatInr, formatPnl } from "../format";
import { useLivePositions } from "../hooks/useLivePositions";
import { useResource } from "../hooks/useResource";
import { firstWeek } from "./onboardingModel";
import { bookOf, bookPnl, cardPnl, inMode, liveDeltaFor, openGroups, openPositions, type Mode } from "./todayModel";
import { groupsApi, positionsApi } from "../api/rupees";

const POLL_MS = 15_000;
const MODES: { id: Mode; label: string }[] = [
  { id: "intraday", label: "Intraday" },
  { id: "positional", label: "Positional" },
  { id: "options", label: "Options" },
];

async function loadToday() {
  const [accounts, positionalAccounts, positions, groups, waiting] = await Promise.all([
    api<Account[]>("execution", "/accounts"),
    api<Account[]>("execution", "/accounts?book=positional").catch(() => [] as Account[]),
    positionsApi("/positions?with_live_pnl=true&limit=200"),
    groupsApi("/option-groups?with_live_pnl=true&limit=200"),
    listWaitingOrders().catch(() => [] as PendingOrder[]),
  ]);
  return { accounts, positionalAccounts, positions, groups, waiting };
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
  // Every market has an account, but only the ones the person chose are shown. Intraday and Options trade the everyday
  // account; Positional is its own balance.
  const book = bookOf(mode);
  const cards = (book === "positional" ? today.data.positionalAccounts : today.data.accounts).filter((a) => markets.includes(a.segment));
  const cardRows = cards.map((a) => {
    const delta = liveDeltaFor(today.data!.positions, positions, a.segment, book);
    return { account: a, delta, pnl: cardPnl(positions, groups, a.segment, mode), accountPnl: bookPnl(positions, groups, a.segment, book).total };
  });
  const totalBalance = cardRows.reduce((n, r) => n + r.account.current_balance + r.account.unrealized_pnl + r.delta, 0);
  const totalToday = cardRows.reduce((n, r) => n + r.pnl.total, 0);
  const shownPositions = mode === "options" ? [] : openPositions(positions).filter((p) => inMode(p, mode));
  const shownGroups = mode === "options" ? openGroups(groups) : [];
  // A waiting order sits in the tab its trade will open in.
  const shownWaiting = today.data.waiting.filter((w) =>
    mode === "options" ? w.strategy === "naked" || w.strategy === "spread" : w.strategy !== "naked" && w.strategy !== "spread" && (w.horizon ?? "intraday") === mode,
  );

  return (
    <div className="stack">
      <div className="tabs" role="group" aria-label="Trade type">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {cardRows.length > 1 && (
        <div className="total-strip" aria-label="All accounts" data-testid="total-strip">
          <span>
            <span className="dim">Total </span>
            <strong className="num">{formatInr(totalBalance)}</strong>
          </span>
          <span>
            <span className="dim">Today </span>
            <Signed className="num" value={totalToday} text={formatPnl(totalToday)} />
          </span>
        </div>
      )}
      <div className="acct-grid">
        {cardRows.map((r) => (
          <AccountCard key={r.account.segment} segment={r.account.segment} mode={mode} account={r.account} pnl={r.pnl} accountPnl={r.accountPnl} liveDelta={r.delta} live={live.live} />
        ))}
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

      <h2 className="section-title">Open now</h2>
      {shownPositions.length + shownGroups.length === 0 ? (
        <Empty title="Nothing open here">
          {positions.length + groups.length === 0 ? (
            <>
              Your trades will show up here once you place one. <NextStep to="/trade">Place your first trade</NextStep>
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

      <WaitingOrders orders={shownWaiting} onChanged={today.reload} />

      </div>
      </div>
    </div>
  );
}

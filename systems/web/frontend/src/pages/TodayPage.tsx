import { useState } from "react";
import { api } from "../api/http";
import { listWaitingOrders } from "../api/trade";
import type { Account, PendingOrder } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { ErrorNotice, Signed, Skeleton } from "../components/bits";
import { FirstWeekCard } from "../components/FirstWeekCard";
import { AccountCard } from "../components/AccountCard";
import { hasSessions, SessionGrids, useSessionGrids } from "../components/SessionGrid";
import { PositionCard } from "../components/PositionCard";
import { Sheet } from "../components/Sheet";
import { ClosedTrade, OpenNow, TradeTape } from "../components/TradeTape";
import { WaitingOrders } from "../components/WaitingOrders";
import { formatInr, formatPnl } from "../format";
import { useLivePositions } from "../hooks/useLivePositions";
import { useResource } from "../hooks/useResource";
import { firstWeek } from "./onboardingModel";
import type { Book, OptionGroup, Position } from "../api/types";
import { bookPnl, liveDeltaFor, openSummary, tradeTape, type TapeTrade } from "./todayModel";
import { groupsApi, positionsApi } from "../api/rupees";

const POLL_MS = 15_000;
const BOOKS: { id: Book; label: string }[] = [
  { id: "intraday", label: "Everyday" },
  { id: "positional", label: "Positional" },
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
  const [book, setBook] = useState<Book>("intraday");
  const { guided, markets } = useProfile();
  const today = useResource(loadToday, [], { pollMs: POLL_MS });
  const grids = useSessionGrids();
  // A tapped dot opens that trade over the page; "waiting" opens the orders that have not filled yet.
  const [picked, setPicked] = useState<TapeTrade | null>(null);
  const [waitingOpen, setWaitingOpen] = useState(false);
  // Open spot and futures results follow the price socket between polls.
  const live = useLivePositions(today.data?.positions);

  if (today.loading) return <Skeleton lines={5} />;
  if (today.error && !today.data) return <ErrorNotice error={today.error} onRetry={today.reload} />;
  if (!today.data) return null;

  const { groups } = today.data;
  const positions = live.positions;
  // Every market has an account, but only the ones the person chose are shown. The everyday book (spot, futures and
  // options) and the positional book are separate balances.
  const cards = (book === "positional" ? today.data.positionalAccounts : today.data.accounts).filter((a) => markets.includes(a.segment));
  const cardRows = cards.map((a) => {
    const delta = liveDeltaFor(today.data!.positions, positions, a.segment, book);
    return { account: a, delta, pnl: bookPnl(positions, groups, a.segment, book) };
  });
  const totalBalance = cardRows.reduce((n, r) => n + r.account.current_balance + r.account.unrealized_pnl + r.delta, 0);
  const totalToday = cardRows.reduce((n, r) => n + r.pnl.total, 0);
  const segments = cards.map((a) => a.segment);
  const tape = tradeTape(positions, groups, book, segments);
  const open = openSummary(positions, groups, book, segments);
  // A waiting order sits in the book its trade will open in (an option order is always everyday).
  const shownWaiting = today.data.waiting.filter((w) => (w.strategy === "naked" || w.strategy === "spread" ? book === "intraday" : (w.horizon ?? "intraday") === book));

  return (
    <div className="stack">
      <div className="tabs" role="group" aria-label="Account">
        {BOOKS.map((b) => (
          <button key={b.id} aria-pressed={book === b.id} onClick={() => setBook(b.id)}>
            {b.label}
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
          <AccountCard key={r.account.segment} segment={r.account.segment} book={book} account={r.account} pnl={r.pnl} liveDelta={r.delta} live={live.live} />
        ))}
      </div>

      {today.error && <ErrorNotice error={today.error} onRetry={today.reload} />}

      <div className="stack today-main">
      <TradeTape tape={tape} book={book} segments={segments} onPick={setPicked} />
      <OpenNow count={open.count} pnl={open.pnl} noStop={open.noStop} waiting={shownWaiting.length} book={book} neverTraded={positions.length + groups.length === 0} onWaiting={() => setWaitingOpen(true)} />

      {/* Once there is a session to show, the last sessions replace the first-week checklist. */}
      {grids.data && hasSessions(grids.data) ? <SessionGrids grids={grids.data} /> : guided && <FirstWeekCard steps={firstWeek(positions, groups)} />}

      {picked && (
        <Sheet label={`${picked.symbol} trade`} onClose={() => setPicked(null)} testId="trade-sheet">
          {(() => {
            const item = picked.kind === "position" ? positions.find((p) => p.id === picked.id) : groups.find((g) => g.id === picked.id);
            if (!item) return null;
            if (picked.open && picked.kind === "position") return <PositionCard kind="position" item={item as Position} onChanged={() => { setPicked(null); today.reload(); }} />;
            if (picked.open) return <PositionCard kind="group" item={item as OptionGroup} onChanged={() => { setPicked(null); today.reload(); }} />;
            return <ClosedTrade trade={item as Position | OptionGroup} onClose={() => setPicked(null)} />;
          })()}
        </Sheet>
      )}
      {waitingOpen && (
        <Sheet label="Orders waiting for a price" onClose={() => setWaitingOpen(false)} testId="waiting-sheet">
          <WaitingOrders orders={shownWaiting} onChanged={today.reload} />
        </Sheet>
      )}
      </div>
    </div>
  );
}

import { useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import type { Book, DisciplineV2, EquityHistory, LiveEligibility, OptionGroup, Performance, Position, Segment } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { SEGMENTS } from "../config";
import { useProfile } from "../auth/ProfileContext";
import { useLivePositions } from "../hooks/useLivePositions";
import { useResource } from "../hooks/useResource";
import { HistoryTab } from "./portfolio/HistoryTab";
import { OverviewTab } from "./portfolio/OverviewTab";
import { PositionsTab } from "./portfolio/PositionsTab";
import { ReviewTab } from "./portfolio/ReviewTab";
import { closedTrades } from "./portfolioModel";
import { groupsApi, positionsApi } from "../api/rupees";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
  { id: "history", label: "History" },
  { id: "review", label: "Review" },
] as const;
// The discipline review is about the everyday habit; the positional book has no Review tab.
const BOOK_TABS = (book: Book) => TABS.filter((t) => book === "intraday" || t.id !== "review");
type TabId = (typeof TABS)[number]["id"];

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };

function parseSegment(v: string | null): Segment {
  return (SEGMENTS as readonly string[]).includes(v ?? "") ? (v as Segment) : "NSE";
}
function parseTab(v: string | null): TabId {
  return TABS.some((t) => t.id === v) ? (v as TabId) : "overview";
}

/** Which book a trade belongs to: a multi-day hold is positional, everything else (and every option spread) is the everyday book. */
const inBook = (p: Pick<Position, "horizon">, book: Book) => (p.horizon === "positional") === (book === "positional");
const groupsIn = (groups: OptionGroup[], book: Book) => (book === "positional" ? [] : groups);

async function loadOpen(segment: Segment, book: Book) {
  const [positions, groups] = await Promise.all([
    positionsApi(`/positions?segment=${segment}&status=OPEN&with_live_pnl=true&limit=200`),
    groupsApi(`/option-groups?segment=${segment}&status=OPEN&with_live_pnl=true&limit=200`),
  ]);
  return { positions: positions.filter((p) => inBook(p, book)), groups: groupsIn(groups, book) };
}

async function loadClosed(segment: Segment, book: Book) {
  const [positions, groups] = await Promise.all([
    positionsApi(`/positions?segment=${segment}&status=CLOSED&limit=300`),
    groupsApi(`/option-groups?segment=${segment}&status=CLOSED&limit=300`),
  ]);
  return closedTrades(positions.filter((p) => inBook(p, book)), groupsIn(groups, book));
}

export function PortfolioPage() {
  const [params, setParams] = useSearchParams();
  const { markets } = useProfile();
  const segment = parseSegment(params.get("segment"));
  // Commodities have no spot, so no positional book: asking for one there shows the everyday account.
  const book: Book = segment !== "MCX" && params.get("book") === "positional" ? "positional" : "intraday";
  const tab = BOOK_TABS(book).some((t) => t.id === params.get("tab")) ? parseTab(params.get("tab")) : "overview";
  const set = (next: Record<string, string>) => setParams({ segment, tab, ...(book === "positional" ? { book } : {}), ...next }, { replace: true });
  const bookQuery = book === "positional" ? "&book=positional" : "";

  // Each block loads on its own so one failing endpoint never blanks the others.
  const equity = useResource(() => api<EquityHistory>("execution", `/equity-history/${segment}?days=90${bookQuery}`), [segment, book]);
  const perf = useResource(() => api<Performance>("execution", `/performance/${segment}${book === "positional" ? "?book=positional" : ""}`), [segment, book]);
  // Discipline and the live-trading graduation are about the everyday account only.
  const discipline = useResource(() => api<DisciplineV2>("execution", `/discipline/${segment}`), [segment], { enabled: book === "intraday" });
  const elig = useResource(() => api<LiveEligibility>("execution", `/live-eligibility/${segment}`), [segment], { enabled: book === "intraday" });
  const closed = useResource(() => loadClosed(segment, book), [segment, book]);
  // A saved tag, note or review changes both the trade list and the numbers derived from it.
  const saved = () => {
    closed.reload();
    perf.reload();
    discipline.reload();
  };
  const open = useResource(() => loadOpen(segment, book), [segment, book], { pollMs: 15_000, enabled: tab === "positions" });
  const live = useLivePositions(tab === "positions" ? open.data?.positions : undefined);

  return (
    <div className="stack">
      <h1>Portfolio</h1>
      <div className="chips" role="group" aria-label="Account">
        {SEGMENTS.filter((s) => markets.includes(s) || s === segment).map((s) => (
          <button key={s} aria-pressed={segment === s} onClick={() => set({ segment: s })}>
            {SEGMENT_LABEL[s]}
          </button>
        ))}
      </div>
      {segment !== "MCX" && (
        <div className="chips" role="group" aria-label="Book">
          <button aria-pressed={book === "intraday"} onClick={() => set({ book: "intraday" })}>
            Everyday
          </button>
          <button aria-pressed={book === "positional"} onClick={() => set({ book: "positional" })}>
            Positional
          </button>
        </div>
      )}
      <div className="chips" role="tablist" aria-label="Portfolio sections">
        {BOOK_TABS(book).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab equity={equity} perf={perf} elig={book === "intraday" ? elig : null} trades={closed.data} book={book} />}
      {tab === "positions" && <PositionsTab open={open} positions={live.positions} live={live.live} />}
      {(tab === "history" || tab === "review") && closed.loading && <Skeleton lines={4} />}
      {(tab === "history" || tab === "review") && closed.error && <ErrorNotice error={closed.error} onRetry={closed.reload} />}
      {tab === "history" && closed.data && <HistoryTab trades={closed.data} onSaved={saved} />}
      {tab === "review" && book === "intraday" && closed.data && <ReviewTab perf={perf} discipline={discipline} trades={closed.data} onSaved={saved} />}
    </div>
  );
}

import { Link, Navigate, useSearchParams } from "react-router-dom";
import { LinkRow } from "../components/nav";
import { api } from "../api/http";
import type { Book, DisciplineV2, EquityHistory, LiveEligibility, MistakeSummary, OptionGroup, Performance, Position, Segment } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { SEGMENTS } from "../config";
import { useProfile } from "../auth/ProfileContext";
import { useLivePositions } from "../hooks/useLivePositions";
import { useResource } from "../hooks/useResource";
import { HistoryTab } from "./portfolio/HistoryTab";
import { OverviewTab } from "./portfolio/OverviewTab";
import { PositionsTab } from "./portfolio/PositionsTab";
import { ReviewTab } from "./portfolio/ReviewTab";
import { closedTrades, unreviewed } from "./portfolioModel";
import { groupsApi, positionsApi } from "../api/rupees";

/** Two pages share this screen: Portfolio is what you hold and have traded (Positions, History); Performance is how you are doing (Overview, Review). */
type View = "portfolio" | "performance";
const TABS = [
  { id: "overview", label: "Overview", view: "performance" },
  { id: "review", label: "Review", view: "performance" },
  { id: "positions", label: "Positions", view: "portfolio" },
  { id: "history", label: "History", view: "portfolio" },
] as const;
const PATH: Record<View, string> = { portfolio: "/portfolio", performance: "/performance" };
// The discipline review is about the everyday habit; the positional book has no Review tab.
const BOOK_TABS = (view: View, book: Book) => TABS.filter((t) => t.view === view && (book === "intraday" || t.id !== "review"));
type TabId = (typeof TABS)[number]["id"];

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };

function parseSegment(v: string | null): Segment {
  return (SEGMENTS as readonly string[]).includes(v ?? "") ? (v as Segment) : "NSE";
}
/** The page a tab belongs to, so an old link (/portfolio?tab=review) still lands on the right one. */
const viewOf = (v: string | null): View | null => TABS.find((t) => t.id === v)?.view ?? null;

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

export const PortfolioPage = () => <BookPage view="portfolio" />;
export const PerformancePage = () => <BookPage view="performance" />;

function BookPage({ view }: { view: View }) {
  const [params, setParams] = useSearchParams();
  const { markets } = useProfile();
  const segment = parseSegment(params.get("segment"));
  // Commodities have no spot, so no positional book: asking for one there shows the everyday account.
  const book: Book = segment !== "MCX" && params.get("book") === "positional" ? "positional" : "intraday";
  const viewTabs = BOOK_TABS(view, book);
  const tab: TabId = viewTabs.find((t) => t.id === params.get("tab"))?.id ?? viewTabs[0].id;
  const owner = viewOf(params.get("tab"));
  const elsewhere = owner && owner !== view ? owner : null; // an old link to a tab that now lives on the other page
  const set = (next: Record<string, string>) => setParams({ segment, tab, ...(book === "positional" ? { book } : {}), ...next }, { replace: true });
  const bookQuery = book === "positional" ? "&book=positional" : "";

  // Each block loads on its own so one failing endpoint never blanks the others.
  const results = view === "performance" && !elsewhere;
  const equity = useResource(() => api<EquityHistory>("execution", `/equity-history/${segment}?days=90${bookQuery}`), [segment, book], { enabled: results });
  const perf = useResource(() => api<Performance>("execution", `/performance/${segment}${book === "positional" ? "?book=positional" : ""}`), [segment, book], { enabled: results });
  // Discipline and the live-trading graduation are about the everyday account only.
  const discipline = useResource(() => api<DisciplineV2>("execution", `/discipline/${segment}`), [segment], { enabled: results && book === "intraday" });
  const mistakes = useResource(() => api<MistakeSummary>("execution", `/trade-review/summary/${segment}`), [segment], { enabled: results && book === "intraday" });
  const elig = useResource(() => api<LiveEligibility>("execution", `/live-eligibility/${segment}`), [segment], { enabled: results && book === "intraday" });
  const closed = useResource(() => loadClosed(segment, book), [segment, book]);
  // A saved tag, note or review changes both the trade list and the numbers derived from it.
  const saved = () => {
    closed.reload();
    if (!results) return;
    perf.reload();
    discipline.reload();
    mistakes.reload();
  };
  const open = useResource(() => loadOpen(segment, book), [segment, book], { pollMs: 15_000, enabled: tab === "positions" });
  const live = useLivePositions(tab === "positions" ? open.data?.positions : undefined);

  if (elsewhere) return <Navigate to={`${PATH[elsewhere]}?${params.toString()}`} replace />;
  const reviewHref = `/performance?segment=${segment}&tab=review${book === "positional" ? "&book=positional" : ""}`;

  return (
    <div className="stack">
      <h1>{view === "portfolio" ? "Portfolio" : "Performance"}</h1>
      {view === "portfolio" ? (
        <LinkRow to={`/performance?segment=${segment}`} title="How you are doing" hint="Results, discipline and what to review" />
      ) : (
        <LinkRow to={`/portfolio?segment=${segment}`} title="Positions and history" hint="What you hold and what you have traded" />
      )}
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
      <div className="chips" role="tablist" aria-label={view === "portfolio" ? "Portfolio sections" : "Performance sections"}>
        {viewTabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      {book === "intraday" && tab !== "review" && closed.data && unreviewed(closed.data).length > 0 && (
        <div className="notice" role="status" data-testid="review-nudge">
          {unreviewed(closed.data).length} closed trade{unreviewed(closed.data).length === 1 ? "" : "s"} not reviewed yet: say what went wrong (or that nothing did).{" "}
          <Link className="btn btn-small" to={reviewHref}>
            Review now
          </Link>
        </div>
      )}
      {tab === "overview" && <OverviewTab equity={equity} perf={perf} elig={book === "intraday" ? elig : null} trades={closed.data} book={book} />}
      {tab === "positions" && <PositionsTab open={open} positions={live.positions} live={live.live} />}
      {(tab === "history" || tab === "review") && closed.loading && <Skeleton lines={4} />}
      {(tab === "history" || tab === "review") && closed.error && <ErrorNotice error={closed.error} onRetry={closed.reload} />}
      {tab === "history" && closed.data && <HistoryTab trades={closed.data} onSaved={saved} />}
      {tab === "review" && book === "intraday" && closed.data && <ReviewTab perf={perf} discipline={discipline} mistakes={mistakes} trades={closed.data} onSaved={saved} />}
    </div>
  );
}

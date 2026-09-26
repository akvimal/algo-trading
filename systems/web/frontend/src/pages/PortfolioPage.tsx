import { useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import type { EquityHistory, LiveEligibility, OptionGroup, Performance, Position, Segment } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { SEGMENTS } from "../config";
import { useResource } from "../hooks/useResource";
import { HistoryTab } from "./portfolio/HistoryTab";
import { OverviewTab } from "./portfolio/OverviewTab";
import { PositionsTab } from "./portfolio/PositionsTab";
import { ReviewTab } from "./portfolio/ReviewTab";
import { closedTrades } from "./portfolioModel";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
  { id: "history", label: "History" },
  { id: "review", label: "Review" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };

function parseSegment(v: string | null): Segment {
  return (SEGMENTS as readonly string[]).includes(v ?? "") ? (v as Segment) : "NSE";
}
function parseTab(v: string | null): TabId {
  return TABS.some((t) => t.id === v) ? (v as TabId) : "overview";
}

async function loadOpen(segment: Segment) {
  const [positions, groups] = await Promise.all([
    api<Position[]>("execution", `/positions?segment=${segment}&status=OPEN&with_live_pnl=true&limit=200`),
    api<OptionGroup[]>("execution", `/option-groups?segment=${segment}&status=OPEN&with_live_pnl=true&limit=200`),
  ]);
  return { positions, groups };
}

async function loadClosed(segment: Segment) {
  const [positions, groups] = await Promise.all([
    api<Position[]>("execution", `/positions?segment=${segment}&status=CLOSED&limit=300`),
    api<OptionGroup[]>("execution", `/option-groups?segment=${segment}&status=CLOSED&limit=300`),
  ]);
  return closedTrades(positions, groups);
}

export function PortfolioPage() {
  const [params, setParams] = useSearchParams();
  const segment = parseSegment(params.get("segment"));
  const tab = parseTab(params.get("tab"));
  const set = (next: Record<string, string>) => setParams({ segment, tab, ...next }, { replace: true });

  // Each block loads on its own so one failing endpoint never blanks the others.
  const equity = useResource(() => api<EquityHistory>("execution", `/equity-history/${segment}?days=90`), [segment]);
  const perf = useResource(() => api<Performance>("execution", `/performance/${segment}`), [segment]);
  const elig = useResource(() => api<LiveEligibility>("execution", `/live-eligibility/${segment}`), [segment]);
  const closed = useResource(() => loadClosed(segment), [segment]);
  const open = useResource(() => loadOpen(segment), [segment], { pollMs: 15_000, enabled: tab === "positions" });

  return (
    <div className="stack">
      <h1>Portfolio</h1>
      <div className="chips" role="group" aria-label="Account">
        {SEGMENTS.map((s) => (
          <button key={s} aria-pressed={segment === s} onClick={() => set({ segment: s })}>
            {SEGMENT_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="chips" role="tablist" aria-label="Portfolio sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab equity={equity} perf={perf} elig={elig} trades={closed.data} />}
      {tab === "positions" && <PositionsTab open={open} />}
      {(tab === "history" || tab === "review") && closed.loading && <Skeleton lines={4} />}
      {(tab === "history" || tab === "review") && closed.error && <ErrorNotice error={closed.error} onRetry={closed.reload} />}
      {tab === "history" && closed.data && <HistoryTab trades={closed.data} />}
      {tab === "review" && closed.data && <ReviewTab perf={perf} trades={closed.data} />}
    </div>
  );
}

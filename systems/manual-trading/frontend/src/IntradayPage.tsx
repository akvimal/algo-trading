import { Suspense, lazy, useState } from "react";

import ManualStatsPage from "./ManualStatsPage";
import TradeChecklistPage from "./TradeChecklistPage";
import WorkspacePage from "./WorkspacePage";

// Lazy so klinecharts (this repo's only charting dependency, ~40KB gzip)
// lands in its own chunk instead of the main bundle - a trader who never
// opens the Live Chart tab never downloads it. See LiveChartPanel.tsx.
const LiveChartPage = lazy(() => import("./LiveChartPage"));

type SubTab = "workspace" | "checklist" | "performance" | "chart";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "checklist", label: "Trade Checklist" },
  { id: "performance", label: "Performance" },
  { id: "chart", label: "Live Chart" },
];

// Intraday - the top-level page for intraday spot/future/option paper
// trading (see docs/architecture.md § "Manual Trading SaaS"). Owns a
// sub-nav across these concerns, split out of one "Manual" tab with a
// 3-way internal view switch - each sub-page fetches its own data
// independently (no shared state lifted here) since only one is ever
// mounted at a time, same pattern App.tsx's own top-level tab switch
// already uses. A 6th sub-page, Dashboard (an "Open positions" summary,
// no order entry), was removed - Workspace is the one landing page now,
// see its own default below. A 7th, "Risk & Accounts", and an 8th, "My
// Credentials", both moved to the Money tab's own "Your account"/
// "Credentials" sections (see docs/architecture.md) - both were always
// execution's/accounts' own data, just with their edit UI parked here;
// WorkspacePage.tsx still reads GET /accounts directly for its own
// Lot-sizing math, unaffected by either move.
export default function IntradayPage() {
  const [subTab, setSubTab] = useState<SubTab>("workspace");

  return (
    <div className="intraday-page">
      <nav className="tabs subtabs">
        {SUB_TABS.map((t) => (
          <button key={t.id} className={subTab === t.id ? "active" : ""} onClick={() => setSubTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {subTab === "workspace" && <WorkspacePage />}
      {subTab === "checklist" && <TradeChecklistPage />}
      {subTab === "performance" && <ManualStatsPage />}
      {subTab === "chart" && (
        <Suspense fallback={<p className="muted">Loading chart...</p>}>
          <LiveChartPage />
        </Suspense>
      )}
    </div>
  );
}

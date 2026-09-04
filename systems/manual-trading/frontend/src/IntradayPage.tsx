import { Suspense, lazy } from "react";

// Lazy so klinecharts (this repo's only charting dependency, ~40KB gzip)
// lands in its own chunk instead of the main bundle. See LiveChartPanel.tsx.
const LiveChartPage = lazy(() => import("./LiveChartPage"));

// Intraday - now just the Live Chart. The Workspace / Trade Checklist
// sub-tabs were dropped 2026-09-03: the inline trade panel beside the
// chart (ChartTradePanel) covers day-to-day order entry + management.
// ManualStatsPage came back 2026-09-04 as its own shell entry
// ("Performance", App.tsx `?tab=performance`) once it grew the by-setup /
// discipline breakdowns. WorkspacePage.tsx / TradeChecklistPage.tsx stay
// in the tree (unrouted, tree-shaken out) - still the only UI for
// SL-limit orders, option trailing SL, partial exits, the review flow.
export default function IntradayPage() {
  return (
    <div className="intraday-page">
      <Suspense fallback={<p className="muted">Loading chart...</p>}>
        <LiveChartPage />
      </Suspense>
    </div>
  );
}

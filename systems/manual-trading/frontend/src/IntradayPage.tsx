import { Suspense, lazy } from "react";

// Lazy so klinecharts (this repo's only charting dependency, ~40KB gzip)
// lands in its own chunk instead of the main bundle. See LiveChartPanel.tsx.
const LiveChartPage = lazy(() => import("./LiveChartPage"));

// Intraday - now just the Live Chart. The Workspace / Trade Checklist /
// Performance sub-tabs were dropped 2026-09-03: the inline trade panel
// beside the chart (ChartTradePanel) covers day-to-day order entry +
// management, and intraday performance is slated to move to a site-wide
// dashboard. WorkspacePage.tsx / TradeChecklistPage.tsx / ManualStatsPage.tsx
// stay in the tree (unrouted, tree-shaken out of the build) - they're
// still the only UI for limit / SL-limit orders, option trailing SL,
// partial exits, and the trade-review flow if any of that is needed again.
export default function IntradayPage() {
  return (
    <div className="intraday-page">
      <Suspense fallback={<p className="muted">Loading chart...</p>}>
        <LiveChartPage />
      </Suspense>
    </div>
  );
}

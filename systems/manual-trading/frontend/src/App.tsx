import { Suspense, lazy } from "react";

import AuthGate from "./AuthGate";
import IntradayPage from "./IntradayPage";
import OiSummaryPage from "./OiSummaryPage";

// Trading Performance - lazy so its trade-list fetch + tables don't weigh
// on the default Intraday page's bundle.
const ManualStatsPage = lazy(() => import("./ManualStatsPage"));
// Standalone price alerts (market-data's price_alerts + Telegram) - same
// lazy-load reasoning.
const PriceAlertsPage = lazy(() => import("./PriceAlertsPage"));

// Split out of signal-generation's frontend (see docs/architecture.md §
// "Manual Trading module split") - Manual Trading and Options OI never
// actually depended on signal-generation's own backend/DB, only on
// execution's and market-data's (see their own components' api.ts calls).
// The notification bell that used to live here (a duplicated
// SignalNotifier) moved to the shell's own top bar instead - one global
// bell instead of one per tab, see shell/index.html. Username/Logout
// moved there too, same reasoning - one shared display instead of a
// duplicated email+button per module. The sentiment badges that used to
// sit alongside the tabs here moved there too (2026-09-01, same
// reasoning) - see shell/index.html's own "Global sentiment indicator"
// section, ported from this module's SentimentBadges.tsx (now deleted).
//
// This frontend's own top-bar tab switch (Intraday / OI) is gone too:
// both are now top-level entries in the shell's own menu, each embedding
// this frontend in its own iframe - "Intraday" at "/", "OI" at "?tab=oi"
// (see shell/index.html's TABS). So App just reads that param once and
// renders the one page; there's no in-app nav to draw anymore.
// "Intraday"/"OI" match the domain's own Horizon concept
// (intraday/positional, "swing" merged into positional) - "Swing Trading"
// and "Positional" are planned future top-level pages, not added yet (see
// docs/architecture.md § "Manual Trading SaaS" Phase 6).
export default function App() {
  const tab = new URLSearchParams(window.location.search).get("tab");

  return (
    <AuthGate>
      <main>
        {tab === "oi" ? (
          <OiSummaryPage />
        ) : tab === "performance" ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ManualStatsPage />
          </Suspense>
        ) : tab === "alerts" ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <PriceAlertsPage />
          </Suspense>
        ) : (
          <IntradayPage />
        )}
      </main>
    </AuthGate>
  );
}

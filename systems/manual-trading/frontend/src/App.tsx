import { useState } from "react";

import AuthGate from "./AuthGate";
import { clearAuthToken, getAuthEmail } from "./auth";
import IntradayPage from "./IntradayPage";
import OiSummaryPage from "./OiSummaryPage";
import { SignalNotifier } from "./SignalNotifier";

// Split out of signal-generation's frontend (see docs/architecture.md §
// "Manual Trading module split") - Manual Trading and Options OI never
// actually depended on signal-generation's own backend/DB, only on
// execution's and market-data's (see their own components' api.ts calls),
// so this module owns just those two tabs plus a duplicated SignalNotifier
// (small enough to copy rather than share - see that file's own comment).
// "Intraday"/"OI" here match the domain's own Horizon concept
// (intraday/positional, "swing" merged into positional) - "Swing Trading"
// and "Positional" are planned future top-level pages, not added yet (see
// docs/architecture.md § "Manual Trading SaaS" Phase 6).
type TabId = "intraday" | "oi";

const VALID_TABS: TabId[] = ["intraday", "oi"];

export default function App() {
  // Deep-link support (?tab=oi) - defaults to Intraday, this module's
  // primary workflow, same convention the old shell quick-jump button
  // relied on before the split (see shell/index.html).
  const [tab, setTab] = useState<TabId>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return (VALID_TABS as string[]).includes(requested ?? "") ? (requested as TabId) : "intraday";
  });

  return (
    <AuthGate>
      <main>
        {/* No page title/header at all - the shell's own nav already labels
            this "Manual Trading" one row above (see shell/index.html), so
            repeating "manual-trading" here was pure redundancy. Tabs and
            the notification toggle share one row instead of the toggle
            getting its own header row above them. */}
        <div className="app-top-row">
          <nav className="tabs">
            <button className={tab === "intraday" ? "active" : ""} onClick={() => setTab("intraday")}>
              Intraday
            </button>
            <button className={tab === "oi" ? "active" : ""} onClick={() => setTab("oi")}>
              OI
            </button>
          </nav>
          <div className="top-row-actions">
            <SignalNotifier />
            <span className="muted">{getAuthEmail()}</span>
            <button
              type="button"
              className="secondary tiny"
              onClick={() => {
                clearAuthToken();
                window.location.reload();
              }}
            >
              Logout
            </button>
          </div>
        </div>

        {tab === "intraday" && <IntradayPage />}
        {tab === "oi" && <OiSummaryPage />}
      </main>
    </AuthGate>
  );
}

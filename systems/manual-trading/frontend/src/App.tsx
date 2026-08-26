import { useState } from "react";

import ManualTab from "./ManualTab";
import OiSummaryPage from "./OiSummaryPage";
import { SignalNotifier } from "./SignalNotifier";

// Split out of signal-generation's frontend (see docs/architecture.md §
// "Manual Trading module split") - Manual Trading and Options OI never
// actually depended on signal-generation's own backend/DB, only on
// execution's and market-data's (see their own components' api.ts calls),
// so this module owns just those two tabs plus a duplicated SignalNotifier
// (small enough to copy rather than share - see that file's own comment).
type TabId = "manual" | "oi";

const VALID_TABS: TabId[] = ["manual", "oi"];

export default function App() {
  // Deep-link support (?tab=oi) - defaults to Manual, this module's
  // primary workflow, same convention the old shell quick-jump button
  // relied on before the split (see shell/index.html).
  const [tab, setTab] = useState<TabId>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return (VALID_TABS as string[]).includes(requested ?? "") ? (requested as TabId) : "manual";
  });

  return (
    <main>
      {/* No page title/header at all - the shell's own nav already labels
          this "Manual Trading" one row above (see shell/index.html), so
          repeating "manual-trading" here was pure redundancy. Tabs and
          the notification toggle share one row instead of the toggle
          getting its own header row above them. */}
      <div className="app-top-row">
        <nav className="tabs">
          <button className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>
            Manual
          </button>
          <button className={tab === "oi" ? "active" : ""} onClick={() => setTab("oi")}>
            Options OI
          </button>
        </nav>
        <SignalNotifier />
      </div>

      {tab === "manual" && <ManualTab />}
      {tab === "oi" && <OiSummaryPage />}
    </main>
  );
}

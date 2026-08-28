import { useCallback, useRef, useState } from "react";

import AuthGate from "./AuthGate";
import IntradayPage from "./IntradayPage";
import OiSummaryPage from "./OiSummaryPage";
import { SentimentBadges } from "./SentimentBadges";

// Split out of signal-generation's frontend (see docs/architecture.md §
// "Manual Trading module split") - Manual Trading and Options OI never
// actually depended on signal-generation's own backend/DB, only on
// execution's and market-data's (see their own components' api.ts calls).
// The notification bell that used to live here (a duplicated
// SignalNotifier) moved to the shell's own top bar instead - one global
// bell instead of one per tab, see shell/index.html. Username/Logout
// moved there too, same reasoning - one shared display instead of a
// duplicated email+button per module.
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

  // Tracks this row's real rendered height into a CSS var so IntradayPage's
  // sub-tab nav (its own sticky header, see index.css's nav.tabs.subtabs)
  // can stick directly below it instead of overlapping - the row's height
  // isn't a fixed number of rem (sentiment badges/notification state can
  // wrap it to different heights), so it's measured rather than guessed.
  // A callback ref rather than useRef+useEffect: this div only actually
  // mounts once AuthGate's own async auth check resolves and it renders
  // {children} for the first time, a commit that happens well after App's
  // own single render/effect pass - a plain effect keyed off an object ref
  // would've already run (and found topRowRef.current still null) by then.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const topRowRef = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    if (!el) return;
    const sync = () => document.documentElement.style.setProperty("--top-row-height", `${el.offsetHeight}px`);
    sync();
    resizeObserverRef.current = new ResizeObserver(sync);
    resizeObserverRef.current.observe(el);
  }, []);

  return (
    <AuthGate>
      <main>
        {/* No page title/header at all - the shell's own nav already labels
            this "Manual Trading" one row above (see shell/index.html), so
            repeating "manual-trading" here was pure redundancy. Tabs and
            the notification toggle share one row instead of the toggle
            getting its own header row above them. */}
        <div className="app-top-row" ref={topRowRef}>
          <nav className="tabs">
            <button className={tab === "intraday" ? "active" : ""} onClick={() => setTab("intraday")}>
              Intraday
            </button>
            <button className={tab === "oi" ? "active" : ""} onClick={() => setTab("oi")}>
              OI
            </button>
          </nav>
          <div className="top-row-actions">
            <SentimentBadges />
          </div>
        </div>

        {tab === "intraday" && <IntradayPage />}
        {tab === "oi" && <OiSummaryPage />}
      </main>
    </AuthGate>
  );
}

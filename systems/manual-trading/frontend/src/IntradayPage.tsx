import { useState } from "react";

import ManualStatsPage from "./ManualStatsPage";
import MyCredentialsPage from "./MyCredentialsPage";
import RiskAccountsPage from "./RiskAccountsPage";
import TradeChecklistPage from "./TradeChecklistPage";
import WorkspacePage from "./WorkspacePage";

type SubTab = "workspace" | "risk" | "credentials" | "checklist" | "performance";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "risk", label: "Risk & Accounts" },
  { id: "credentials", label: "My Credentials" },
  { id: "checklist", label: "Trade Checklist" },
  { id: "performance", label: "Performance" },
];

// Intraday - the top-level page for intraday spot/future/option paper
// trading (see docs/architecture.md § "Manual Trading SaaS"). Owns a
// sub-nav across these concerns, split out of one "Manual" tab with a
// 3-way internal view switch - each sub-page fetches its own data
// independently (no shared state lifted here) since only one is ever
// mounted at a time, same pattern App.tsx's own top-level tab switch
// already uses. A 6th sub-page, Dashboard (an "Open positions" summary,
// no order entry), was removed - Workspace is the one landing page now,
// see its own default below.
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
      {subTab === "risk" && <RiskAccountsPage />}
      {subTab === "credentials" && <MyCredentialsPage />}
      {subTab === "checklist" && <TradeChecklistPage />}
      {subTab === "performance" && <ManualStatsPage />}
    </div>
  );
}

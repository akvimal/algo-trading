import { useState } from "react";

import AccountsPage from "./AccountsPage";
import AuthGate from "./AuthGate";
import PositionsPage from "./PositionsPage";

type TabId = "positions" | "accounts";
const VALID_TABS: TabId[] = ["positions", "accounts"];

// "?view=accounts" still seeds the initial tab (a plain link can still
// deep-link into Accounts), but switching between them is now a client-
// side state change - same convention every other frontend's own top nav
// already uses (signal-engine/manual-trading) - not the full-page reload
// the old <a href="/?view=accounts"> pair caused, which was the one tab
// switch in this app that didn't behave like every other tab elsewhere.
export default function App() {
  const [tab, setTab] = useState<TabId>(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    return (VALID_TABS as string[]).includes(requested ?? "") ? (requested as TabId) : "positions";
  });

  return (
    <AuthGate>
      <main>
        <div className="app-top-row">
          <nav className="tabs">
            <button type="button" className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>
              Positions
            </button>
            <button type="button" className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}>
              Accounts
            </button>
          </nav>
        </div>
        {tab === "positions" && <PositionsPage />}
        {tab === "accounts" && <AccountsPage />}
      </main>
    </AuthGate>
  );
}

import AccountsPage from "./AccountsPage";
import AuthGate from "./AuthGate";
import PositionsPage from "./PositionsPage";

// No router library - just a "?view=accounts" query param and plain <a>
// navigation (full reload), same pattern already used for the
// "?signal_id=" deep link. Two pages don't warrant more than that.
export default function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  return <AuthGate>{() => (view === "accounts" ? <AccountsPage /> : <PositionsPage />)}</AuthGate>;
}

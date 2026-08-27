import { clearAuthToken, getAuthEmail } from "./auth";

export default function Nav({ active }: { active: "positions" | "accounts" }) {
  const email = getAuthEmail();
  return (
    <nav className="nav-tabs">
      <a className={`nav-tab ${active === "positions" ? "active" : ""}`} href="/">
        Positions
      </a>
      <a className={`nav-tab ${active === "accounts" ? "active" : ""}`} href="/?view=accounts">
        Accounts
      </a>
      {email && <span className="muted">{email}</span>}
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
    </nav>
  );
}

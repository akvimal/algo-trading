export default function Nav({ active }: { active: "positions" | "accounts" }) {
  return (
    <nav className="nav-tabs">
      <a className={`nav-tab ${active === "positions" ? "active" : ""}`} href="/">
        Positions
      </a>
      <a className={`nav-tab ${active === "accounts" ? "active" : ""}`} href="/?view=accounts">
        Accounts
      </a>
    </nav>
  );
}

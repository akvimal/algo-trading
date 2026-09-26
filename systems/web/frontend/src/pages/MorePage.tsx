import { Link } from "react-router-dom";
import { CLASSIC_APP_URL } from "../config";
import { useAuth } from "../auth/AuthContext";

export function MorePage() {
  const { session, signOut } = useAuth();
  return (
    <div className="stack">
      <h1>More</h1>
      <div className="card">
        <div className="row">
          <div>
            <div className="dim" style={{ fontSize: 13 }}>
              Signed in as
            </div>
            <strong>{session?.email ?? "your account"}</strong>
          </div>
          <button className="btn btn-small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
      <div className="card">
        <Link to="/more/settings" className="list-row" style={{ textDecoration: "none", color: "inherit", minHeight: "var(--tap)", alignItems: "center" }}>
          <span>
            <strong>Settings</strong>
            <span className="dim" style={{ display: "block", fontSize: 13 }}>
              Risk limits, your Dhan connection and live trading
            </span>
          </span>
          <span aria-hidden="true">›</span>
        </Link>
      </div>
      <div className="card">
        <p style={{ marginTop: 0 }}>Alerts and the rest are still in the classic app while this one is built out.</p>
        <a className="btn" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }} href={CLASSIC_APP_URL}>
          Open classic app
        </a>
      </div>
    </div>
  );
}

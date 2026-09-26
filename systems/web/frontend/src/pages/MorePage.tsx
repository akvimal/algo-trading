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
        <p style={{ marginTop: 0 }}>Settings, Dhan keys, alerts and the rest are still in the classic app while this one is built out.</p>
        <a className="btn" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }} href={CLASSIC_APP_URL}>
          Open classic app
        </a>
      </div>
    </div>
  );
}

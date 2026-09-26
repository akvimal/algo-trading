import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import type { Segment } from "../api/types";
import { SEGMENT_CHOICES } from "./onboardingModel";
import { useProfile } from "../auth/ProfileContext";
import { CLASSIC_APP_URL } from "../config";
import { useAuth } from "../auth/AuthContext";

export function MorePage() {
  const { session, signOut } = useAuth();
  const { profile, guided, markets, update } = useProfile();
  const [error, setError] = useState<string | null>(null);

  async function choose(experience: "guided" | "pro") {
    setError(null);
    try {
      await update({ experience });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    }
  }

  async function toggleMarket(seg: Segment) {
    const next = markets.includes(seg) ? markets.filter((m) => m !== seg) : [...markets, seg];
    if (next.length === 0) return setError("Keep at least one market.");
    setError(null);
    try {
      await update({ markets: next });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    }
  }

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
      {profile && (
        <div className="card">
          <strong>Experience</strong>
          <div className="chips" role="radiogroup" aria-label="Experience" style={{ margin: "8px 0" }}>
            <button role="radio" aria-checked={guided} onClick={() => void choose("guided")}>
              Guided
            </button>
            <button role="radio" aria-checked={!guided} onClick={() => void choose("pro")}>
              Pro
            </button>
          </div>
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>
            {guided ? "Guided adds plain-English hints on the trade ticket and a first-week checklist on Today." : "Pro hides the hints and the first-week checklist."}
          </p>
          {error && (
            <div className="notice error" role="alert" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
      )}
      {profile && (
        <div className="card">
          <strong>Markets you practise</strong>
          <p className="dim" style={{ margin: "2px 0 8px", fontSize: 13 }}>
            Only these count towards your balance and totals. Set each one's rules in Settings.
          </p>
          {SEGMENT_CHOICES.map((s) => (
            <label key={s.id} className="check" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={markets.includes(s.id)} onChange={() => void toggleMarket(s.id)} />
              <span>{s.title}</span>
            </label>
          ))}
        </div>
      )}
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

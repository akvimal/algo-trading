import { useState } from "react";
import { LinkRow } from "../components/nav";
import { ApiError } from "../api/http";
import type { Segment } from "../api/types";
import { SEGMENT_CHOICES } from "./onboardingModel";
import { useProfile } from "../auth/ProfileContext";
import { useAuth } from "../auth/AuthContext";

export function MorePage() {
  const { session, signOut } = useAuth();
  const { profile, guided, markets, defaultsFor, update } = useProfile();
  const [error, setError] = useState<string | null>(null);
  const [tradeError, setTradeError] = useState<string | null>(null);

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

  async function chooseDefault(segment: Segment, instrument: "future" | "option", optionStrategy: "naked" | "spread") {
    setTradeError(null);
    try {
      await update({ segment_defaults: { [segment]: { instrument, option_strategy: optionStrategy } } });
    } catch (e) {
      setTradeError(e instanceof ApiError ? e.message : "Could not save. Try again.");
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
      {profile && (
        <div className="card">
          <strong>Default trade instrument</strong>
          <p className="dim" style={{ margin: "2px 0 8px", fontSize: 13 }}>
            What the trade ticket starts on for a fresh instrument in each market, where options exist.
          </p>
          {SEGMENT_CHOICES.filter((c) => markets.includes(c.id)).map((c) => {
            const d = defaultsFor(c.id);
            return (
              <div key={c.id} style={{ margin: "10px 0" }}>
                <div className="dim" style={{ fontSize: 13 }}>{c.id} · {c.title}</div>
                <div className="chips" role="radiogroup" aria-label={`${c.id} default instrument`} style={{ margin: "4px 0" }}>
                  <button role="radio" aria-checked={d.instrument === "future"} onClick={() => void chooseDefault(c.id, "future", d.optionStrategy)}>
                    Future
                  </button>
                  <button role="radio" aria-checked={d.instrument === "option"} onClick={() => void chooseDefault(c.id, "option", d.optionStrategy)}>
                    Option
                  </button>
                </div>
                {d.instrument === "option" && (
                  <div className="chips" role="radiogroup" aria-label={`${c.id} default option strategy`} style={{ margin: "4px 0" }}>
                    <button role="radio" aria-checked={d.optionStrategy === "naked"} onClick={() => void chooseDefault(c.id, "option", "naked")}>
                      Naked
                    </button>
                    <button role="radio" aria-checked={d.optionStrategy === "spread"} onClick={() => void chooseDefault(c.id, "option", "spread")}>
                      Spread
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {tradeError && (
            <div className="notice error" role="alert" style={{ marginTop: 8 }}>
              {tradeError}
            </div>
          )}
        </div>
      )}
      <div className="card more-phone-only">
        <LinkRow to="/markets" title="Markets" hint="Pre-market bias, headlines, the calendar and open interest" />
      </div>
      <div className="card more-phone-only">
        <LinkRow to="/performance" title="Performance" hint="Equity, results, discipline and the review of your closed trades" />
      </div>
      <div className="card more-phone-only">
        <LinkRow to="/learn" title="Learn" hint="Are you ready for live trading, which habit to fix next, and the path from the basics" />
      </div>
      <div className="card more-phone-only">
        <LinkRow to="/more/settings" title="Settings" hint="Risk limits, your Dhan connection and live trading" />
      </div>
      <div className="card">
        <LinkRow to="/scan?tab=reads" title="Saved stock reads" hint="The AI business read of every stock you have analysed, to look up again" />
      </div>
      <div className="card">
        <LinkRow to="/more/alerts" title="Price alerts" hint="Price alerts and daily Telegram messages: the pre-market bias and strong OI buildups, even with the app closed" />
      </div>
      <div className="card">
        <LinkRow to="/more/notes" title="Notes" hint="Your thoughts and plans on each instrument, with snapshots" />
      </div>
      <div className="card">
        <LinkRow to="/more/swing-shadow" title="Swing shadow" hint="A paper log of what a 1-3 day open-interest swing bot would have done each night, and how it turned out" />
        <LinkRow to="/more/strategies" title="Strategies" hint="Rules, indicators, watchlists and signals for webhook and in-house strategies" />
      </div>
      {session?.isAdmin && (
        <div className="card">
          <LinkRow to="/more/ai-models" title="AI models" hint="Which model runs the news digest, the pre-market bias and the OI read: the same for all, or one each" />
        </div>
      )}
      {session?.isAdmin && (
        <div className="card">
          <LinkRow to="/more/jobs" title="Background jobs" hint="The nightly snapshots and other scheduled jobs: running now, last run, next run" />
        </div>
      )}
    </div>
  );
}

import type { Credential } from "../api/types";
import { LEVEL_WORD, credentialLine, credentialProgress, lapseLine } from "../pages/disciplineModel";

/** The credentials shelf: habits, each earned over a run of trades and lost again if the run breaks, with Bronze, Silver and Gold
 * levels. Motivation only - nothing here is connected to going live, to profit or to how often you trade, and a day off never breaks a
 * run. Deliberately quiet: no celebration on a win, and the first one on the shelf is the habit of accepting a loss as planned. */
export function CredentialsShelf({ credentials }: { credentials: Credential[] }) {
  if (credentials.length === 0) return null;
  return (
    <div className="card" data-testid="credentials-shelf">
      <h2 className="section-title" style={{ margin: "0 0 4px" }}>
        Credentials
      </h2>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Habits earned over a run of trades, and lost again if the run breaks. They reward how you trade, never what you made, and they do not affect going live.
      </p>
      {credentials.map((c) => {
        const lapse = lapseLine(c);
        return (
          <div key={c.key} style={{ marginBottom: 14 }} data-testid={`credential-${c.key}`}>
            <div className="row">
              <strong>{c.label}</strong>
              <span className={`pill ${c.level ? "up" : ""}`}>{c.level ? LEVEL_WORD[c.level] : "Not yet"}</span>
            </div>
            {c.available && (
              <div className="bar" role="meter" aria-label={c.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={credentialProgress(c)}>
                <i style={{ width: `${credentialProgress(c)}%` }} />
              </div>
            )}
            <div className="faint" style={{ fontSize: 12 }}>
              {credentialLine(c)}
              {c.available && c.next_level && c.next_at != null && c.key !== "calm_under_pressure" ? ` Next: ${LEVEL_WORD[c.next_level]}.` : ""}
            </div>
            <div className="faint" style={{ fontSize: 12 }}>{c.blurb}</div>
            {lapse && <div style={{ fontSize: 12, color: "var(--warn)" }}>{lapse}</div>}
          </div>
        );
      })}
    </div>
  );
}

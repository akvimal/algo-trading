import type { DisciplineV2 } from "../api/types";
import type { Resource } from "../hooks/useResource";
import { formatDay, formatPnl } from "../format";
import { disciplineBand } from "../pages/portfolioModel";
import { EMOTION_ROWS, EXIT_WORDS, mistakeWord, topMistakes, whatIfText } from "../pages/disciplineModel";
import { DisciplineGauge } from "./DisciplineGauge";
import { ErrorNotice, Signed, Skeleton } from "./bits";

const BAND_TEXT = { none: "Not enough trades yet", low: "Needs work", fair: "Getting there", good: "Good" } as const;

/** The discipline score: how the last 20 trades were PLANNED and MANAGED, split into greed, fear and patience. It never looks at
 * profit - a clean loss counts as well as a clean win - so what it asks for is habits, which is what changes results over time. */
export function DisciplineCard({ resource }: { resource: Resource<DisciplineV2> }) {
  const d = resource.data;
  const band = d ? disciplineBand(d.score) : "none";
  return (
    <div className="card" data-testid="discipline-card">
      <h2 className="section-title" style={{ margin: "0 0 8px" }}>
        Discipline
      </h2>
      {resource.loading && !d && <Skeleton lines={3} />}
      {resource.error && <ErrorNotice error={resource.error} onRetry={resource.reload} />}
      {d && (
        <>
          <div className="row" style={{ alignItems: "center", gap: 16 }}>
            <DisciplineGauge score={d.score} size={84} />
            <div>
              <span className={`pill ${band === "good" ? "up" : band === "low" ? "dn" : ""}`}>{BAND_TEXT[band]}</span>
              <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>
                {d.score == null
                  ? `Needs at least 5 closed trades. You have ${d.trade_count}.`
                  : `Your last ${d.trade_count} trades. Process, not profit: a clean loss counts as well as a clean win.`}
              </p>
            </div>
          </div>

          <div style={{ marginTop: 12 }} />
          {EMOTION_ROWS.map((r) => {
            const value = d.emotions[r.key];
            return (
              <div key={r.key} style={{ marginBottom: 12 }}>
                <div className="row">
                  <span>{r.label}</span>
                  <span className="num">{value == null ? "–" : `${value}%`}</span>
                </div>
                <div className="bar" role="meter" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0}>
                  <i style={{ width: `${value ?? 0}%` }} />
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {r.help}
                </div>
              </div>
            );
          })}

          {d.coaching && (
            <div className="notice" role="note" data-testid="coaching-line">
              <strong>This week</strong>
              <p style={{ margin: "4px 0 0" }}>{d.coaching.line}</p>
            </div>
          )}

          {topMistakes(d).length > 0 && (
            <div className="chips" aria-label="Most common mistakes" style={{ marginTop: 10 }}>
              {topMistakes(d).map((m) => (
                <span key={m.key} className="pill">
                  {mistakeWord(m.key)} · {m.count}
                </span>
              ))}
            </div>
          )}

          {d.trades.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary>Recent trades</summary>
              <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }} data-testid="discipline-trades">
                {d.trades.slice(0, 8).map((t) => {
                  const what = whatIfText(t.what_if);
                  return (
                    <li key={t.id} className="check-item" style={{ display: "block", marginBottom: 8 }}>
                      <div className="row">
                        <span>
                          <strong>{t.symbol}</strong> <span className={`pill ${t.action === "BUY" ? "up" : "dn"}`}>{t.action}</span>{" "}
                          <span className="faint">{formatDay(t.exit_time)}</span>
                        </span>
                        <span className="num">{t.score == null ? "–" : `${t.score}`}</span>
                      </div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {t.exit_kind ? EXIT_WORDS[t.exit_kind] ?? t.exit_kind : "Closed"}
                        {t.pnl != null && (
                          <>
                            {" · "}
                            <Signed value={t.pnl} text={formatPnl(t.pnl)} />
                          </>
                        )}
                        {t.mistakes.length > 0 ? ` · ${t.mistakes.map(mistakeWord).join(", ")}` : ""}
                      </div>
                      {what && (
                        <div style={{ fontSize: 12, color: "var(--warn)" }} data-testid="what-if">
                          {what}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

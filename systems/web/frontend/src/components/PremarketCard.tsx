import { useState } from "react";
import { getPremarket, refreshPremarket } from "../api/premarket";
import { ApiError } from "../api/http";
import type { PremarketReport } from "../api/types";
import { formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { BIAS_LABEL, formatMove, headline, moveTone, reportAge, sections } from "../pages/premarketModel";
import { ErrorNotice, Skeleton } from "./bits";

const BIAS_PILL = { bullish: "pill up", bearish: "pill dn", neutral: "pill" } as const;

/** The morning read for the Indian session: the overnight inputs (GIFT Nifty gap, US close, crude, USD/INR, yields,
 * ADRs), scored by fixed rules and read by an AI model. Both calls are shown, and the card says when they disagree,
 * because the rules are the checkable part. Context for the day, not a recommendation. */
export function PremarketCard() {
  const report = useResource(getPremarket, [], { pollMs: 5 * 60_000 });
  const [fresh, setFresh] = useState<PremarketReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setRefreshError(null);
    try {
      setFresh(await refreshPremarket());
    } catch (e) {
      setRefreshError(e instanceof ApiError ? e.message : "Could not refresh. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // A manual refresh is newer than whatever the poll last fetched, until the poll catches up.
  const data = fresh && (!report.data || fresh.generated_at >= report.data.generated_at) ? fresh : report.data;

  return (
    <>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Pre-market
        </h2>
        <button className="btn btn-small" onClick={refresh} disabled={busy} aria-label="Refresh the pre-market report">
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {report.loading && <Skeleton lines={3} />}
      {report.error && !data && <ErrorNotice error={report.error} onRetry={report.reload} />}
      {refreshError && <div className="notice" role="alert">{refreshError}</div>}
      {!report.loading && !report.error && !data && (
        <div className="card">
          <p className="dim" style={{ margin: 0 }}>
            No pre-market report yet. It is built each weekday at 8:45 AM, or press Refresh to build one now.
          </p>
        </div>
      )}
      {data && <Report report={data} />}
    </>
  );
}

function Report({ report }: { report: PremarketReport }) {
  const age = reportAge(report);
  const ai = report.ai;
  return (
    <div className="card stack">
      <div className="premarket-head">
        <span className={`${BIAS_PILL[report.bias]} premarket-bias`} data-testid="premarket-bias">
          {BIAS_LABEL[report.bias]}
        </span>
        {ai && <span className="dim">{ai.confidence}% confident</span>}
        <span className={age.stale ? "pill warn" : "faint"} style={{ marginLeft: "auto", fontSize: 12 }}>
          {age.stale ? `Older report · ${age.text}` : age.text}
        </span>
      </div>

      <p className="premarket-headline">{headline(report)}</p>

      {report.agree === false && (
        <div className="notice" data-testid="premarket-disagree">
          The fixed rules read this as <b>{BIAS_LABEL[report.rules.bias].toLowerCase()}</b> (score {report.rules.score.toFixed(2)}), the AI as{" "}
          <b>{BIAS_LABEL[report.bias].toLowerCase()}</b>. When they differ, treat the call as lower conviction.
        </div>
      )}
      {report.ai_error && <span className="faint" style={{ fontSize: 12 }}>{report.ai_error}</span>}
      {report.rules.coverage < 1 && (
        <span className="faint" style={{ fontSize: 12 }}>
          Based on {Math.round(report.rules.coverage * 100)}% of the inputs. Some could not be loaded.
        </span>
      )}

      <details>
        <summary className="premarket-toggle">Reasoning and numbers</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          {ai && (
            <>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {ai.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {ai.risks.length > 0 && (
                <div>
                  <span className="dim">What could make this wrong</span>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {ai.risks.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <span className="dim">Watch at the open: </span>
                {ai.watch}
              </div>
            </>
          )}
          {sections(report.inputs).map((s) => (
            <div key={s.title}>
              <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
                {s.title}
              </div>
              {s.inputs.map((i) => (
                <div className="row" key={i.key}>
                  <span>{i.label}</span>
                  <span className="num">
                    {i.ok && i.value != null ? formatPrice(i.value) : "–"}{" "}
                    <span className={moveTone(i)}>{formatMove(i)}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
          <span className="faint" style={{ fontSize: 12 }}>
            Overnight context from public market data{report.model ? `, read by ${report.model}` : ""}. It is not a recommendation.
            Colours show whether a move helps or hurts Indian equities, so a rise in crude or yields is red.
          </span>
        </div>
      </details>
    </div>
  );
}

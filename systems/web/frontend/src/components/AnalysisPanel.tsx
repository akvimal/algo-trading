import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { getAnalysis, screenshotUrl, type StockAnalysis } from "../api/analysis";
import { formatDay, formatPrice } from "../format";
import { AGREEMENT_LABEL, AGREEMENT_TONE, BIAS_ARROW, BIAS_WORD, biasTone, ladder, percent, readAge } from "./analysisModel";

/** "AI analysis" for one stock on a scan card. Nothing happens until the button is pressed: the first read of a stock opens its screener.in page
 * and asks an AI (up to about a minute, on the person's own OpenRouter key); after that it is quick. It shows ONE verdict first (what the chart and
 * the business say together, and whether they agree), then the two sides next to each other, then where the price sits between support and
 * resistance, with every individual signal one tap further. */
export function AnalysisPanel({ symbol }: { symbol: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [data, setData] = useState<StockAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load(refresh: boolean) {
    setState("loading");
    setError(null);
    setNote(null);
    const before = data?.fundamental.fetched_at ?? null;
    try {
      const out = await getAnalysis(symbol, refresh);
      setData(out);
      setState("done");
      // A page read less than a day ago is not captured again: say so, so a Refresh that changed nothing does not look broken.
      if (refresh && out.fundamental.available && out.fundamental.fetched_at === before) setNote("The business read was kept as it was: a page read less than a day ago is not captured again.");
    } catch (e) {
      setState(data ? "done" : "error");
      setError(e instanceof ApiError ? e.message : "Could not load the analysis. Try again.");
    }
  }

  if (state === "idle") {
    return (
      <div style={{ margin: "6px 0 0" }}>
        <button className="btn btn-small" onClick={() => void load(false)}>
          AI analysis
        </button>
      </div>
    );
  }

  const v = data?.verdict;
  const tone = biasTone(v?.bias ?? null);
  const f = data?.fundamental;
  const t = data?.technical;

  return (
    <div className="card analysis stack" data-testid="analysis">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <strong>{symbol} · AI analysis</strong>
        {data && <span className="faint" style={{ fontSize: 12 }}>price {formatPrice(data.price)} · {formatDay(data.as_of)}</span>}
      </div>

      {state === "loading" && (
        <p className="faint" role="status" style={{ margin: 0 }}>
          Reading the chart and the company's screener.in page… the first time for a stock this can take up to a minute.
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}{" "}
          <button className="link-btn" onClick={() => void load(false)}>
            Try again
          </button>
        </div>
      )}

      {data && v && t && f && (
        <>
          <div className={`analysis-verdict ${tone}`} data-testid="analysis-verdict">
            <div className="analysis-headline">{v.headline}</div>
            <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <span className={`pill ${AGREEMENT_TONE[v.agreement]}`} data-testid="analysis-agreement">
                {AGREEMENT_LABEL[v.agreement]}
              </span>
              <span className={`pill ${tone}`}>
                Overall {BIAS_ARROW[v.bias]} {BIAS_WORD[v.bias]}
                {v.confidence > 0 ? ` · ${percent(v.confidence)}` : ""}
              </span>
            </div>
            <p className="dim" style={{ margin: "6px 0 0", fontSize: 13 }}>
              {v.reading}
            </p>
          </div>

          <div className="analysis-cols">
            <section aria-label="The chart" className="analysis-col">
              <div className="analysis-col-head">
                <strong>The chart</strong>
                <span className={`pill ${biasTone(t.bias)}`}>
                  {BIAS_ARROW[t.bias]} {BIAS_WORD[t.bias]}
                  {t.confidence > 0 ? ` · ${percent(t.confidence)}` : ""}
                </span>
              </div>
              <ul className="analysis-list">
                {t.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </section>

            <section aria-label="The business" className="analysis-col">
              <div className="analysis-col-head">
                <strong>The business</strong>
                {f.available && f.bias && (
                  <span className={`pill ${biasTone(f.bias)}`}>
                    {BIAS_ARROW[f.bias]} {BIAS_WORD[f.bias]}
                    {f.confidence != null ? ` · ${percent(f.confidence)}` : ""}
                  </span>
                )}
              </div>
              {f.available ? (
                <>
                  {f.summary && <p style={{ margin: "0 0 6px", fontSize: 13 }}>{f.summary}</p>}
                  {f.pros.length > 0 && (
                    <ul className="analysis-list good" aria-label="Strengths">
                      {f.pros.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  )}
                  {f.cons.length > 0 && (
                    <ul className="analysis-list bad" aria-label="Concerns">
                      {f.cons.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                  {f.note ?? "The business read is not available right now."}{" "}
                  {f.needs_key && <Link to="/more/settings?tab=broker">Add your key in Settings</Link>}
                </p>
              )}
            </section>
          </div>

          {(t.support.length > 0 || t.resistance.length > 0) && (
            <div className="analysis-ladder" aria-label="Where the price sits" data-testid="analysis-ladder">
              {ladder(data).map((r, i) => (
                <div key={i} className={`ladder-row ${r.kind}`}>
                  <span className="ladder-label">{r.kind === "price" ? "● Price now" : `${r.kind === "resistance" ? "▲" : "▼"} ${r.label}`}</span>
                  <span className="num">{r.kind === "price" ? formatPrice(r.low) : `${formatPrice(r.low)} – ${formatPrice(r.high)}`}</span>
                  <span className="faint num ladder-dist">{r.distancePct == null ? "" : `${r.distancePct > 0 ? "+" : "−"}${Math.abs(r.distancePct).toFixed(1)}%`}</span>
                </div>
              ))}
            </div>
          )}

          <details className="analysis-more">
            <summary className="faint" style={{ fontSize: 13, cursor: "pointer" }}>
              Every signal behind it ({data.signals.length}{f.reasons.length ? ` + ${f.reasons.length} business reasons` : ""})
            </summary>
            <ul className="analysis-list" style={{ marginTop: 6 }}>
              {data.signals.map((s, i) => (
                <li key={i}>
                  <span className={biasTone(s.direction)}>{s.direction ? BIAS_ARROW[s.direction] : "·"}</span> <span className="faint">{s.category.replace("_", " ")}:</span> {s.text}
                </li>
              ))}
              {f.reasons.map((r, i) => (
                <li key={`r${i}`}>
                  <span className={biasTone(f.bias)}>{f.bias ? BIAS_ARROW[f.bias] : "·"}</span> <span className="faint">business:</span> {r}
                </li>
              ))}
            </ul>
          </details>

          <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 10 }}>
            {f.available && f.fetched_at && (
              <span className="faint" style={{ fontSize: 12 }}>
                Business read from screener.in {readAge(f.fetched_at)}
              </span>
            )}
            <button className="link-btn" disabled={state === "loading"} onClick={() => void load(true)}>
              Refresh
            </button>
            {f.available && (
              <a className="link-btn" href={screenshotUrl(symbol)} target="_blank" rel="noopener noreferrer" title="The page the AI read">
                See what the AI read ↗
              </a>
            )}
          </div>
          {note && (
            <div className="faint" style={{ fontSize: 12 }} role="status">
              {note}
            </div>
          )}
          <div className="faint" style={{ fontSize: 11 }}>The chart read is rules on weekly and daily prices; the business read is an AI summary of a public web page. Either can be wrong or out of date. Not advice.</div>
        </>
      )}
    </div>
  );
}

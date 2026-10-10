import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { OPENROUTER_KEY_REQUIRED, fundamentalsScreenshotUrl, getFundamentals, type Fundamentals } from "../api/fundamentals";
import { formatDay } from "../format";

const BIAS_CLASS: Record<Fundamentals["bias"], string> = { bullish: "up", bearish: "dn", neutral: "" };

/** How old a read is, in a few words ("today", "3 days ago"). */
export function readAge(fetchedAt: string | null, now: Date = new Date()): string {
  if (!fetchedAt) return "";
  const days = Math.floor((now.getTime() - new Date(fetchedAt).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** "Fundamentals" for one stock on a scan card: nothing happens until the button is pressed, because the first read of a stock opens a
 * web page and asks an AI (up to about a minute, and it uses the person's own OpenRouter key). It then shows the AI's read of the
 * company's screener.in page: a bias, a short summary, the page's own pros and cons, and how old the read is. */
export function FundamentalsPanel({ symbol }: { symbol: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [data, setData] = useState<Fundamentals | null>(null);
  const [error, setError] = useState<{ message: string; needsKey: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load(refresh: boolean) {
    setState("loading");
    setError(null);
    setNote(null);
    try {
      const out = await getFundamentals(symbol, refresh);
      setData(out);
      setState("done");
      if (refresh && !out.refreshed) setNote("This read is less than a day old, so it was not captured again.");
    } catch (e) {
      setState(data ? "done" : "error");
      setError({ message: e instanceof ApiError ? e.message : "Could not load the fundamentals. Try again.", needsKey: e instanceof ApiError && e.code === OPENROUTER_KEY_REQUIRED });
    }
  }

  if (state === "idle") {
    return (
      <div style={{ margin: "6px 0 0" }}>
        <button className="btn btn-small" onClick={() => void load(false)}>
          Fundamentals (AI)
        </button>
      </div>
    );
  }

  return (
    <div className="card stack" style={{ marginTop: 8 }} data-testid="fundamentals">
      <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <strong>{symbol} fundamentals</strong>
        {data && (
          <>
            <span className={`pill ${BIAS_CLASS[data.bias]}`}>{data.bias}</span>
            {data.confidence != null && <span className="faint">{Math.round(data.confidence * 100)}% sure</span>}
          </>
        )}
      </div>

      {state === "loading" && (
        <p className="faint" role="status" style={{ margin: 0 }}>
          Reading the company's screener.in page… the first time for a stock this can take up to a minute.
        </p>
      )}

      {error && (
        <div className="notice error" role="alert">
          {error.message}{" "}
          {error.needsKey ? (
            <Link to="/more/settings?tab=broker">Add your key in Settings</Link>
          ) : (
            <button className="link-btn" onClick={() => void load(false)}>
              Try again
            </button>
          )}
        </div>
      )}

      {data && (
        <>
          {data.summary && <p style={{ margin: 0 }}>{data.summary}</p>}
          {data.pros.length > 0 && (
            <div>
              <span className="dim" style={{ fontSize: 12 }}>Pros</span>
              <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                {data.pros.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {data.cons.length > 0 && (
            <div>
              <span className="dim" style={{ fontSize: 12 }}>Cons</span>
              <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                {data.cons.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {data.reasons.length > 0 && <div className="faint" style={{ fontSize: 12 }}>Why: {data.reasons.join(" · ")}</div>}
          <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 10 }}>
            <span className="faint" style={{ fontSize: 12 }}>
              Read from screener.in {readAge(data.fetched_at)}{data.fetched_at ? ` (${formatDay(data.fetched_at)})` : ""}
            </span>
            <button className="link-btn" disabled={state === "loading"} onClick={() => void load(true)}>
              Refresh
            </button>
            <a className="link-btn" href={fundamentalsScreenshotUrl(symbol)} target="_blank" rel="noopener noreferrer" title="The page the AI read">
              See what the AI read ↗
            </a>
          </div>
          {note && <div className="faint" style={{ fontSize: 12 }} role="status">{note}</div>}
          <div className="faint" style={{ fontSize: 11 }}>An AI summary of a public web page: it can be out of date or wrong. Not advice.</div>
        </>
      )}
    </div>
  );
}

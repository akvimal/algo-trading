import { useEffect, useState } from "react";

import { type NewsDigest, fetchNews } from "./api";
import { formatCompact } from "./manualOrder";

// News tab inside ChartTradePanel - an AI trend-relevance digest for the
// chart's current underlying (server-side cache in market-data's
// app/providers/news.py: marketaux.com for raw headlines, OpenRouter for
// the bias/relevance analysis on top). Polls gently on an interval so a
// cache refresh over there eventually shows up here without the user
// having to switch tabs - cheap since it's just re-reading market-data's
// own cache, not spending marketaux/OpenRouter quota per poll.
const POLL_MS = 3 * 60 * 1000;

const BIAS_LABEL: Record<NewsDigest["bias"], string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

export default function NewsPanel({ underlying, segment }: { underlying: string; segment: string }) {
  const [digest, setDigest] = useState<NewsDigest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const d = await fetchNews(underlying, segment);
        if (!cancelled) {
          setDigest(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    setDigest(null);
    setError(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [underlying, segment]);

  if (error) return <p className="ctp-news-error muted">Couldn't load news: {error}</p>;
  if (digest === null) return <p className="muted">Loading news…</p>;

  return (
    <div className="ctp-news">
      <div className={`ctp-news-digest ctp-news-bias-${digest.bias}`}>
        <div className="ctp-news-digest-head">
          <span className="ctp-news-bias-badge">{BIAS_LABEL[digest.bias]}</span>
          <span className="muted">{digest.bias_reason}</span>
        </div>
        <p className="ctp-news-digest-text">{digest.digest}</p>
      </div>

      {digest.articles.length === 0 && <p className="muted">No recent news for {underlying}.</p>}
      {digest.articles.map((a, i) => (
        <a key={`${a.url}-${i}`} className="ctp-news-row" href={a.url} target="_blank" rel="noreferrer">
          <div className="ctp-news-title">
            {a.relevance_score != null && (
              <span className="ctp-news-relevance" title={`Relevance to trend: ${a.relevance_score}/100`}>
                {a.relevance_score}
              </span>
            )}
            {a.title}
          </div>
          {a.why && <div className="ctp-news-why muted">{a.why}</div>}
          <div className="ctp-news-meta muted">
            {a.source} · {formatCompact(a.published_at)}
          </div>
        </a>
      ))}
    </div>
  );
}

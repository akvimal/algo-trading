import { useEffect, useState } from "react";

import { type NewsArticle, fetchNews } from "./api";
import { formatCompact, pnlClass } from "./manualOrder";

// News tab inside ChartTradePanel - a cached headline feed for the
// chart's current underlying (server-side cache in market-data's
// app/providers/news.py, backed by marketaux.com). Polls gently on an
// interval so a cache refresh over there eventually shows up here without
// the user having to switch tabs - cheap since it's just re-reading
// market-data's own cache, not spending marketaux quota per poll.
const POLL_MS = 3 * 60 * 1000;

export default function NewsPanel({ underlying }: { underlying: string }) {
  const [articles, setArticles] = useState<NewsArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rows = await fetchNews(underlying);
        if (!cancelled) {
          setArticles(rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    setArticles(null);
    setError(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [underlying]);

  if (error) return <p className="ctp-news-error muted">Couldn't load news: {error}</p>;
  if (articles === null) return <p className="muted">Loading news…</p>;
  if (articles.length === 0) return <p className="muted">No recent news for {underlying}.</p>;

  return (
    <div className="ctp-news">
      {articles.map((a, i) => (
        <a key={`${a.url}-${i}`} className="ctp-news-row" href={a.url} target="_blank" rel="noreferrer">
          <div className="ctp-news-title">
            {a.sentiment_score != null && (
              <span
                className={`ctp-news-sentiment ${pnlClass(a.sentiment_score)}`}
                title={`Sentiment ${a.sentiment_score.toFixed(2)}`}
              >
                ●
              </span>
            )}
            {a.title}
          </div>
          <div className="ctp-news-meta muted">
            {a.source} · {formatCompact(a.published_at)}
          </div>
        </a>
      ))}
    </div>
  );
}

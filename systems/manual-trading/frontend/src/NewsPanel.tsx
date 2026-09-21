import { useEffect, useState } from "react";

import { type NewsDigest, fetchHasOpenrouterKey, fetchNews, saveOpenrouterKey } from "./api";
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

  // BYO OpenRouter key (2026-09-16, see api.ts's own comment) - this tab's
  // AI digest is a shared, cached result (one per underlying, not per
  // user - see accounts.broker_credentials's comment in
  // infra/postgres/init/04-accounts.sql), so setting a key here doesn't
  // guarantee THIS digest was produced with it, only that the next stale
  // refresh this viewer happens to trigger will be. Best-effort load -
  // silently stays null (form just starts collapsed) if accounts is
  // unreachable or the viewer isn't logged in.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchHasOpenrouterKey()
      .then(setHasKey)
      .catch(() => setHasKey(null));
  }, []);

  async function handleSaveKey() {
    if (!keyDraft.trim()) return;
    setSavingKey(true);
    setKeyMessage(null);
    try {
      const saved = await saveOpenrouterKey(keyDraft.trim());
      setHasKey(saved);
      setKeyDraft("");
      setKeyMessage("Saved.");
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  }

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

  const aiNotConfigured = digest.bias_reason.includes("OPENROUTER_API_KEY");

  return (
    <div className="ctp-news">
      <div className={`ctp-news-digest ctp-news-bias-${digest.bias}`}>
        <div className="ctp-news-digest-head">
          <span className="ctp-news-bias-badge">{BIAS_LABEL[digest.bias]}</span>
          <span className="muted">{digest.bias_reason}</span>
        </div>
        <p className="ctp-news-digest-text">{digest.digest}</p>
      </div>

      {!hasKey && (
      <div className="ctp-news-key">
        {!showKeyForm ? (
          <button type="button" className="tiny ctp-news-key-toggle" onClick={() => setShowKeyForm(true)}>
            {hasKey ? "Change your OpenRouter key" : aiNotConfigured ? "Set your OpenRouter key to enable AI analysis" : "Set your OpenRouter key"}
          </button>
        ) : (
          <div className="ctp-news-key-form">
            <input
              type="password"
              autoComplete="new-password"
              placeholder={hasKey ? "Configured - paste a new one to replace" : "sk-or-..."}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button type="button" className="tiny" disabled={savingKey || !keyDraft.trim()} onClick={() => void handleSaveKey()}>
              {savingKey ? "Saving…" : "Save"}
            </button>
            <button type="button" className="tiny" onClick={() => setShowKeyForm(false)}>
              Close
            </button>
            {keyMessage && <span className="manual-saved-badge">{keyMessage}</span>}
          </div>
        )}
      </div>
      )}

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

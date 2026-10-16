import { useState } from "react";
import { ApiError } from "../api/http";
import { loadSuggestions, saveMistakes } from "../api/journal";
import { useResource } from "../hooks/useResource";
import { LEVEL_LABEL, REVIEW_LEVELS, rootCauseOf, tagLabel, toggleTag } from "../pages/journalModel";
import type { Trade } from "../pages/portfolioModel";

/** "What went wrong?" for one closed manual trade: tap the mistakes (suggested ones are marked), or say nothing did. The trade is filed under the
 * earliest step that failed (study, then plan, then execution), which is what the results by cause run on. */
export function MistakeReview({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  const suggestions = useResource(() => loadSuggestions(trade.kind, trade.id), [trade.kind, trade.id]);
  const [tags, setTags] = useState<string[]>(trade.mistakeTags);
  const [clean, setClean] = useState(trade.rootCause === "clean");
  const [saved, setSaved] = useState<{ tags: string[]; clean: boolean }>({ tags: trade.mistakeTags, clean: trade.rootCause === "clean" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = suggestions.data?.tags ?? [];
  const filed = clean ? "clean" : rootCauseOf(tags);
  const changed = clean !== saved.clean || tags.join() !== saved.tags.join();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveMistakes(trade.kind, trade.id, clean ? { clean: true } : { mistake_tags: tags });
      setSaved({ tags, clean });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ background: "var(--surface-2)" }} data-testid="mistake-review">
      <strong>What went wrong?</strong>
      <p className="faint" style={{ margin: "2px 0 10px", fontSize: 12 }}>
        Filed under the earliest step that failed. A trade can lose money and still be clean.
      </p>

      {suggested.length > 0 && (
        <div style={{ marginBottom: 12 }} data-testid="mistake-suggestions">
          <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
            Found in your order
          </div>
          {suggested.map((s) => (
            <div key={s.tag} className="faint" style={{ fontSize: 12, marginBottom: 2 }}>
              <strong>{s.label}</strong>: {s.why}
            </div>
          ))}
          <button
            className="btn btn-small"
            style={{ marginTop: 6 }}
            onClick={() => {
              setClean(false);
              setTags([...new Set([...tags, ...suggested.map((s) => s.tag)])]);
            }}
          >
            Use these
          </button>
        </div>
      )}
      {suggestions.data && suggestions.data.available && !suggestions.data.had_context && (
        <p className="faint" style={{ fontSize: 12, margin: "0 0 10px" }}>The trend at entry was not recorded for this trade, so “against the trend” is up to you.</p>
      )}

      {REVIEW_LEVELS.map((l) => (
        <div key={l.level} style={{ marginBottom: 10 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
            {l.label}: {l.question}
          </div>
          <div className="chips" role="group" aria-label={l.label}>
            {l.tags.map((t) => (
              <button
                key={t.tag}
                aria-pressed={tags.includes(t.tag)}
                disabled={busy}
                onClick={() => {
                  setClean(false);
                  setTags(toggleTag(tags, t.tag));
                }}
              >
                {t.label}
                {suggested.some((s) => s.tag === t.tag) ? " •" : ""}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="chips" role="group" aria-label="Clean" style={{ marginBottom: 10 }}>
        <button
          aria-pressed={clean}
          disabled={busy}
          onClick={() => {
            setClean(!clean);
            setTags([]);
          }}
        >
          Nothing went wrong, clean trade
        </button>
      </div>

      {error && (
        <div className="notice error" role="alert" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="dim" style={{ fontSize: 12 }}>
          {filed ? `Filed under: ${LEVEL_LABEL[filed]}${!clean && tags.length > 1 ? ` (${tags.map(tagLabel).join(", ")})` : ""}` : "Pick at least one, or mark it clean."}
        </span>
        <button className="btn btn-primary btn-small" disabled={busy || !filed || !changed} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

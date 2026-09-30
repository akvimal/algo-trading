import { useState } from "react";
import { ApiError, api } from "../api/http";
import { saveNotes, saveTags, submitReview } from "../api/journal";
import type { ChecklistItem } from "../api/types";
import { useResource } from "../hooks/useResource";
import { NOTES_MAX, SETUP_TAGS, buildReviewPayload, nextSetupTag, reviewItemsFor, validateReview } from "../pages/journalModel";
import type { Trade } from "../pages/portfolioModel";
import { ErrorNotice, Skeleton } from "./bits";

const message = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** Everything you can write about one closed trade: why you took it (setup and confidence),
 * a free note, and, once, the review of how you handled it. Setup, confidence and notes save
 * as you go and can change any time; the review is a one-time record. */
export function TradeJournal({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  const [tag, setTag] = useState(trade.setupTag);
  const [confidence, setConfidence] = useState(trade.confidence);
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [savedNotes, setSavedNotes] = useState(trade.notes ?? "");
  const [busy, setBusy] = useState<null | "tag" | "confidence" | "notes">(null);
  const [error, setError] = useState<string | null>(null);

  async function run(what: "tag" | "confidence" | "notes", action: () => Promise<unknown>, apply: () => void) {
    setBusy(what);
    setError(null);
    try {
      await action();
      apply();
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="journal stack" data-testid="trade-journal">
      <div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
          Why did you take this trade?
        </div>
        <div className="chips" role="group" aria-label="Setup">
          {SETUP_TAGS.map((t) => (
            <button
              key={t}
              aria-pressed={tag === t}
              disabled={busy !== null}
              onClick={() => {
                const next = nextSetupTag(tag, t);
                void run("tag", () => saveTags(trade.kind, trade.id, { setup_tag: next }), () => setTag(next || null));
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
          How confident were you? (1 = a guess, 5 = certain)
        </div>
        <div className="chips" role="group" aria-label="Confidence">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              aria-pressed={confidence === n}
              disabled={busy !== null}
              onClick={() => void run("confidence", () => saveTags(trade.kind, trade.id, { confidence: n }), () => setConfidence(n))}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <label className="field" style={{ marginBottom: 0 }}>
        <span>Note</span>
        <textarea
          className="textarea"
          value={notes}
          maxLength={NOTES_MAX}
          rows={3}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What happened, and what would you do differently?"
        />
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button
          className="btn btn-small"
          disabled={busy !== null || notes.trim() === savedNotes}
          onClick={() => void run("notes", () => saveNotes(trade.kind, trade.id, notes.trim()), () => {
            setSavedNotes(notes.trim());
            setNotes(notes.trim());
          })}
        >
          {busy === "notes" ? "Saving…" : "Save note"}
        </button>
      </div>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <ReviewSection trade={trade} onSaved={onSaved} />
    </div>
  );
}

function ReviewSection({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  if (trade.reviewed) {
    return (
      <div className="card" style={{ background: "var(--surface-2)" }}>
        <strong>Reviewed</strong>
        <p style={{ margin: "6px 0 0" }}>
          {trade.violation ? "You did not follow your plan on this one." : "You followed your plan."}
          {trade.reviewNotes && <span className="dim"> {trade.reviewNotes}</span>}
        </p>
      </div>
    );
  }
  if (!trade.manual) {
    return <p className="faint" style={{ margin: 0, fontSize: 12 }}>This trade came from a strategy, so it has no hand review.</p>;
  }
  return <ReviewForm trade={trade} onSaved={onSaved} />;
}

function ReviewForm({ trade, onSaved }: { trade: Trade; onSaved: () => void }) {
  const items = useResource(() => api<ChecklistItem[]>("execution", "/checklist-items?active_only=true&phase=review"), []);
  const [followed, setFollowed] = useState<boolean | null>(null);
  const [notes, setNotes] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = items.data ? reviewItemsFor(items.data, trade.segment) : [];
  const isLoss = trade.pnl < 0;

  async function submit() {
    const input = { followedPlan: followed, notes, acceptedLoss: accepted, pnl: trade.pnl };
    const problem = validateReview(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitReview(trade.kind, trade.id, buildReviewPayload(input, list, checked));
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <strong>Review this trade</strong>
      <p className="faint" style={{ margin: "2px 0 10px", fontSize: 12 }}>
        You do this once, after the trade is closed. It cannot be changed afterwards.
      </p>

      <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
        Did you follow your plan?
      </div>
      <div className="chips" role="group" aria-label="Followed plan" style={{ marginBottom: 12 }}>
        <button aria-pressed={followed === true} onClick={() => setFollowed(true)}>
          Yes
        </button>
        <button aria-pressed={followed === false} onClick={() => setFollowed(false)}>
          No
        </button>
      </div>

      {followed === false && (
        <label className="field">
          <span>What did you do differently?</span>
          <textarea className="textarea" rows={3} value={notes} maxLength={NOTES_MAX} onChange={(e) => setNotes(e.target.value)} />
        </label>
      )}

      {items.loading && <Skeleton lines={2} />}
      {items.error && <ErrorNotice error={items.error} onRetry={items.reload} />}
      {list.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend className="dim" style={{ fontSize: 12, padding: 0, marginBottom: 6 }}>
            Tick what you did
          </legend>
          {list.map((i) => (
            <label className="check" key={i.id} style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={Boolean(checked[i.id])} onChange={(e) => setChecked({ ...checked, [i.id]: e.target.checked })} />
              <span>{i.label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {isLoss && (
        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>I accept this loss</span>
        </label>
      )}

      {error && (
        <div className="notice error" role="alert" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}
      <button className="btn btn-primary" disabled={busy || items.loading || followed === null} onClick={() => void submit()}>
        {busy ? "Saving…" : "Save review"}
      </button>
    </div>
  );
}

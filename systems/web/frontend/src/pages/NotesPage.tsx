import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/http";
import { listNoteInstruments, listNotes } from "../api/notes";
import type { NoteTag, Segment, StudyNote } from "../api/types";
import { listPublished, type PublishedIdea } from "../api/ideas";
import { useIsAdmin } from "../auth/AuthContext";
import { ChartIcon } from "../chart/icons";
import { IdeasChannelCard } from "../components/IdeasChannelCard";
import { PublishIdea } from "../components/PublishIdea";
import { NoteRow } from "../components/NoteRow";
import { NoteTrade } from "../components/NoteTrade";
import { useNoteTrades } from "../hooks/useNoteTrades";
import { NOTE_TAGS, groupByDay } from "../components/notesModel";
import { useResource } from "../hooks/useResource";

const PAGE = 30;
const SEGMENTS = new Set<string>(["NSE", "MCX", "CRYPTO"]);

/** Everything the person has written, by instrument: the notes bar under the chart only shows the latest few, this is
 * the whole history - filter by instrument, type or words, newest first, with each note's market context and snapshot. */
export function NotesPage() {
  const [params, setParams] = useSearchParams();
  const segParam = params.get("segment");
  const segment = segParam && SEGMENTS.has(segParam) ? (segParam as Segment) : null;
  const symbol = segment ? params.get("symbol") : null;

  const [tag, setTag] = useState<NoteTag | null>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<StudyNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const instruments = useResource(listNoteInstruments, []);
  const isAdmin = useIsAdmin();
  const trades = useNoteTrades(items);
  // Which of the notes on screen have been published as ideas (operator only).
  const [published, setPublished] = useState<Record<string, PublishedIdea>>({});
  useEffect(() => {
    if (!isAdmin || items.length === 0) return;
    let live = true;
    listPublished(items.map((n) => n.id)).then((rows) => live && setPublished((cur) => ({ ...cur, ...Object.fromEntries(rows.map((r) => [r.note_id, r])) }))).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isAdmin, items]);

  // Words are searched a moment after the person stops typing, not on every key.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(typed.trim()), 300);
    return () => window.clearTimeout(t);
  }, [typed]);

  const load = useCallback(
    async (offset: number) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listNotes({ segment: segment ?? undefined, symbol: symbol ?? undefined, tag: tag ?? undefined, q: query || undefined, newestFirst: true, offset, limit: PAGE });
        if (id !== request.current) return; // a newer filter has taken over
        setItems((cur) => (offset === 0 ? page : [...cur, ...page]));
        setMore(page.length === PAGE);
      } catch (e) {
        if (id === request.current) setError(e instanceof ApiError ? e.message : "Could not load your notes.");
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [segment, symbol, tag, query],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  function pick(next: { segment: Segment; symbol: string } | null) {
    setParams(next ? { segment: next.segment, symbol: next.symbol } : {}, { replace: true });
  }
  function refresh() {
    void load(0);
    instruments.reload();
  }

  const groups = groupByDay(items);
  const total = (instruments.data ?? []).reduce((n, i) => n + i.count, 0);
  const filtered = Boolean(symbol || tag || query);

  return (
    <div className="stack notes-page" data-testid="notes-page">
      <h1>Notes</h1>
      <p className="faint notes-intro">Your thoughts and plans by instrument, with the market as it was when you wrote them. Write new ones from the Notes bar under a Trade chart.</p>

      {isAdmin && <IdeasChannelCard />}

      <div className="notes-instruments chips" role="group" aria-label="Instrument">
        <button aria-pressed={!symbol} onClick={() => pick(null)}>
          All <span className="notes-count">{total}</span>
        </button>
        {(instruments.data ?? []).map((i) => (
          <button key={`${i.segment}:${i.symbol}`} aria-pressed={symbol === i.symbol && segment === i.segment} onClick={() => pick({ segment: i.segment, symbol: i.symbol })}>
            {i.symbol} <span className="notes-count">{i.count}</span>
          </button>
        ))}
      </div>

      <div className="notes-filters">
        <label className="sr-only" htmlFor="notes-search">
          Search notes
        </label>
        <input id="notes-search" className="notes-search" type="search" placeholder="Search your notes…" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="chips" role="group" aria-label="Note type">
          {NOTE_TAGS.map((t) => (
            <button key={t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
        {symbol && (
          <Link to={`/trade?symbol=${encodeURIComponent(symbol)}`} className="icon-link" aria-label={`Open ${symbol} chart`} title={`Open the ${symbol} chart`}>
            <ChartIcon />
          </Link>
        )}
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}{" "}
          <button className="link-btn" onClick={() => void load(0)}>
            Retry
          </button>
        </p>
      )}
      {!error && !loading && items.length === 0 && (
        <p className="faint" data-testid="notes-empty">
          {filtered ? "No notes match." : "No notes yet. Open a chart on the Trade screen and use the Notes bar under it."}
        </p>
      )}

      <div className="notes-list" data-testid="notes-list">
        {groups.map((g) => (
          <div key={g.label}>
            {g.label !== "Today" && <div className="notes-day">{g.label}</div>}
            {g.notes.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                showInstrument={!symbol}
                onDeleted={refresh}
                extra={
                  <>
                    <NoteTrade note={n} trade={trades.byId[n.id]} onChanged={trades.reload} />
                    {isAdmin && <PublishIdea note={n} state={published[n.id]} onChanged={(p) => setPublished((cur) => ({ ...cur, [p.note_id]: p }))} />}
                  </>
                }
              />
            ))}
          </div>
        ))}
      </div>

      {loading && <p className="faint">Loading…</p>}
      {more && !loading && (
        <button className="btn" onClick={() => void load(items.length)} data-testid="notes-more">
          Load older notes
        </button>
      )}
    </div>
  );
}

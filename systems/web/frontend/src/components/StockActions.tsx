import { useEffect, useState } from "react";
import { createWatchlist, listWatchlists, updateWatchlist, type Watchlist } from "../api/strategies";
import { Popover } from "../chart/Popover";
import { ApiError } from "../api/http";
import { useFavorites } from "../hooks/useFavorites";
import { addSymbol, hasSymbol, removeSymbol } from "../pages/watchlistModel";

/** The two things to do with a stock wherever it is shown: star it (or un-star it), and put it in (or take it out of) any of your watchlists. */
export function StockActions({ symbol }: { symbol: string }) {
  const { isFavorite, toggle } = useFavorites();
  const on = isFavorite(symbol);
  return (
    <span className="stock-actions" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={on}
        aria-label={on ? `Remove ${symbol} from favourites` : `Add ${symbol} to favourites`}
        title={on ? "Remove from favourites" : "Add to favourites"}
        onClick={() => void toggle(symbol)}
      >
        {on ? "★" : "☆"}
      </button>
      <Popover label={`Watchlists for ${symbol}`} text="＋ List" buttonLabel={`Add ${symbol} to a watchlist`}>
        {() => <WatchlistPicker symbol={symbol} />}
      </Popover>
    </span>
  );
}

function WatchlistPicker({ symbol }: { symbol: string }) {
  const [lists, setLists] = useState<Watchlist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // Loaded when the panel opens (it is only mounted while open), not for every card on a page.
  useEffect(() => {
    let live = true;
    listWatchlists()
      .then((l) => live && setLists(l))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : "Could not load your watchlists."));
    return () => {
      live = false;
    };
  }, []);

  async function change(w: Watchlist) {
    setBusy(true);
    setError(null);
    try {
      const symbols = hasSymbol(w.symbols, symbol) ? removeSymbol(w.symbols, symbol) : addSymbol(w.symbols, symbol);
      // A watchlist cannot be empty (the server refuses it): the last symbol comes out with the watchlist itself, in Strategies.
      if (!symbols) {
        setError(`${w.name} would be empty. Delete the watchlist in Strategies instead.`);
        return;
      }
      const updated = await updateWatchlist(w.id, symbols);
      setLists((cur) => (cur ?? []).map((x) => (x.id === w.id ? updated : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not change the watchlist.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const w = await createWatchlist(name.trim(), symbol);
      setLists((cur) => [...(cur ?? []), w]);
      setName("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the watchlist.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ minWidth: 220 }}>
      {lists === null && !error && (
        <p className="faint" style={{ margin: 0 }}>
          Loading…
        </p>
      )}
      {lists?.length === 0 && (
        <p className="faint" style={{ margin: 0 }}>
          No watchlists yet. Name one below to start it with {symbol}.
        </p>
      )}
      {lists?.map((w) => (
        <label key={w.id} className="check-row">
          <input type="checkbox" checked={hasSymbol(w.symbols, symbol)} disabled={busy} onChange={() => void change(w)} />
          <span>{w.name}</span>
          <span className="faint">{w.symbol_count}</span>
        </label>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <input type="text" aria-label="New watchlist name" placeholder="New watchlist" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        <button type="button" className="btn btn-small" disabled={busy || !name.trim()} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

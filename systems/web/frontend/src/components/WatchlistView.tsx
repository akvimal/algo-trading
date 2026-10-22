import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listSavedReads } from "../api/analysis";
import { listWatchlists } from "../api/strategies";
import { useFavorites } from "../hooks/useFavorites";
import { useResource } from "../hooks/useResource";
import { fullTradeLink } from "../pages/scanModel";
import { symbolsOf } from "../pages/watchlistModel";
import { AnalysisPanel } from "./AnalysisPanel";
import { BIAS_ARROW, BIAS_WORD, biasTone, readAge } from "./analysisModel";
import { Empty, ErrorNotice, Skeleton } from "./bits";
import { StockActions } from "./StockActions";

const FAVORITES = "favorites";

/** The Scan page's Watchlist tab: your favourites and each of your watchlists, one at a time. A row has the stock's star and list menu, its
 * stored business read if there is one, a link to its chart, and the full analysis a tap away. */
export function WatchlistView() {
  const { favorites, loaded } = useFavorites();
  const lists = useResource(listWatchlists, []);
  const reads = useResource(() => listSavedReads().catch(() => []), []);
  const [pick, setPick] = useState<string>(FAVORITES);
  const [open, setOpen] = useState<string | null>(null);
  const readOf = useMemo(() => new Map((reads.data ?? []).map((r) => [r.symbol, r])), [reads.data]);

  if (lists.loading || !loaded) return <Skeleton lines={4} />;
  if (lists.error && !lists.data) return <ErrorNotice error={lists.error} onRetry={lists.reload} />;

  const watchlists = lists.data ?? [];
  const chosen = watchlists.find((w) => w.id === pick);
  const symbols = chosen ? symbolsOf(chosen.symbols) : favorites;

  return (
    <div className="stack" data-testid="watchlist-view">
      <div className="chips" role="group" aria-label="Which list">
        <button aria-pressed={!chosen} onClick={() => setPick(FAVORITES)}>
          ★ Favourites ({favorites.length})
        </button>
        {watchlists.map((w) => (
          <button key={w.id} aria-pressed={pick === w.id} onClick={() => setPick(w.id)}>
            {w.name} ({w.symbol_count})
          </button>
        ))}
      </div>
      {symbols.length === 0 ? (
        <Empty title={chosen ? "This watchlist is empty" : "No favourites yet"}>
          Tap ☆ beside a stock anywhere in the app to keep it here, or ＋ List to put it in a watchlist.
        </Empty>
      ) : (
        symbols.map((s) => {
          const r = readOf.get(s);
          return (
            <div key={s} className="card stack" data-testid="watchlist-row">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <strong>
                  {s}
                  <StockActions symbol={s} />
                </strong>
                {r ? (
                  <span className={`pill ${biasTone(r.bias)}`} title={r.summary ?? undefined}>
                    {BIAS_ARROW[r.bias]} {BIAS_WORD[r.bias]}
                    {r.fetched_at ? ` · read ${readAge(r.fetched_at)}` : ""}
                  </span>
                ) : (
                  <span className="faint" style={{ fontSize: 12 }}>
                    no business read yet
                  </span>
                )}
              </div>
              <div className="row" style={{ justifyContent: "flex-start", gap: 12 }}>
                <button className="link-btn" aria-expanded={open === s} onClick={() => setOpen(open === s ? null : s)}>
                  {open === s ? "Hide analysis" : "Analysis"}
                </button>
                <Link to={fullTradeLink(s)}>Chart</Link>
              </div>
              {open === s && <AnalysisPanel symbol={s} auto />}
            </div>
          );
        })
      )}
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        Watchlists are also what a Rule scans by name; rename or delete them under More → Strategies.
      </p>
    </div>
  );
}

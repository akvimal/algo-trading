import type { MarketRegime } from "../api/types";
import { INTERVALS, toggleFavoriteInterval, type IntervalDef } from "../chart/config";
import { Popover } from "../chart/Popover";
import { formatPrice } from "../format";
import { directionOf } from "./confluence";
import { useFavoriteIntervals } from "./useFavoriteIntervals";

const REGIME_WORD = { trending_up: "Trending up", trending_down: "Trending down", ranging: "Ranging", transitional: "Changing" } as const;

type Props = {
  index: 0 | 1;
  symbol: string;
  interval: string;
  onInterval: (interval: string) => void;
  price: number | null;
  priceShown: boolean;
  live: boolean;
  regime: MarketRegime | null;
  /** Structure trend on the detection timeframes that are switched on, e.g. { "15m": "up" }. */
  structureTrend?: Record<string, "up" | "down" | "range">;
  active: boolean;
  showActive: boolean;
  /** A fixed list of candle sizes to show as buttons (the Scan page's inline chart). Left out, the chart shows
   * the person's FAVOURITE sizes as buttons, plus a star menu that lists every size. */
  intervals?: IntervalDef[];
};

/** The title bar of one chart: which instrument, its price, whether it is live, the candle size, and a
 * one-line read of the market (regime, and structure trend where that layer is on). */
export function PaneHeader({ index, symbol, interval, onInterval, price, priceShown, live, regime, structureTrend, active, showActive, intervals }: Props) {
  const favorites = useFavoriteIntervals();
  // A fixed list wins; otherwise the favourites, in size order, plus the size on screen when it is not one of them
  // (so the active size is never invisible).
  const buttons: IntervalDef[] = intervals ?? INTERVALS.filter((i) => favorites.includes(i.value) || i.value === interval);
  const dir = directionOf(regime);
  const trends = Object.entries(structureTrend ?? {});
  return (
    <div className="pane-header">
      <div className="pane-title">
        <strong>{symbol}</strong>
        {showActive && active && <span className="pill" title="Orders and drawing tools apply to this chart">Trading</span>}
      </div>
      <div className="chips" role="group" aria-label={`Candle size, ${symbol}`}>
        {buttons.map((i) => (
          <button key={i.value} aria-pressed={interval === i.value} onClick={() => onInterval(i.value)}>
            {i.label}
          </button>
        ))}
        {!intervals && (
          <Popover label="Sizes" align="left">
            <div className="menu-heading">Candle size</div>
            <div className="interval-list">
              {INTERVALS.map((i) => {
                const starred = favorites.includes(i.value);
                return (
                  <div className="interval-row" key={i.value}>
                    <button className="interval-pick" aria-pressed={interval === i.value} onClick={() => onInterval(i.value)}>
                      {i.label}
                    </button>
                    <button
                      className={`interval-star ${starred ? "on" : ""}`}
                      aria-label={starred ? `Remove ${i.label} from favourites` : `Add ${i.label} to favourites`}
                      aria-pressed={starred}
                      disabled={starred && favorites.length === 1}
                      title={starred ? (favorites.length === 1 ? "At least one favourite is kept" : "Remove from the quick buttons") : "Show as a quick button"}
                      onClick={() => toggleFavoriteInterval(i.value)}
                    >
                      {starred ? "★" : "☆"}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Starred sizes are the buttons shown on every chart.
            </p>
          </Popover>
        )}
      </div>
      {regime && (
        <span className={`pill ${dir === "up" ? "up" : dir === "down" ? "dn" : ""}`} data-testid={`regime-${index}`}>
          {REGIME_WORD[regime.regime]} · ADX {regime.adx.toFixed(0)}
        </span>
      )}
      {trends.map(([tf, t]) => (
        <span key={tf} className={`pill ${t === "up" ? "up" : t === "down" ? "dn" : ""}`}>
          {tf} structure {t === "range" ? "sideways" : t}
        </span>
      ))}
      {/* Pinned to the far right (margin-left: auto), after everything else - its own width changes
          on every tick (more digits, a comma appearing/disappearing, ...), and sitting ahead of the
          candle-size buttons made them visibly jump sideways on every update. Nothing sits after it,
          so its own reflow no longer moves anything else. Hidden entirely (Layers ▾ > Price in
          header) rather than just blanked, so it doesn't leave a dead gap in its place. */}
      {priceShown && (
        <span className="pane-price">
          <span className="num" data-testid={`price-${index}`}>
            {price == null ? "–" : formatPrice(price)}
          </span>
          <span className={`live-dot ${live ? "on" : ""}`} data-testid={`feed-${index}`} title={live ? "Live: the price updates as it moves" : "Updating every 5 seconds"}>
            <span className="sr-only">{live ? "Live" : "Updating every 5 seconds"}</span>
          </span>
        </span>
      )}
    </div>
  );
}

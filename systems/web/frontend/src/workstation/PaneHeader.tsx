import type { MarketRegime } from "../api/types";
import { INTERVALS } from "../chart/config";
import { formatPrice } from "../format";
import { directionOf } from "./confluence";

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
};

/** The title bar of one chart: which instrument, its price, whether it is live, the candle size, and a
 * one-line read of the market (regime, and structure trend where that layer is on). */
export function PaneHeader({ index, symbol, interval, onInterval, price, priceShown, live, regime, structureTrend, active, showActive }: Props) {
  const dir = directionOf(regime);
  const trends = Object.entries(structureTrend ?? {});
  return (
    <div className="pane-header">
      <div className="pane-title">
        <strong>{symbol}</strong>
        {showActive && active && <span className="pill" title="Orders and drawing tools apply to this chart">Trading</span>}
      </div>
      <div className="chips" role="group" aria-label={`Candle size, ${symbol}`}>
        {INTERVALS.map((i) => (
          <button key={i.value} aria-pressed={interval === i.value} onClick={() => onInterval(i.value)}>
            {i.label}
          </button>
        ))}
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

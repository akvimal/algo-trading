import { useState } from "react";

import { type Segment } from "./api";
import ChartTradePanel from "./ChartTradePanel";
import { type IntervalTrend, LiveChartPanel } from "./LiveChartPanel";

// Standalone Intraday sub-tab wrapping the candlestick panel (see
// LiveChartPanel.tsx for the live-data mechanics and the klinecharts
// rationale). One tab per instrument on the desk's fixed intraday
// watchlist rather than a free-text segment/symbol picker - the same
// move OiSummaryPage made (see its PRESETS): the list is short and
// known (2 NSE index, 2 MCX commodity, 3 crypto), so a tab bar beats a
// dropdown + text field. The last-picked symbol is remembered in
// localStorage.

const SYMBOL_STORAGE_KEY = "manualLiveChartSymbol";

// "Trade with the interval trend only" direction lock - its checkbox
// sits above the trade panel (aligned with the chart's interval strip),
// its enforcement is in ChartTradePanel. Persisted globally, default ON.
const FORCE_TREND_STORAGE_KEY = "manualChartForceTrendDirection";

const SYMBOLS: { symbol: string; segment: Segment }[] = [
  { symbol: "NIFTY", segment: "NSE" },
  { symbol: "BANKNIFTY", segment: "NSE" },
  { symbol: "GOLDM", segment: "MCX" },
  { symbol: "CRUDEOILM", segment: "MCX" },
  { symbol: "BTCUSD", segment: "CRYPTO" },
  { symbol: "ETHUSD", segment: "CRYPTO" },
  { symbol: "SOLUSD", segment: "CRYPTO" },
];

function storedSymbol(): (typeof SYMBOLS)[number] {
  // Deep link (?symbol=NIFTY) - the shell reloads this iframe at that URL
  // when the "Intraday Chart" link on the OI page is clicked (same
  // mechanism as ?tab=oi&symbol=). Wins over the remembered symbol;
  // falls back silently for an unknown/missing value.
  const requested = new URLSearchParams(window.location.search).get("symbol");
  const byUrl = requested ? SYMBOLS.find((s) => s.symbol === requested.toUpperCase()) : null;
  if (byUrl) return byUrl;
  const v = localStorage.getItem(SYMBOL_STORAGE_KEY);
  return SYMBOLS.find((s) => s.symbol === v) ?? SYMBOLS[0];
}

// Default ON - opt out, not in.
function storedForceTrend(): boolean {
  return localStorage.getItem(FORCE_TREND_STORAGE_KEY) !== "false";
}

const TREND_CHIP: Record<"up" | "down" | "range", string> = {
  up: "▲ bullish",
  down: "▼ bearish",
  range: "– ranging",
};

export default function LiveChartPage() {
  const [active, setActive] = useState<(typeof SYMBOLS)[number]>(storedSymbol);
  // The chart-interval structure trend, lifted from LiveChartPanel so the
  // trade panel can lock direction to it.
  const [trendInfo, setTrendInfo] = useState<IntervalTrend>({ trend: null, interval: "5min" });
  const [forceTrend, setForceTrend] = useState<boolean>(storedForceTrend);
  // The chart's own live price, so the trade panel shows exactly what the
  // chart shows instead of running a second, out-of-step LTP poll.
  const [chartLtp, setChartLtp] = useState<number | null>(null);

  function pick(entry: (typeof SYMBOLS)[number]) {
    localStorage.setItem(SYMBOL_STORAGE_KEY, entry.symbol);
    setActive(entry);
    setTrendInfo({ trend: null, interval: "5min" });
    setChartLtp(null);
  }

  function toggleForceTrend() {
    setForceTrend((v) => {
      const next = !v;
      try {
        localStorage.setItem(FORCE_TREND_STORAGE_KEY, String(next));
      } catch {
        /* private mode / quota - still applies this session */
      }
      return next;
    });
  }

  const { trend, interval } = trendInfo;

  return (
    <div className="live-chart-page">
      <nav className="tabs live-chart-symbols">
        {SYMBOLS.map((s) => (
          <button key={s.symbol} className={active.symbol === s.symbol ? "active" : ""} onClick={() => pick(s)}>
            {s.symbol}
          </button>
        ))}
      </nav>

      <div className="live-chart-layout">
        <LiveChartPanel
          key={`${active.segment}:${active.symbol}`}
          segment={active.segment}
          symbol={active.symbol}
          onTrendChange={setTrendInfo}
          onLtpChange={setChartLtp}
        />

        <div className="chart-trade-col">
          <label
            className="chart-trend-lock"
            title="When on, a new trade must agree with the chart interval's structure trend (up → Bullish only, down → Bearish only, ranging → no directional trade). Uncheck to trade either direction."
          >
            <input type="checkbox" checked={forceTrend} onChange={toggleForceTrend} />
            <span className="chart-trend-lock-text">Force trade in prevailing trend direction</span>
            {forceTrend &&
              (trend == null ? (
                <span
                  className="chart-trend-lock-chip is-unknown"
                  title="Enable Structure detection on this interval for the lock to take effect"
                >
                  trend n/a
                </span>
              ) : (
                <span className={`chart-trend-lock-chip is-${trend}`}>{TREND_CHIP[trend]}</span>
              ))}
          </label>

          <ChartTradePanel
            key={`ctp:${active.segment}:${active.symbol}`}
            segment={active.segment}
            symbol={active.symbol}
            intervalTrend={trend}
            chartInterval={interval}
            forceTrend={forceTrend}
            chartLtp={chartLtp}
          />
        </div>
      </div>
    </div>
  );
}

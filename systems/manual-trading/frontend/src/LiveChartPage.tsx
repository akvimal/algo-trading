import { useState } from "react";

import { type Segment } from "./api";
import { LiveChartPanel } from "./LiveChartPanel";

// Standalone Intraday sub-tab wrapping the candlestick panel (see
// LiveChartPanel.tsx for the live-data mechanics and the klinecharts
// rationale). Deliberately self-contained for Phase 1 - its own
// segment/symbol picker, remembered in localStorage - rather than wired
// into WorkspacePage's watch rows; that coupling can come later once the
// chart earns its place.

const SEGMENT_STORAGE_KEY = "manualLiveChartSegment";
const SYMBOL_STORAGE_KEY = "manualLiveChartSymbol";

const SUGGESTIONS: Record<Segment, string[]> = {
  NSE: ["NIFTY", "BANKNIFTY", "RELIANCE", "TCS", "INFY", "HDFCBANK"],
  MCX: ["GOLDM", "CRUDEOILM", "SILVERM", "NATURALGAS"],
  CRYPTO: ["BTCUSD", "ETHUSD", "SOLUSD"],
};

function storedSegment(): Segment {
  const v = localStorage.getItem(SEGMENT_STORAGE_KEY);
  return v === "MCX" || v === "CRYPTO" ? v : "NSE";
}

export default function LiveChartPage() {
  const [segment, setSegment] = useState<Segment>(storedSegment);
  const [symbolInput, setSymbolInput] = useState(() => localStorage.getItem(SYMBOL_STORAGE_KEY) ?? "NIFTY");
  const [active, setActive] = useState<{ segment: Segment; symbol: string }>(() => ({
    segment: storedSegment(),
    symbol: localStorage.getItem(SYMBOL_STORAGE_KEY) ?? "NIFTY",
  }));

  function load() {
    const symbol = symbolInput.trim().toUpperCase();
    if (!symbol) return;
    localStorage.setItem(SEGMENT_STORAGE_KEY, segment);
    localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
    setActive({ segment, symbol });
  }

  return (
    <div className="live-chart-page">
      <div className="live-chart-controls">
        <select
          value={segment}
          onChange={(e) => {
            setSegment(e.target.value as Segment);
            setSymbolInput(""); // symbols aren't portable across segments
          }}
        >
          <option value="NSE">NSE</option>
          <option value="MCX">MCX</option>
          <option value="CRYPTO">CRYPTO</option>
        </select>
        <input
          value={symbolInput}
          onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") load();
          }}
          placeholder="e.g. NIFTY, GOLDM, BTCUSD"
          list="live-chart-symbol-suggestions"
          spellCheck={false}
        />
        <datalist id="live-chart-symbol-suggestions">
          {(SUGGESTIONS[segment] ?? []).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" onClick={load}>
          Load
        </button>
      </div>

      {active.symbol ? (
        <LiveChartPanel key={`${active.segment}:${active.symbol}`} segment={active.segment} symbol={active.symbol} />
      ) : (
        <p className="muted">Pick a segment and symbol, then Load.</p>
      )}
    </div>
  );
}

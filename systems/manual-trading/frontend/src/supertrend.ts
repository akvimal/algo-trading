// SuperTrend - the single implementation shared by the Live Chart's
// visual indicator (LiveChartPanel's registerIndicator("SUPERTREND")) and
// the Intraday auto-trader's flip detector (LiveChartPage). Kept as one
// pure function so the line you SEE on the chart and the line the
// auto-trader stops against can never silently disagree - the same
// "live and backtest share one evaluator" reasoning signal-engine's own
// engine.py uses for its crossover rules.
//
// ATR is Wilder-smoothed; the band-locking / trend-flip rules are the
// standard SuperTrend construction (close breaks the opposite band ->
// trend flips; the active band only ratchets in the favourable direction
// until a flip).

export type StBar = { high: number; low: number; close: number };

export type SupertrendPoint = {
  // Which side price is on as of this bar.
  dir: "up" | "down";
  // The SuperTrend line itself - the trailing stop level. For an uptrend
  // it's the (rising) lower band, for a downtrend the (falling) upper band.
  line: number;
};

// One SupertrendPoint per input bar (same length, same order). A short
// series (fewer bars than `period`) still returns a point per bar - the
// early ones just use a shorter ATR window, matching how the chart
// indicator has always drawn them.
export function computeSupertrend(bars: StBar[], period: number, multiplier: number): SupertrendPoint[] {
  const p = Math.max(1, Math.round(period || 10));
  const mult = multiplier > 0 ? multiplier : 3;
  const n = bars.length;
  const out: SupertrendPoint[] = new Array(n);
  if (n === 0) return out;

  // Wilder ATR.
  const atr: number[] = new Array(n);
  let trSum = 0;
  let prevAtr = 0;
  for (let i = 0; i < n; i++) {
    const k = bars[i];
    const prevClose = i > 0 ? bars[i - 1].close : k.close;
    const tr = Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
    if (i < p) {
      trSum += tr;
      atr[i] = trSum / (i + 1);
      prevAtr = atr[i];
    } else {
      prevAtr = (prevAtr * (p - 1) + tr) / p;
      atr[i] = prevAtr;
    }
  }

  let upperBand = 0;
  let lowerBand = 0;
  let uptrend = true;
  for (let i = 0; i < n; i++) {
    const k = bars[i];
    const hl2 = (k.high + k.low) / 2;
    const basicUpper = hl2 + mult * atr[i];
    const basicLower = hl2 - mult * atr[i];
    const prevClose = i > 0 ? bars[i - 1].close : k.close;

    upperBand = i === 0 || basicUpper < upperBand || prevClose > upperBand ? basicUpper : upperBand;
    lowerBand = i === 0 || basicLower > lowerBand || prevClose < lowerBand ? basicLower : lowerBand;

    if (i === 0) {
      uptrend = k.close >= hl2;
    } else if (k.close > upperBand) {
      uptrend = true;
    } else if (k.close < lowerBand) {
      uptrend = false;
    }

    out[i] = uptrend ? { dir: "up", line: lowerBand } : { dir: "down", line: upperBand };
  }
  return out;
}

export type SupertrendFlip = {
  index: number; // position in the passed-in series
  barTs: number; // epoch ms of the bar that flipped
  direction: "up" | "down"; // "up" = flipped bullish (BUY), "down" = bearish (SELL)
  line: number; // the SuperTrend stop level as of the flip bar
  close: number; // that bar's close
};

// Every bar where the SuperTrend direction differs from the prior bar's.
// Caller passes a series of COMPLETED bars (each `{ ...ohlc, timestamp }`,
// timestamp in epoch ms) - a still-forming last bar must be dropped
// first, or a flip could be reported and then un-reported as the bar
// finishes.
export function detectSupertrendFlips(
  bars: (StBar & { timestamp: number })[],
  period: number,
  multiplier: number,
): SupertrendFlip[] {
  const st = computeSupertrend(bars, period, multiplier);
  const flips: SupertrendFlip[] = [];
  for (let i = 1; i < st.length; i++) {
    const cur = st[i];
    const prev = st[i - 1];
    if (cur && prev && cur.dir !== prev.dir) {
      flips.push({ index: i, barTs: bars[i].timestamp, direction: cur.dir, line: cur.line, close: bars[i].close });
    }
  }
  return flips;
}

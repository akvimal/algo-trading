/** Average true range of the last `period` bars (a plain mean of the true ranges): how far the instrument
 * typically moves in one bar of this chart. Null when there are too few bars to say. */
export function averageTrueRange(bars: Bar[], period = 14): number | null {
  if (bars.length < 3) return null;
  const recent = bars.slice(-(period + 1));
  let sum = 0;
  let n = 0;
  for (let i = 1; i < recent.length; i++) {
    const b = recent[i];
    const prev = recent[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
    n++;
  }
  const atr = n > 0 ? sum / n : 0;
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

export type Bar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

/** The bar to show after a price tick. While the newest bar's window is open the tick just moves its
 * close and stretches its high or low. Once that window has ended, and the market is plausibly still
 * open (the last real bar is under two windows old), a fresh bar is started at the tick, so a quiet
 * minute does not leave the chart a bar behind; the next download replaces it with the real one. A
 * stale series (market closed, a data gap) is left alone: no phantom bars. Daily bars never start a
 * new bar from a tick (`canStartBar` false): a Saturday would otherwise get one. Null = nothing to draw. */
export function rollLiveBar(last: Bar | null, price: number | null, now: number, intervalMs: number, canStartBar = true): Bar | null {
  if (!last || price == null || !Number.isFinite(price) || intervalMs <= 0) return null;
  const windowEnd = last.timestamp + intervalMs;
  if (now < windowEnd) {
    const high = Math.max(last.high, price);
    const low = Math.min(last.low, price);
    if (last.close === price && last.high === high && last.low === low) return null;
    return { ...last, close: price, high, low };
  }
  if (canStartBar && now - last.timestamp < 2 * intervalMs) {
    return { timestamp: windowEnd, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 };
  }
  return null;
}

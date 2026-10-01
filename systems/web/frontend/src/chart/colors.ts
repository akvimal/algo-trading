// Colours the canvas needs as literals (it cannot read CSS variables). Kept apart from the chart library
// so a screen can use them without pulling the library into its own bundle.
export const BUY = "#3ecf8e";
export const SELL = "#e8586a";
export const ACCENT = "#4cc2ff";
// Your own trades on the chart. Deliberately NOT the candle green/red, which they used to share and so
// disappeared into: gold for a trade in profit, violet for one at a loss, sky blue while it has no result.
export const MARK_PROFIT = "#ffc83d";
export const MARK_LOSS = "#a78bfa";
export const MARK_OPEN = "#4cc2ff";

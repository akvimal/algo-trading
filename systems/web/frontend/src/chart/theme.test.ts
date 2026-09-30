import { describe, expect, it } from "vitest";
import { FONT_MONO, FONT_SANS, chartStyles } from "./theme";

// klinecharts draws its own text to a canvas, so it does not inherit the page's font the way DOM
// text does - it silently falls back to whatever the browser/canvas default is unless every text
// style is told explicitly. This pins that every one of them names an app font, not the default,
// and that the choice matches the rest of the app's own convention (mono for a price/time, same as
// base.css's `.num`; sans for a label).

describe("chartStyles", () => {
  it.each([true, false])("gives every text style an explicit app font, light=%s", (light) => {
    const s = chartStyles(light);
    // Numeric/tabular: prices, times, the OHLC tooltip.
    expect(s.xAxis?.tickText?.family).toBe(FONT_MONO);
    expect(s.yAxis?.tickText?.family).toBe(FONT_MONO);
    expect(s.candle?.tooltip?.text?.family).toBe(FONT_MONO);
    expect(s.candle?.priceMark?.high?.textFamily).toBe(FONT_MONO);
    expect(s.candle?.priceMark?.low?.textFamily).toBe(FONT_MONO);
    expect(s.candle?.priceMark?.last?.text?.family).toBe(FONT_MONO);
    expect(s.crosshair?.horizontal?.text?.family).toBe(FONT_MONO);
    expect(s.crosshair?.vertical?.text?.family).toBe(FONT_MONO);
    expect(s.indicator?.lastValueMark?.text?.family).toBe(FONT_MONO);
    // Labels: indicator names/values, drawn overlay text (plan-line labels, ...).
    expect(s.indicator?.tooltip?.text?.family).toBe(FONT_SANS);
    expect(s.overlay?.text?.family).toBe(FONT_SANS);
  });
});

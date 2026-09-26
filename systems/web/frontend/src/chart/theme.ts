import type { DeepPartial, Styles } from "klinecharts";
import { ACCENT, BUY, SELL } from "./colors";

// klinecharts draws to a canvas, which cannot read CSS variables, so the theme is two literal sets
// that match the app's tokens. The choice follows the person's system light/dark setting.

type Palette = { text: string; dim: string; border: string; raised: string; bg: string };

const DARK: Palette = { text: "#e6edf3", dim: "#93a1b1", border: "#263241", raised: "#1c2530", bg: "#0e1319" };
const LIGHT: Palette = { text: "#131a22", dim: "#4a5866", border: "#d8dee6", raised: "#eef1f5", bg: "#ffffff" };

export const prefersLight = (): boolean => {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  } catch {
    return false;
  }
};

export function chartStyles(light: boolean = prefersLight()): DeepPartial<Styles> {
  const c = light ? LIGHT : DARK;
  const accent = light ? "#0a6cb0" : ACCENT;
  return {
    grid: { horizontal: { color: c.border }, vertical: { color: c.border } },
    candle: {
      bar: {
        upColor: BUY, downColor: SELL, noChangeColor: c.dim,
        upBorderColor: BUY, downBorderColor: SELL, noChangeBorderColor: c.dim,
        upWickColor: BUY, downWickColor: SELL, noChangeWickColor: c.dim,
      },
      priceMark: { high: { color: c.dim }, low: { color: c.dim }, last: { upColor: BUY, downColor: SELL, noChangeColor: c.dim, text: { color: "#0e1319" } } },
      tooltip: { text: { color: c.text } },
    },
    indicator: { tooltip: { text: { color: c.dim } }, lastValueMark: { show: false } },
    xAxis: { axisLine: { color: c.border }, tickLine: { color: c.border }, tickText: { color: c.dim } },
    yAxis: { axisLine: { color: c.border }, tickLine: { color: c.border }, tickText: { color: c.dim } },
    separator: { color: c.border },
    crosshair: {
      horizontal: { line: { color: c.dim }, text: { backgroundColor: c.raised, borderColor: c.border, color: c.text } },
      vertical: { line: { color: c.dim }, text: { backgroundColor: c.raised, borderColor: c.border, color: c.text } },
    },
    overlay: {
      line: { color: accent },
      rect: { color: "rgba(76, 194, 255, 0.16)", borderColor: accent, borderSize: 1.5 },
      polygon: { color: "rgba(76, 194, 255, 0.16)", borderColor: accent },
      text: { color: c.text, backgroundColor: c.raised, borderColor: c.border },
      point: { color: accent, borderColor: c.bg, activeColor: accent, activeBorderColor: c.text },
    },
  };
}

import type { Segment } from "../api/types";
import { DEFAULT_INTERVAL, INTERVALS } from "../chart/config";
import { parseTradeParams, presetFor } from "../pages/tradeModel";

// The shape of the trading workstation: one or two charts, which instrument each shows, at which
// interval, and how the two are linked. It is plain data so it can be saved, restored and tested
// without a screen.

export type Layout = "single" | "side" | "stack";
export type PaneSpec = { symbol: string; segment: Segment; interval: string };
export type Links = { crosshair: boolean; scale: boolean; interval: boolean };

export type WorkstationState = {
  layout: Layout;
  panes: [PaneSpec, PaneSpec];
  active: 0 | 1;
  links: Links;
  ticketOpen: boolean;
};

export const DEFAULT_LINKS: Links = { crosshair: true, scale: false, interval: true };

const pane = (symbol: string, segment: Segment, interval = DEFAULT_INTERVAL): PaneSpec => ({ symbol, segment, interval });

export const DEFAULT_STATE: WorkstationState = {
  layout: "single",
  panes: [pane("NIFTY", "NSE"), pane("BANKNIFTY", "NSE")],
  active: 0,
  links: DEFAULT_LINKS,
  ticketOpen: true,
};

const KEY = "web.workstation";
const VALID_INTERVALS = new Set(INTERVALS.map((i) => i.value));
const LAYOUTS: Layout[] = ["single", "side", "stack"];

function cleanPane(v: unknown, fallback: PaneSpec): PaneSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const parsed = parseTradeParams(typeof o.symbol === "string" ? o.symbol : null, typeof o.segment === "string" ? o.segment : null);
  return { symbol: parsed.symbol, segment: parsed.segment, interval: typeof o.interval === "string" && VALID_INTERVALS.has(o.interval) ? o.interval : fallback.interval };
}

/** What was saved last time, made safe: anything missing or malformed falls back to the default. */
export function loadWorkstation(): WorkstationState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_STATE;
    const panes = Array.isArray(raw.panes) ? raw.panes : [];
    const links = (raw.links ?? {}) as Record<string, unknown>;
    return {
      layout: LAYOUTS.includes(raw.layout as Layout) ? (raw.layout as Layout) : DEFAULT_STATE.layout,
      panes: [cleanPane(panes[0], DEFAULT_STATE.panes[0]), cleanPane(panes[1], DEFAULT_STATE.panes[1])],
      active: raw.active === 1 ? 1 : 0,
      links: { crosshair: links.crosshair !== false, scale: links.scale !== false, interval: links.interval !== false },
      ticketOpen: raw.ticketOpen !== false,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveWorkstation(s: WorkstationState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the setup lasts this session */
  }
}

/** A link from Scan (or anywhere) names the instrument for the FIRST chart; the rest of the saved
 * setup stays. Without a symbol in the URL the saved setup is used untouched. */
export function withUrlSymbol(saved: WorkstationState, symbol: string | null, segment: string | null): WorkstationState {
  if (!symbol) return saved;
  const p = parseTradeParams(symbol, segment);
  return { ...saved, panes: [{ ...saved.panes[0], symbol: p.symbol, segment: p.segment }, saved.panes[1]], active: 0 };
}

export const paneCount = (s: WorkstationState) => (s.layout === "single" ? 1 : 2);

export function setLayout(s: WorkstationState, layout: Layout): WorkstationState {
  return { ...s, layout, active: layout === "single" ? 0 : s.active };
}

/** Change one chart's interval. With the interval link on, the other follows: comparing two charts
 * at different intervals is rarely what someone wants. */
export function setInterval(s: WorkstationState, index: 0 | 1, interval: string): WorkstationState {
  if (!VALID_INTERVALS.has(interval)) return s;
  const panes: [PaneSpec, PaneSpec] = [{ ...s.panes[0] }, { ...s.panes[1] }];
  panes[index].interval = interval;
  if (s.links.interval) panes[index === 0 ? 1 : 0].interval = interval;
  return { ...s, panes };
}

export function setSymbol(s: WorkstationState, index: 0 | 1, symbol: string, segment: string | null = null): WorkstationState {
  const p = parseTradeParams(symbol, segment ?? presetFor(symbol)?.segment ?? null);
  const panes: [PaneSpec, PaneSpec] = [{ ...s.panes[0] }, { ...s.panes[1] }];
  panes[index] = { ...panes[index], symbol: p.symbol, segment: p.segment };
  return { ...s, panes };
}

/** Turning the interval link on brings the second chart to the active chart's interval at once. */
export function setLinks(s: WorkstationState, links: Links): WorkstationState {
  const next = { ...s, links };
  if (links.interval && !s.links.interval && paneCount(s) === 2) {
    const panes: [PaneSpec, PaneSpec] = [{ ...s.panes[0] }, { ...s.panes[1] }];
    panes[s.active === 0 ? 1 : 0].interval = panes[s.active].interval;
    next.panes = panes;
  }
  return next;
}

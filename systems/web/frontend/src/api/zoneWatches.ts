import { api } from "./http";

/** What Telegram says about a zone: all (the touch, then how the candle closed), close (only that verdict) or off. */
export type ZoneAlertLevel = "all" | "close" | "off";

/** A zone or level the server watches for this person (see market-data's app/domain/zone_watch.py). */
export type ZoneWatch = {
  id: string;
  exchange: string;
  symbol: string;
  kind: "zone" | "line";
  lo: number;
  hi: number;
  role: "support" | "resistance" | "zone" | null;
  interval: string;
  last_state: "above" | "inside" | "below" | null;
  alerts?: ZoneAlertLevel;
};

export type ZoneEvent = {
  symbol: string;
  exchange: string;
  kind: "zone" | "line";
  lo: number;
  hi: number;
  role: string | null;
  event: "touch" | "held" | "broke" | "inside";
  at: string;
  extreme: number | null;
  close: number | null;
};

export type SpecIn = { kind: "zone" | "line"; lo: number; hi: number };

export const listZoneWatches = () => api<{ watches: ZoneWatch[]; events: ZoneEvent[]; alerts?: ZoneAlertLevel }>("marketData", "/zone-watches");
/** The setting for every zone of this person (kept with their Telegram chat), and for one zone; the quieter of the two wins. */
export const setZoneAlertsForAll = (alerts: ZoneAlertLevel) => api<{ alerts: ZoneAlertLevel }>("marketData", "/zone-alerts", { method: "PUT", json: { alerts } });
export const setZoneAlerts = (id: string, alerts: ZoneAlertLevel) => api<ZoneWatch>("marketData", `/zone-alerts/${encodeURIComponent(id)}`, { method: "PUT", json: { alerts } });
export const syncZoneWatches = (exchange: string, symbol: string, interval: string, watches: SpecIn[]) =>
  api<ZoneWatch[]>("marketData", `/zone-watches/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}`, { method: "PUT", json: { interval, watches } });
export const removeZoneWatch = (id: string) => api<void>("marketData", `/zone-watches/${encodeURIComponent(id)}`, { method: "DELETE" });

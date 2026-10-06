import { syncZoneWatches } from "../api/zoneWatches";
import type { StoredDrawing } from "./config";
import { serverWatches } from "./alerts";

// Keeps the server's copy of the armed zones in step with the chart. The drawings live in this browser; the server needs the armed zones and
// levels to watch them with every tab closed, so each time they change the whole set for that instrument is sent (the server keeps the ones
// that match, adds new ones and drops the rest). Sent a moment after the last change, so dragging a zone does not send a request per pixel.
// A failure (signed out, offline) is not shown: the chart keeps working and the next change sends it again.

const timers = new Map<string, number>();
const DELAY_MS = 800;

export function scheduleZoneSync(exchange: string, symbol: string, interval: string, drawings: Pick<StoredDrawing, "name" | "points" | "alert">[], delay = DELAY_MS): void {
  const key = `${exchange}|${symbol}`;
  const prior = timers.get(key);
  if (prior !== undefined) window.clearTimeout(prior);
  const watches = serverWatches(drawings);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      syncZoneWatches(exchange, symbol, interval, watches).catch((e) => console.warn("could not send the armed zones to the server", e));
    }, delay),
  );
}

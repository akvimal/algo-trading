import { useMemo, useSyncExternalStore } from "react";
import { FAVORITE_INTERVALS_CHANGED_EVENT, favoriteIntervalsRaw, parseFavoriteIntervals } from "../chart/config";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(FAVORITE_INTERVALS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab starred something
  return () => {
    window.removeEventListener(FAVORITE_INTERVALS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The favourite intervals, kept in step across both charts (and other tabs): starring a size on one
 * chart's menu changes the buttons on the other at once. */
export function useFavoriteIntervals(): string[] {
  const raw = useSyncExternalStore(subscribe, favoriteIntervalsRaw, () => null);
  return useMemo(() => {
    try {
      return parseFavoriteIntervals(raw == null ? null : JSON.parse(raw));
    } catch {
      return parseFavoriteIntervals(null);
    }
  }, [raw]);
}

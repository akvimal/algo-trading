import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/http";

export type Resource<T> = {
  data: T | null;
  error: ApiError | null;
  /** True only until the FIRST answer arrives (a skeleton, not a spinner over stale data). */
  loading: boolean;
  /** True while a background refresh is in flight (data stays on screen). */
  refreshing: boolean;
  /** When `data` was last successfully fetched (client clock), or null before the first success.
   * Unlike `data` itself, this keeps advancing only on a genuine success - a run of failed
   * background refreshes (a dead upstream feed, an expired token, ...) leaves it exactly where
   * it was, so a caller that cares how OLD an on-screen value really is (not just whether one
   * exists) can tell "fresh" apart from "the last one that ever worked". */
  fetchedAt: number | null;
  reload: () => void;
};

type Options = {
  /** Re-fetch this often while the tab is visible. Omit for a one-shot fetch. */
  pollMs?: number;
  /** Skip fetching entirely (e.g. until a dependency is known). */
  enabled?: boolean;
};

/** Loads something, keeps it fresh, and never lets a slow old answer overwrite a newer one.
 * Polling pauses while the tab is hidden (a phone in a pocket should not hammer the API)
 * and refreshes once when it comes back. Pass a stable `deps` list (the fetcher's inputs). */
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[], { pollMs, enabled = true }: Options = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const requestId = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (background: boolean) => {
    const id = ++requestId.current;
    if (background) setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (id !== requestId.current) return; // a newer request superseded this one
      setData(result);
      setError(null);
      setFetchedAt(Date.now());
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, e instanceof Error ? e.message : "Something went wrong"));
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // biome-ignore-start: the caller owns the dependency list on purpose (the fetcher's inputs)
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setData(null);
    setError(null);
    setLoading(true);
    setFetchedAt(null);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, load, ...deps]);
  // biome-ignore-end

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const timer = window.setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, pollMs, load]);

  const reload = useCallback(() => void load(true), [load]);
  return { data, error, loading, refreshing, fetchedAt, reload };
}

import { useEffect, useSyncExternalStore } from "react";
import { addFavorite, listFavorites, removeFavorite } from "../api/favorites";

// One list for the whole page: a star toggled on a card shows at once on every other card (and the Watchlist tab) for the same stock.
// Loaded the first time any star is on screen; a failed change puts the star back.
let favorites: string[] = [];
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (next: string[]) => {
  favorites = next;
  emit();
};

async function load() {
  if (loaded || loading) return;
  loading = true;
  try {
    set(await listFavorites());
    loaded = true;
  } catch {
    // not signed in, or the service is down: every star simply shows off
  } finally {
    loading = false;
  }
}

/** Test seam: forget everything. */
export function resetFavorites() {
  favorites = [];
  loaded = false;
  loading = false;
  emit();
}

export function useFavorites() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => favorites,
  );
  useEffect(() => {
    void load();
  }, []);

  const isFavorite = (symbol: string) => list.includes(symbol.toUpperCase());
  async function toggle(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    const before = favorites;
    const on = before.includes(sym);
    set(on ? before.filter((s) => s !== sym) : [sym, ...before]); // at once; the server's answer replaces it
    try {
      set(on ? await removeFavorite(sym) : await addFavorite(sym));
    } catch {
      set(before);
    }
  }
  return { favorites: list, isFavorite, toggle, loaded };
}

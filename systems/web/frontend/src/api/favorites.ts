import { api } from "./http";

// A person's favourite stocks (signal-engine, personal): the whole list comes back after every change.
export const listFavorites = () => api<string[]>("signalEngine", "/favorites");
export const addFavorite = (symbol: string) => api<string[]>("signalEngine", `/favorites/${encodeURIComponent(symbol)}`, { method: "PUT" });
export const removeFavorite = (symbol: string) => api<string[]>("signalEngine", `/favorites/${encodeURIComponent(symbol)}`, { method: "DELETE" });

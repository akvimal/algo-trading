import { api } from "./http";
import type { CustomScreen, CustomScreenDef, CustomScreenRunResult } from "./types";

// The custom equity screener: a saved, per-user expression (app/domain/screener_expr.py on
// market-data) evaluated against the latest EOD universe. Preview runs an ad-hoc definition
// without saving it (no auth needed - nothing belongs to anyone yet); run re-evaluates a saved
// one. Both can 422 with the parser's own plain-language reason - api() already turns that into
// an ApiError whose .message is that text, so callers just show e.message.

export const listCustomScreens = () => api<CustomScreen[]>("marketData", "/custom-screens");
export const createCustomScreen = (def: CustomScreenDef) => api<CustomScreen>("marketData", "/custom-screens", { method: "POST", json: def });
export const updateCustomScreen = (id: string, def: CustomScreenDef) => api<CustomScreen>("marketData", `/custom-screens/${id}`, { method: "PUT", json: def });
export const deleteCustomScreen = (id: string) => api<void>("marketData", `/custom-screens/${id}`, { method: "DELETE" });
export const runCustomScreen = (id: string) => api<CustomScreenRunResult>("marketData", `/custom-screens/${id}/run`);
export const previewCustomScreen = (def: CustomScreenDef) => api<CustomScreenRunResult>("marketData", "/custom-screens/preview", { method: "POST", json: def });

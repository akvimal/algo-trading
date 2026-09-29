import type { CustomScreen, CustomScreenDef } from "../api/types";

// The custom screener's form state is plain strings (what an <input> actually holds), converted
// to/from the typed CustomScreenDef the API takes - same "raw text in, validated typed thing out"
// split every other form in this app uses (see tradeModel.ts's own Ticket/analyzeTicket).

export type Fno = "any" | "yes" | "no";
// No min/max price fields - a price range is just another condition ("close > 100 and close <
// 500"), and having it as a separate control too meant the same filter could be expressed two
// ways that could disagree with each other. min_price/max_price stay on CustomScreenDef itself
// (the backend still accepts them, and an old saved screen may still carry values there) - this
// form just never sets or shows them.
export type CustomScreenForm = { label: string; expression: string; fno: Fno; index: string };

export const EMPTY_FORM: CustomScreenForm = { label: "", expression: "", fno: "any", index: "" };

/** The index keys market-data's nse_indices.py syncs - kept in sync by hand (a small, rarely-
 * changing list; not worth a round trip to ask the server what it knows about). */
export const INDEX_OPTIONS = [
  "NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200", "NIFTY500",
  "NIFTYMIDCAP100", "NIFTYMIDCAP150", "NIFTYSMALLCAP100", "NIFTYSMALLCAP250",
  "NIFTYBANK", "NIFTYIT", "NIFTYFINANCE",
];

/** Everything wrong with the form, in words - empty means it is ready to preview/save. The
 * expression's own grammar is NOT checked here (that needs the real parser, which only runs
 * server-side); this only catches what can be caught without one, so a round trip is never
 * wasted on an empty label or condition. */
export function validateForm(f: CustomScreenForm): string[] {
  const errors: string[] = [];
  if (!f.label.trim()) errors.push("Give the screen a label, e.g. \"Bearish breakout\".");
  if (!f.expression.trim()) errors.push("Type a condition, e.g. \"close > 100\".");
  return errors;
}

export function formToDef(f: CustomScreenForm): CustomScreenDef {
  return {
    label: f.label.trim(),
    expression: f.expression.trim(),
    is_fno: f.fno === "any" ? null : f.fno === "yes",
    index_membership: f.index || null,
    min_price: null,
    max_price: null,
  };
}

export function defToForm(d: CustomScreenDef): CustomScreenForm {
  return {
    label: d.label,
    expression: d.expression,
    fno: d.is_fno === null ? "any" : d.is_fno ? "yes" : "no",
    index: d.index_membership ?? "",
  };
}

/** A short read of what the universe filters amount to, for the line above the results -
 * "F&O stocks, in NIFTY100" or "" when nothing is filtered. */
export function filterSummary(f: CustomScreenForm): string {
  const parts: string[] = [];
  if (f.fno !== "any") parts.push(f.fno === "yes" ? "F&O stocks" : "non-F&O stocks");
  if (f.index) parts.push(`in ${f.index}`);
  return parts.join(", ");
}

/** Sorts newest-first, same convention as every other saved-list in this app (combos, positions). */
export const sortScreens = (screens: CustomScreen[]): CustomScreen[] => [...screens].sort((a, b) => b.created_at.localeCompare(a.created_at));

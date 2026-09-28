import type { CustomScreen, CustomScreenDef } from "../api/types";

// The custom screener's form state is plain strings (what an <input> actually holds), converted
// to/from the typed CustomScreenDef the API takes - same "raw text in, validated typed thing out"
// split every other form in this app uses (see tradeModel.ts's own Ticket/analyzeTicket).

export type Fno = "any" | "yes" | "no";
export type CustomScreenForm = { label: string; expression: string; fno: Fno; index: string; minPrice: string; maxPrice: string };

export const EMPTY_FORM: CustomScreenForm = { label: "", expression: "", fno: "any", index: "", minPrice: "", maxPrice: "" };

/** The index keys market-data's nse_indices.py syncs - kept in sync by hand (a small, rarely-
 * changing list; not worth a round trip to ask the server what it knows about). */
export const INDEX_OPTIONS = [
  "NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200", "NIFTY500",
  "NIFTYMIDCAP100", "NIFTYMIDCAP150", "NIFTYSMALLCAP100", "NIFTYSMALLCAP250",
  "NIFTYBANK", "NIFTYIT", "NIFTYFINANCE",
];

function num(text: string): number | null {
  const t = text.trim();
  return t ? Number(t) : null;
}

/** Everything wrong with the form, in words - empty means it is ready to preview/save. The
 * expression's own grammar is NOT checked here (that needs the real parser, which only runs
 * server-side); this only catches what can be caught without one, so a round trip is never
 * wasted on an empty label or a nonsensical price range. */
export function validateForm(f: CustomScreenForm): string[] {
  const errors: string[] = [];
  if (!f.label.trim()) errors.push("Give the screen a label, e.g. \"Bearish breakout\".");
  if (!f.expression.trim()) errors.push("Type a condition, e.g. \"close > 100\".");
  const min = num(f.minPrice);
  const max = num(f.maxPrice);
  if (f.minPrice.trim() && (min === null || !Number.isFinite(min) || min <= 0)) errors.push("Minimum price must be a positive number.");
  if (f.maxPrice.trim() && (max === null || !Number.isFinite(max) || max <= 0)) errors.push("Maximum price must be a positive number.");
  if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max) && min > max) errors.push("Minimum price must be below the maximum.");
  return errors;
}

export function formToDef(f: CustomScreenForm): CustomScreenDef {
  return {
    label: f.label.trim(),
    expression: f.expression.trim(),
    is_fno: f.fno === "any" ? null : f.fno === "yes",
    index_membership: f.index || null,
    min_price: num(f.minPrice),
    max_price: num(f.maxPrice),
  };
}

export function defToForm(d: CustomScreenDef): CustomScreenForm {
  return {
    label: d.label,
    expression: d.expression,
    fno: d.is_fno === null ? "any" : d.is_fno ? "yes" : "no",
    index: d.index_membership ?? "",
    minPrice: d.min_price != null ? String(d.min_price) : "",
    maxPrice: d.max_price != null ? String(d.max_price) : "",
  };
}

/** A short read of what the universe filters amount to, for the line above the results -
 * "F&O stocks, in NIFTY100, 100–2000" or "" when nothing is filtered. */
export function filterSummary(f: CustomScreenForm): string {
  const parts: string[] = [];
  if (f.fno !== "any") parts.push(f.fno === "yes" ? "F&O stocks" : "non-F&O stocks");
  if (f.index) parts.push(`in ${f.index}`);
  if (f.minPrice.trim() || f.maxPrice.trim()) {
    if (f.minPrice.trim() && f.maxPrice.trim()) parts.push(`₹${f.minPrice}–₹${f.maxPrice}`);
    else if (f.minPrice.trim()) parts.push(`above ₹${f.minPrice}`);
    else parts.push(`below ₹${f.maxPrice}`);
  }
  return parts.join(", ");
}

/** Sorts newest-first, same convention as every other saved-list in this app (combos, positions). */
export const sortScreens = (screens: CustomScreen[]): CustomScreen[] => [...screens].sort((a, b) => b.created_at.localeCompare(a.created_at));

import type { AiModelTask, CatalogModel } from "../api/types";

export const SOURCE_LABEL: Record<AiModelTask["source"], string> = {
  task: "Its own choice",
  default: "Shared default",
  env: "Server setting",
};

/** "$0.10 in · $0.40 out per 1M tokens". A free model says so rather than showing "$0.00". */
export function priceText(m: Pick<CatalogModel, "prompt_per_m" | "completion_per_m">): string {
  if (m.prompt_per_m == null && m.completion_per_m == null) return "price varies";
  const fmt = (v: number | null) => (v == null ? "?" : v === 0 ? "free" : `$${v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 2 : 1)}`);
  if (m.prompt_per_m === 0 && m.completion_per_m === 0) return "free";
  return `${fmt(m.prompt_per_m)} in · ${fmt(m.completion_per_m)} out per 1M tokens`;
}

/** What a model can do, as short labels. */
export function tagsOf(m: Pick<CatalogModel, "reasoning" | "image_input" | "free">): string[] {
  return [m.reasoning && "Reasoning", m.image_input && "Image input", m.free && "Free"].filter((t): t is string => !!t);
}

/** The option label in the picker's suggestion list: the id (what is saved), the name, the price and what it can do. */
export function optionLabel(m: CatalogModel): string {
  return [m.name, priceText(m), ...tagsOf(m)].join(" · ");
}

export type Filters = { reasoning: boolean; vision: boolean; free: boolean; provider: string };
export const NO_FILTERS: Filters = { reasoning: false, vision: false, free: false, provider: "" };

export function hasFilters(f: Filters): boolean {
  return f.reasoning || f.vision || f.free || f.provider !== "";
}

export function providerOf(id: string): string {
  return id.split("/")[0];
}

/** The providers in the list, the ones with the most models first. */
export function providers(catalog: CatalogModel[]): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of catalog) counts.set(providerOf(m.id), (counts.get(providerOf(m.id)) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/** The models that pass every switched-on filter (they combine: reasoning AND free AND from this provider). */
export function filterCatalog(catalog: CatalogModel[], f: Filters): CatalogModel[] {
  return catalog.filter((m) => (!f.reasoning || m.reasoning) && (!f.vision || m.image_input) && (!f.free || m.free) && (!f.provider || providerOf(m.id) === f.provider));
}

export type Check = { ok: true; id: string } | { ok: false; reason: string };

/** Whether what was typed is a model the catalog offers. Stricter than the server is not needed: the server checks again. */
export function checkChoice(raw: string, catalog: CatalogModel[]): Check {
  const id = raw.trim();
  if (!id) return { ok: false, reason: "Pick a model first." };
  if (!catalog.some((m) => m.id === id)) return { ok: false, reason: `"${id}" is not in OpenRouter's list of models that can return structured JSON.` };
  return { ok: true, id };
}

/** Whether the saved choice differs from what is typed, so Save is only offered for a real change. */
export function isChanged(typed: string, saved: string | null): boolean {
  return typed.trim() !== (saved ?? "");
}

/** One plain sentence on how the tasks are set up now: all on one model, or a mix. */
export function setupSummary(tasks: AiModelTask[]): string {
  const models = new Set(tasks.map((t) => t.model));
  if (models.size === 1) return `Every task uses ${[...models][0]}.`;
  const overridden = tasks.filter((t) => t.source === "task").length;
  return `${models.size} different models across ${tasks.length} tasks${overridden ? `, ${overridden} chosen individually` : ""}.`;
}

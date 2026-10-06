import type { AiModelTask, CatalogModel } from "../api/types";

export const SOURCE_LABEL: Record<AiModelTask["source"], string> = {
  task: "Its own choice",
  default: "Shared default",
  env: "Server setting",
};

/** "$0.10 in · $0.40 out per 1M tokens". A free model says so rather than showing "$0.00". */
export function priceText(m: Pick<CatalogModel, "prompt_per_m" | "completion_per_m">): string {
  const fmt = (v: number | null) => (v == null ? "?" : v === 0 ? "free" : `$${v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 2 : 1)}`);
  if (m.prompt_per_m === 0 && m.completion_per_m === 0) return "free";
  return `${fmt(m.prompt_per_m)} in · ${fmt(m.completion_per_m)} out per 1M tokens`;
}

/** The option label in the picker's suggestion list: the id (what is saved), the name and the price. */
export function optionLabel(m: CatalogModel): string {
  return `${m.name} · ${priceText(m)}`;
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

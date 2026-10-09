import { api } from "./http";
import type { AiModels, CatalogModel } from "./types";

export const getAiModels = () => api<AiModels>("marketData", "/ai-models");
export const getModelCatalog = () => api<CatalogModel[]>("marketData", "/ai-models/catalog");

/** Set a task's model, or the shared default under the task name "default". A null model clears it. */
export const setAiModel = (task: string, model: string | null) => api<AiModels>("marketData", `/ai-models/${task}`, { method: "PUT", json: { model } });

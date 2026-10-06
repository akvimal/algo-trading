import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModels, CatalogModel } from "../api/types";
import { AiModelsPage } from "./AiModelsPage";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CATALOG: CatalogModel[] = [
  { id: "google/cheap", name: "Cheap", context_length: 1000, prompt_per_m: 0.1, completion_per_m: 0.4, reasoning: false, image_input: false, free: false },
  { id: "vendor/big", name: "Big", context_length: 1000, prompt_per_m: 3, completion_per_m: 15, reasoning: true, image_input: true, free: false },
  { id: "vendor/gratis", name: "Gratis", context_length: 1000, prompt_per_m: 0, completion_per_m: 0, reasoning: true, image_input: false, free: true },
];

let state: AiModels;
let puts: { task: string; model: string | null }[];
let putFails: string | null;

beforeEach(() => {
  puts = [];
  putFails = null;
  state = {
    default: null,
    tasks: [
      { task: "news", label: "News digest", description: "n", override: null, model: "google/cheap", source: "env" },
      { task: "premarket", label: "Pre-market bias", description: "p", override: null, model: "google/cheap", source: "env" },
      { task: "ai_read", label: "OI AI read", description: "a", override: null, model: "vendor/big", source: "env" },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/ai-models/catalog")) return json(CATALOG);
      if (url.endsWith("/ai-models") && method === "GET") return json(state);
      const put = url.match(/\/ai-models\/(\w+)$/);
      if (put && method === "PUT") {
        if (putFails) return json({ detail: putFails }, 422);
        const { model } = JSON.parse(init!.body as string);
        puts.push({ task: put[1], model });
        if (put[1] === "default") {
          state = { ...state, default: model, tasks: state.tasks.map((t) => (t.override ? t : { ...t, model: model ?? t.model, source: model ? "default" : "env" })) };
        } else {
          state = { ...state, tasks: state.tasks.map((t) => (t.task === put[1] ? { ...t, override: model, model: model ?? t.model, source: model ? "task" : "env" } : t)) };
        }
        return json(state);
      }
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(<MemoryRouter><AiModelsPage /></MemoryRouter>);

describe("AiModelsPage", () => {
  it("lists every task with the model it uses now, where that came from, and its price", async () => {
    renderPage();
    const news = await screen.findByTestId("ai-task-news");
    expect(within(news).getByText("google/cheap")).toBeInTheDocument();
    expect(within(news).getByText("Server setting")).toBeInTheDocument();
    expect(within(news).getByText("$0.10 in · $0.40 out per 1M tokens")).toBeInTheDocument();
    expect(screen.getByTestId("ai-setup-summary")).toHaveTextContent("2 different models across 3 tasks");
  });

  it("sets one shared default so every task follows it", async () => {
    renderPage();
    await screen.findByTestId("ai-task-news");
    await userEvent.type(screen.getByLabelText("Shared default model"), "vendor/big");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(puts).toEqual([{ task: "default", model: "vendor/big" }]));
    await waitFor(() => expect(screen.getByTestId("ai-setup-summary")).toHaveTextContent("Every task uses vendor/big."));
    expect(within(screen.getByTestId("ai-task-premarket")).getByText("Shared default")).toBeInTheDocument();
  });

  it("gives one task its own model and can hand it back to the default", async () => {
    renderPage();
    const pm = await screen.findByTestId("ai-task-premarket");
    await userEvent.type(within(pm).getByLabelText("Pre-market bias model"), "vendor/big");
    await userEvent.click(within(pm).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([{ task: "premarket", model: "vendor/big" }]));
    await waitFor(() => expect(within(screen.getByTestId("ai-task-premarket")).getByText("Its own choice")).toBeInTheDocument());
    // The other tasks are untouched.
    expect(within(screen.getByTestId("ai-task-news")).getByText("Server setting")).toBeInTheDocument();

    await userEvent.click(within(screen.getByTestId("ai-task-premarket")).getByRole("button", { name: "Follow the default" }));
    await waitFor(() => expect(puts[1]).toEqual({ task: "premarket", model: null }));
  });

  it("refuses a model name that is not in the catalog without calling the server", async () => {
    renderPage();
    const news = await screen.findByTestId("ai-task-news");
    await userEvent.type(within(news).getByLabelText("News digest model"), "vendor/typo");
    await userEvent.click(within(news).getByRole("button", { name: "Save" }));
    expect(await within(news).findByRole("alert")).toHaveTextContent("vendor/typo");
    expect(puts).toEqual([]);
  });

  it("shows the server's reason when a save is refused", async () => {
    putFails = "'google/cheap' is not a model OpenRouter offers with structured JSON output.";
    renderPage();
    const news = await screen.findByTestId("ai-task-news");
    await userEvent.type(within(news).getByLabelText("News digest model"), "google/cheap");
    await userEvent.click(within(news).getByRole("button", { name: "Save" }));
    expect(await within(news).findByRole("alert")).toHaveTextContent("structured JSON");
  });

  it("only offers Save for a real change and Clear when something is set", async () => {
    renderPage();
    const news = await screen.findByTestId("ai-task-news");
    expect(within(news).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(news).getByRole("button", { name: "Follow the default" })).toBeDisabled();
  });

  it("narrows the suggestions with the filters, which combine, and resets them", async () => {
    renderPage();
    const bar = await screen.findByTestId("ai-filters");
    const options = () => [...document.querySelectorAll("#ai-model-options option")].map((o) => o.getAttribute("value"));
    expect(options()).toEqual(["google/cheap", "vendor/big", "vendor/gratis"]);
    expect(screen.getByTestId("ai-filter-count")).toHaveTextContent("3 of 3 models");

    await userEvent.click(within(bar).getByRole("button", { name: "Reasoning" }));
    expect(options()).toEqual(["vendor/big", "vendor/gratis"]);
    await userEvent.click(within(bar).getByRole("button", { name: "Free" }));
    expect(options()).toEqual(["vendor/gratis"]);
    expect(screen.getByTestId("ai-filter-count")).toHaveTextContent("1 of 3 models");

    await userEvent.click(within(bar).getByRole("button", { name: "Reset filters" }));
    expect(options()).toHaveLength(3);
    await userEvent.selectOptions(within(bar).getByLabelText("Provider"), "google");
    expect(options()).toEqual(["google/cheap"]);
  });

  it("still accepts a model typed in by id even when a filter hides it from the suggestions", async () => {
    renderPage();
    const bar = await screen.findByTestId("ai-filters");
    await userEvent.click(within(bar).getByRole("button", { name: "Free" }));
    const news = screen.getByTestId("ai-task-news");
    await userEvent.type(within(news).getByLabelText("News digest model"), "google/cheap");
    await userEvent.click(within(news).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([{ task: "news", model: "google/cheap" }]));
  });

  it("shows what the current model can do next to its price", async () => {
    renderPage();
    const ai = await screen.findByTestId("ai-task-ai_read");
    expect(within(ai).getByText("$3.00 in · $15.0 out per 1M tokens · Reasoning · Image input")).toBeInTheDocument();
  });
});

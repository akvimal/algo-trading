import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Inbox, InboxItem } from "../api/inbox";
import { InboxPage } from "./InboxPage";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const item = (over: Partial<InboxItem> = {}): InboxItem => ({ id: "a", kind: "event", category: "bot", severity: "info", title: "Spread bot entered NIFTY", body: "Bought the spread", link: null, created_at: "2026-10-16T05:00:00Z", read: false, ...over });

let items: InboxItem[];
let calls: { url: string; method: string }[];
let failNext: boolean;

const state = (): Inbox => {
  const categories = [...new Set(items.map((i) => i.category))].map((category) => ({ category, count: items.filter((i) => i.category === category).length, unread: items.filter((i) => i.category === category && !i.read).length }));
  return { unread: items.filter((i) => !i.read).length, items, categories };
};

beforeEach(() => {
  items = [];
  calls = [];
  failNext = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (failNext && method !== "GET") {
        failNext = false;
        return json({ detail: "nope" }, 500);
      }
      const one = url.match(/\/inbox\/([^/]+)\/(read|unread)$/);
      if (one && method === "POST") {
        items = items.map((i) => (i.id === one[1] ? { ...i, read: one[2] === "read" } : i));
        return json({ ok: true });
      }
      if (url.endsWith("/inbox/read-all")) {
        items = items.map((i) => ({ ...i, read: true }));
        return json({ marked: 1 });
      }
      const del = url.match(/\/inbox\/([^/?]+)$/);
      if (del && method === "DELETE") {
        items = items.filter((i) => i.id !== del[1]);
        return json({ ok: true });
      }
      if (url.includes("/inbox")) return json(state());
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/more/inbox"]}>
      <Routes>
        <Route path="/more/inbox" element={<InboxPage />} />
        <Route path="/portfolio" element={<div>Portfolio page</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("InboxPage", () => {
  it("says so when there is nothing", async () => {
    renderPage();
    expect(await screen.findByText("Nothing here")).toBeInTheDocument();
  });

  it("lists to-dos first, with unread ones marked", async () => {
    items = [item({ id: "e", title: "An event" }), item({ id: "t", kind: "todo", category: "review", title: "3 closed trades not reviewed yet", severity: "warn" })];
    renderPage();
    const rows = await screen.findAllByTestId("inbox-item");
    expect(rows[0]).toHaveTextContent("3 closed trades not reviewed yet");
    expect(rows[1]).toHaveTextContent("An event");
    expect(rows[0]).toHaveAttribute("data-read", "false");
  });

  it("opening a line marks it read and follows its link inside the app", async () => {
    items = [item({ id: "t", kind: "todo", category: "review", title: "2 closed trades not reviewed yet", link: "/portfolio?tab=review" })];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Unread: 2 closed trades/ }));
    expect(await screen.findByText("Portfolio page")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/inbox/t/read"))).toBe(true);
  });

  it("does not follow a link that leaves the app", async () => {
    items = [item({ id: "x", link: "https://evil.example" })];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Unread: Spread bot entered NIFTY/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/inbox/x/read"))).toBe(true));
    expect(screen.queryByText("Portfolio page")).not.toBeInTheDocument();
  });

  it("marks everything read and dismisses a line", async () => {
    items = [item({ id: "a" }), item({ id: "b", title: "Another" })];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getAllByTestId("inbox-item").every((r) => r.getAttribute("data-read") === "true")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Another" }));
    await waitFor(() => expect(screen.getAllByTestId("inbox-item")).toHaveLength(1));
  });

  it("says when a change did not go through", async () => {
    items = [item({ id: "a" })];
    renderPage();
    failNext = true;
    await userEvent.click(await screen.findByRole("button", { name: "Mark read" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});

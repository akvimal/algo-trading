import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdeasConfig } from "../api/ideas";
import { IdeasChannelCard } from "./IdeasChannelCard";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DISCLAIMER = "Disclaimer: Personal study note shared for education only. Not investment advice.";
let config: IdeasConfig;
let calls: { url: string; method: string; body: any }[];
let failNext: { status: number; detail: string } | null;

beforeEach(() => {
  config = { bot_configured: true, destination_set: true, destination_hint: "…7890", disclaimer: DISCLAIMER };
  calls = [];
  failNext = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (failNext && method !== "GET") {
        const f = failNext;
        failNext = null;
        return json({ detail: f.detail }, f.status);
      }
      if (url.endsWith("/ideas/config")) return json(config);
      if (url.endsWith("/ideas/destination") && method === "PUT") {
        config = { ...config, destination_set: Boolean(body.telegram_chat_id), destination_hint: body.telegram_chat_id ? `…${body.telegram_chat_id.slice(-4)}` : null };
        return json(config);
      }
      if (url.endsWith("/ideas/test")) return json({ sent: true });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const puts = () => calls.filter((c) => c.method === "PUT");

describe("IdeasChannelCard", () => {
  it("shows where ideas are posted and the disclaimer every post ends with", async () => {
    render(<IdeasChannelCard />);
    const card = await screen.findByTestId("ideas-channel");
    expect(within(card).getByText("Posting to …7890")).toBeInTheDocument();
    expect(within(card).getByTestId("ideas-disclaimer")).toHaveTextContent(DISCLAIMER);
  });

  it("says plainly when the ideas bot is not set up on the server", async () => {
    config = { ...config, bot_configured: false, destination_set: false, destination_hint: null };
    render(<IdeasChannelCard />);
    expect(await screen.findByText(/ideas bot is not set up on this server/)).toBeInTheDocument();
    expect(screen.getByText("Not set up")).toBeInTheDocument();
  });

  it("checks the channel id before sending it, then saves it", async () => {
    config = { ...config, destination_set: false, destination_hint: null };
    render(<IdeasChannelCard />);
    const card = await screen.findByTestId("ideas-channel");
    await userEvent.type(within(card).getByLabelText("Channel id or @name"), "my channel");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("numeric id");
    expect(puts()).toHaveLength(0);
    await userEvent.clear(within(card).getByLabelText("Channel id or @name"));
    await userEvent.type(within(card).getByLabelText("Channel id or @name"), "-1001234567890");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()[0].body).toEqual({ telegram_chat_id: "-1001234567890" }));
    expect(await within(card).findByText("Posting to …7890")).toBeInTheDocument();
  });

  it("makes the test post a deliberate two-click action, since it really posts", async () => {
    render(<IdeasChannelCard />);
    const card = await screen.findByTestId("ideas-channel");
    await userEvent.click(within(card).getByRole("button", { name: "Send a test post" }));
    expect(calls.some((c) => c.url.endsWith("/ideas/test"))).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: "This posts to the channel. Send?" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ideas/test") && c.method === "POST")).toBe(true));
    expect(await within(card).findByText("Test post sent to the channel.")).toBeInTheDocument();
  });

  it("shows why the test post failed", async () => {
    render(<IdeasChannelCard />);
    const card = await screen.findByTestId("ideas-channel");
    await userEvent.click(within(card).getByRole("button", { name: "Send a test post" }));
    failNext = { status: 502, detail: "Could not post: the bot is not allowed to post there (add it to the channel or group as an admin)." };
    await userEvent.click(within(card).getByRole("button", { name: "This posts to the channel. Send?" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("add it to the channel or group as an admin");
  });

  it("can remove the channel", async () => {
    render(<IdeasChannelCard />);
    const card = await screen.findByTestId("ideas-channel");
    await userEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(puts()[0].body).toEqual({ telegram_chat_id: "" }));
    expect(await within(card).findByText("Not set up")).toBeInTheDocument();
  });
});

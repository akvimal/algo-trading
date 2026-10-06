import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedIdea } from "../api/ideas";
import type { StudyNote } from "../api/types";
import { PublishIdea } from "./PublishIdea";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DISCLAIMER = "Disclaimer: Personal study note shared for education only. Not investment advice.";
const note = (over: Partial<StudyNote> = {}): StudyNote => ({
  id: "n1", segment: "NSE", symbol: "NIFTY", interval: "15min", text: "Watching 23,100 for a retest.", tag: "plan",
  context: { price: 23140.5, interval: "15min", holding: "long 50 NIFTY", ai_read: { bias: "bullish", confidence: 80, one_liner: "SECRET", generated_at: "x" } },
  position_id: null, option_group_id: null, has_snapshot: false, created_at: "2026-10-06T05:00:00Z", ...over,
});
const published = (over: Partial<PublishedIdea> = {}): PublishedIdea => ({ note_id: "n1", published: true, published_at: "2026-10-06T05:40:00Z", unpublished_at: null, destination_hint: "…7890", has_image: false, ...over });

let calls: { url: string; method: string; body: any }[];
let destination: string | null;
let failNext: { status: number; detail: string; path: string } | null;

beforeEach(() => {
  calls = [];
  destination = "…7890";
  failNext = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (failNext && url.includes(failNext.path)) {
        const f = failNext;
        failNext = null;
        return json({ detail: f.detail }, f.status);
      }
      if (url.includes("/study-notes/") && url.endsWith("/snapshot")) return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), { status: 200 });
      if (url.endsWith("/ideas/preview")) {
        const text = `💡 ${body.symbol} · 15m · ${body.tag}\n\n${body.text}${body.include_context ? "\n\nPrice 23,140.50" : ""}\n\n${DISCLAIMER}`;
        return json({ text, messages: body.snapshot_png_base64 ? 1 : 1, has_image: Boolean(body.snapshot_png_base64), destination_hint: destination });
      }
      if (url.endsWith("/ideas/publish")) return json(published({ has_image: Boolean(body.snapshot_png_base64) }));
      if (url.includes("/unpublish")) return json(published({ published: false, published_at: "2026-10-06T05:40:00Z", unpublished_at: "2026-10-06T06:00:00Z" }));
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const last = <T,>(xs: T[]): T => xs[xs.length - 1];
const writes = (needle: string) => calls.filter((c) => c.method === "POST" && c.url.includes(needle));

function setup(n: StudyNote = note(), state?: PublishedIdea) {
  const onChanged = vi.fn();
  render(<PublishIdea note={n} state={state} onChanged={onChanged} />);
  return onChanged;
}

describe("PublishIdea", () => {
  it("offers Publish only for plan and observation notes", () => {
    for (const tag of ["mistake", "review", null] as const) {
      const { unmount } = render(<PublishIdea note={note({ tag })} state={undefined} onChanged={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Publish idea" })).not.toBeInTheDocument();
      unmount();
    }
    setup(note({ tag: "observation" }));
    expect(screen.getByRole("button", { name: "Publish idea" })).toBeInTheDocument();
  });

  it("shows exactly what will be posted, disclaimer included, and sends nothing until the second click", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    expect(await within(panel).findByText(/Watching 23,100 for a retest\./)).toBeInTheDocument();
    expect(panel.textContent).toContain(DISCLAIMER);
    expect(within(panel).getByText(/exactly what will be posted to …7890/)).toBeInTheDocument();
    expect(writes("/ideas/publish")).toHaveLength(0); // previewing posts nothing
  });

  it("publishes, without ever sending the position held or the AI read", async () => {
    const onChanged = setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    await within(panel).findByText(/Watching 23,100/);
    await userEvent.click(within(panel).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(writes("/ideas/publish")).toHaveLength(1));
    const sent = writes("/ideas/publish")[0].body;
    expect(sent).toMatchObject({ note_id: "n1", tag: "plan", include_context: true, text: "Watching 23,100 for a retest." });
    expect(JSON.stringify(sent)).not.toContain("holding");
    expect(JSON.stringify(sent)).not.toContain("SECRET");
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ published: true }));
  });

  it("can leave out the market line, which changes the preview", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    await within(panel).findByText(/Price 23,140\.50/);
    await userEvent.click(within(panel).getByLabelText(/Include the market line/));
    await waitFor(() => expect(within(panel).queryByText(/Price 23,140\.50/)).not.toBeInTheDocument());
    expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.include_context).toBe(false);
  });

  it("keeps the chart image off by default, warns about it, and attaches it only when asked", async () => {
    setup(note({ has_snapshot: true }));
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    const box = within(panel).getByLabelText(/Include the chart image/);
    expect(box).not.toBeChecked();
    expect(within(panel).getByText(/can show lines you drew, including your own trades/)).toBeInTheDocument();
    await within(panel).findByText(/Watching 23,100/);
    expect(calls.some((c) => c.url.includes("/snapshot"))).toBe(false);
    await userEvent.click(box);
    await waitFor(() => expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.snapshot_png_base64).toMatch(/^data:image\/png;base64,/));
    expect(await within(panel).findByText(/Sent as one photo/)).toBeInTheDocument();
  });

  it("cannot publish when no channel is set, and says so", async () => {
    destination = null;
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    expect(await within(panel).findByText(/No ideas channel is set/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Publish now" })).toBeDisabled();
  });

  it("shows why a publish failed and stays open so it can be retried", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    await within(panel).findByText(/Watching 23,100/);
    failNext = { status: 502, path: "/ideas/publish", detail: "Could not post: the bot is not allowed to post there (add it to the channel or group as an admin)." };
    await userEvent.click(within(panel).getByRole("button", { name: "Publish now" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("add it to the channel or group as an admin");
    expect(within(panel).getByRole("button", { name: "Publish now" })).toBeEnabled();
  });

  it("Cancel closes the panel without posting", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("idea-preview")).not.toBeInTheDocument();
    expect(writes("/ideas/publish")).toHaveLength(0);
  });

  it("shows a published idea with when it went out, and unpublishes only after a second click", async () => {
    const onChanged = setup(note(), published());
    const done = screen.getByTestId("idea-published");
    expect(within(done).getByText(/^Published 6 Oct at /)).toBeInTheDocument();
    expect(within(done).getByText("to …7890")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish idea" })).not.toBeInTheDocument(); // it cannot be published twice
    await userEvent.click(within(done).getByRole("button", { name: "Unpublish" }));
    expect(writes("/unpublish")).toHaveLength(0);
    await userEvent.click(within(done).getByRole("button", { name: "Delete the post?" }));
    await waitFor(() => expect(writes("/unpublish")).toHaveLength(1));
    expect(writes("/unpublish")[0].url).not.toContain("force");
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ published: false }));
  });

  it("when Telegram will not delete the post, says so and offers to mark it unpublished anyway", async () => {
    const onChanged = setup(note(), published());
    const done = screen.getByTestId("idea-published");
    await userEvent.click(within(done).getByRole("button", { name: "Unpublish" }));
    failNext = { status: 409, path: "/unpublish", detail: "Telegram would not delete it (message can't be deleted). If it is old, delete it in Telegram yourself, then mark it unpublished here." };
    await userEvent.click(within(done).getByRole("button", { name: "Delete the post?" }));
    expect(await within(done).findByRole("alert")).toHaveTextContent("delete it in Telegram yourself");
    await userEvent.click(within(done).getByRole("button", { name: "Mark as unpublished anyway" }));
    await waitFor(() => expect(last(writes("/unpublish")).url).toContain("force=true"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ published: false })));
  });

  it("offers Publish again once an idea has been unpublished", () => {
    setup(note(), published({ published: false, unpublished_at: "2026-10-06T06:00:00Z" }));
    expect(screen.getByRole("button", { name: "Publish idea" })).toBeInTheDocument();
  });
});

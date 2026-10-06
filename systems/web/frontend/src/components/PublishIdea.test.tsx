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

const pos = (over: object = {}) => ({
  id: "p1", symbol: "NIFTY", exchange: "NSE", segment: "NSE", action: "BUY", instrument_type: "future", quantity: 75, entry_price: 23140.5, entry_time: "2026-10-05T04:00:00Z",
  exit_price: 23235, exit_time: "2026-10-05T09:30:00Z", pnl: 7087.5, status: "CLOSED", stop_loss_price: 23090, target_price: 23240, option_group_id: null,
  exit_reason: "target", is_live_broker_order: false, trailing_stop_enabled: false, stop_loss_method: null, ...over,
});
const grp = (over: object = {}) => ({
  id: "g1", underlying_symbol: "NIFTY", strategy_type: "bull_call_spread", action: "BUY", quantity: 75, net_debit: 100, status: "CLOSED", pnl: 4650, entry_time: "2026-10-04T04:00:00Z",
  exit_time: "2026-10-04T09:00:00Z", segment: "NSE", entry_spot_price: 23100, spot_stop_loss_price: 22950, spot_target_price: 23350, exit_reason: "target", ...over,
});
let positions: object[];
let groups: object[];
let calls: { url: string; method: string; body: any }[];
let destination: string | null;
let failNext: { status: number; detail: string; path: string } | null;

beforeEach(() => {
  calls = [];
  positions = [pos()];
  groups = [grp()];
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
      if (url.includes("/positions")) return json(positions);
      if (url.includes("/option-groups")) return json(groups);
      if (url.includes("/study-notes/") && url.includes("/snapshot")) return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), { status: 200 });
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
    expect(within(panel).getByText(/also shows your note text and any AI read line, as well as lines you drew/)).toBeInTheDocument();
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

  it("uses the clean chart-only picture when the note has one, and says what it still shows", async () => {
    setup(note({ has_snapshot: true, has_clean_snapshot: true }));
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    expect(within(panel).getByText(/The chart with a header only/)).toBeInTheDocument();
    expect(within(panel).queryByText(/AI read line/)).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByLabelText(/Include the chart image/));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/snapshot?variant=clean"))).toBe(true));
    expect(calls.some((c) => c.url.includes("/snapshot?variant=full"))).toBe(false);
  });

  it("falls back to the composed picture for an older note, and asks for that variant", async () => {
    setup(note({ has_snapshot: true, has_clean_snapshot: false }));
    await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
    const panel = await screen.findByTestId("idea-preview");
    await userEvent.click(within(panel).getByLabelText(/Include the chart image/));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/snapshot?variant=full"))).toBe(true));
  });

  describe("attaching a closed trade", () => {
    const open = async () => {
      await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
      return screen.findByTestId("idea-preview");
    };

    it("lists only the closed trades on this instrument, with no amounts, and attaches none by default", async () => {
      positions = [pos(), pos({ id: "open", status: "OPEN", exit_price: null, exit_time: null }), pos({ id: "other", symbol: "BANKNIFTY" }), pos({ id: "beesx", symbol: "NIFTYBEES" }), pos({ id: "leg", option_group_id: "g1" })];
      groups = [grp(), grp({ id: "credit", net_debit: -20 }), grp({ id: "open-g", status: "OPEN" })];
      setup();
      const panel = await open();
      const picker = await within(panel).findByLabelText("Attach a closed trade");
      const options = within(picker).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(["No trade", expect.stringMatching(/^BUY NIFTY · closed 5 Oct · hit target · paper$/), expect.stringMatching(/^BUY NIFTY bull call spread · closed 4 Oct · hit target · paper$/)]);
      expect(options.join(" ")).not.toMatch(/₹|\b4650\b|\b7087|\b75\b/); // nothing about size or money in the list
      await within(panel).findByText(/Watching 23,100/);
      expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body).not.toHaveProperty("trade");
    });

    it("sends the levels and how it ended for a position, and nothing about its size or its rupee result", async () => {
      setup();
      const panel = await open();
      await userEvent.selectOptions(await within(panel).findByLabelText("Attach a closed trade"), "p1");
      await waitFor(() => expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade).toBeDefined());
      const trade = last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade;
      expect(trade).toEqual({ kind: "position", label: "NIFTY", side: "BUY", live: false, entry: 23140.5, stop: 23090, target: 23240, exit: 23235, exit_reason: "target", result_pct: null });
      const wire = JSON.stringify(trade);
      for (const private_ of ["quantity", "75", "pnl", "7087", "charges"]) expect(wire).not.toContain(private_);
      await userEvent.click(within(panel).getByRole("button", { name: "Publish now" }));
      await waitFor(() => expect(writes("/ideas/publish")[0].body.trade).toEqual(trade));
    });

    it("sends an option spread's result as a share of the premium, not as money, and labels a live one live", async () => {
      positions = [pos({ id: "leg1", option_group_id: "g1", is_live_broker_order: true })];
      setup();
      const panel = await open();
      await userEvent.selectOptions(await within(panel).findByLabelText("Attach a closed trade"), "g1");
      await waitFor(() => expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade?.kind).toBe("group"));
      const trade = last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade;
      expect(trade).toMatchObject({ kind: "group", label: "NIFTY bull call spread", live: true, entry: 23100, stop: 22950, target: 23350, exit: null });
      expect(trade.result_pct).toBeCloseTo(62, 5); // 4650 / (100 x 75), computed here so neither number is sent
      expect(JSON.stringify(trade)).not.toContain("4650");
    });

    it("leaves out a stop that was trailed, so the result is not measured against a moved stop", async () => {
      positions = [pos({ trailing_stop_enabled: true, stop_loss_price: 23200 })];
      setup();
      const panel = await open();
      await userEvent.selectOptions(await within(panel).findByLabelText("Attach a closed trade"), "p1");
      await waitFor(() => expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade).toBeDefined());
      expect(last(calls.filter((c) => c.url.endsWith("/ideas/preview"))).body.trade.stop).toBeNull();
    });

    it("says so when there is nothing to attach, and still lets the idea go out", async () => {
      positions = [];
      groups = [];
      setup();
      const panel = await open();
      expect(await within(panel).findByText("No closed trades on NIFTY to attach.")).toBeInTheDocument();
      await within(panel).findByText(/Watching 23,100/);
      expect(within(panel).getByRole("button", { name: "Publish now" })).toBeEnabled();
    });

    it("says so when the trades could not be loaded, and still lets the idea go out without one", async () => {
      failNext = { status: 500, path: "/positions", detail: "boom" };
      setup();
      const panel = await open();
      expect(await within(panel).findByText("Could not load your trades, so none can be attached right now.")).toBeInTheDocument();
      await within(panel).findByText(/Watching 23,100/);
      expect(within(panel).getByRole("button", { name: "Publish now" })).toBeEnabled();
    });

    it("explains what is and is not shown", async () => {
      setup();
      const panel = await open();
      expect(await within(panel).findByText(/Closed trades only\..*paper or live\. It never shows quantity, lots, rupee amounts, charges or your balance/)).toBeInTheDocument();
    });

    it("shows the server's refusal if it will not take the trade", async () => {
      setup();
      const panel = await open();
      await userEvent.selectOptions(await within(panel).findByLabelText("Attach a closed trade"), "p1");
      await within(panel).findByText(/Watching 23,100/);
      failNext = { status: 422, path: "/ideas/publish", detail: "Only a closed trade can be attached: this one has no exit price." };
      await userEvent.click(within(panel).getByRole("button", { name: "Publish now" }));
      expect(await within(panel).findByRole("alert")).toHaveTextContent("Only a closed trade can be attached");
    });
  });
});


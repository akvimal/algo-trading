import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeSnapshot } from "../api/tradeSnapshots";
import { TradeSnapshots } from "./TradeSnapshots";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const snap = (over: Partial<TradeSnapshot> = {}): TradeSnapshot => ({
  id: "s1", content_type: "image/png", uploaded_at: "2026-10-12T05:00:00Z", kind: "entry", caption: "The plan at entry", entry_price: 1000, stop_price: 950, target_price: 1100, ...over,
});

type Call = { url: string; method: string; body: any };
let calls: Call[];
let snaps: TradeSnapshot[];
let uploadFails: boolean;

beforeEach(() => {
  calls = [];
  snaps = [snap(), snap({ id: "s2", kind: "update", caption: "Moved the stop to breakeven", stop_price: 1000, uploaded_at: "2026-10-13T05:00:00Z" })];
  uploadFails = false;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:picture", revokeObjectURL: () => undefined }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body = raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, v instanceof Blob ? `blob:${v.type}` : v])) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/images/") && method === "GET") return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), { status: 200 });
      if (url.includes("/images/") && method === "DELETE") return json({ deleted: true });
      if (url.endsWith("/images") && method === "POST") {
        if (uploadFails) return json({ detail: "image too large - max 8MB" }, 422);
        snaps = [...snaps, snap({ id: "s3", kind: "update", caption: body!.caption ?? null, stop_price: Number(body!.stop_price) })];
        return json(snaps[snaps.length - 1]);
      }
      if (url.endsWith("/images")) return json(snaps);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const levels = () => ({ entry: 1000, stop: 1000, target: 1100 });
const view = (capture?: React.ComponentProps<typeof TradeSnapshots>["capture"]) =>
  render(
    <MemoryRouter>
      <TradeSnapshots trade={{ kind: "position", id: "p1" }} symbol="RELIANCE" segment="NSE" levels={levels} capture={capture} />
    </MemoryRouter>,
  );

describe("the pictures kept with a trade", () => {
  it("lists them oldest first, each saying what it is, when it was taken, the levels then, and the person's words", async () => {
    view();
    const items = await screen.findAllByTestId("trade-snapshot");
    expect(items).toHaveLength(2);
    expect(calls[0].url).toMatch(/\/positions\/p1\/images$/);
    expect(within(items[0]).getByText("Plan at entry", { selector: ".pill" })).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Entry 1,000 · Stop 950 · Target 1,100");
    expect(items[1]).toHaveTextContent("Update");
    expect(items[1]).toHaveTextContent("Moved the stop to breakeven");
    expect(items[1]).toHaveTextContent("Stop 1,000");
    expect(await within(items[0]).findByRole("img", { name: /RELIANCE chart: plan at entry/ })).toBeInTheDocument();
  });

  it("an option spread's pictures are read from the spread's own route", async () => {
    render(
      <MemoryRouter>
        <TradeSnapshots trade={{ kind: "group", id: "g1" }} symbol="NIFTY" segment="NSE" levels={levels} />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("trade-snapshot");
    expect(calls[0].url).toMatch(/\/option-groups\/g1\/images$/);
  });

  it("says so when there are none yet", async () => {
    snaps = [];
    view();
    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it("opens a picture larger", async () => {
    const user = userEvent.setup();
    view();
    const items = await screen.findAllByTestId("trade-snapshot");
    await user.click(await within(items[0]).findByRole("button", { name: /View the plan at entry picture larger/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("deletes one with a second click", async () => {
    const user = userEvent.setup();
    view();
    const items = await screen.findAllByTestId("trade-snapshot");
    await user.click(within(items[1]).getByRole("button", { name: "Delete snapshot" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(items[1]).getByRole("button", { name: "Confirm delete snapshot" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/images/s2"))).toBe(true));
  });
});

describe("saving a new snapshot", () => {
  it("photographs the chart with the levels in force and the person's note, keeps it as an update, and shows it", async () => {
    const capture = vi.fn().mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
    const user = userEvent.setup();
    view(capture);
    await screen.findAllByTestId("trade-snapshot");
    await user.type(screen.getByLabelText("Snapshot note"), "Redrew the supply zone");
    await user.click(screen.getByRole("button", { name: "Save a snapshot of the chart now" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(capture).toHaveBeenCalledWith("Update", { entry: 1000, stop: 1000, target: 1100 }, "Redrew the supply zone");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ kind: "update", caption: "Redrew the supply zone", entry_price: "1000", stop_price: "1000", target_price: "1100", file: "blob:image/png" });
    expect(await screen.findAllByTestId("trade-snapshot")).toHaveLength(3);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Snapshot note")).toHaveValue("");
  });

  it("says so, and saves nothing, when the chart cannot be photographed", async () => {
    const user = userEvent.setup();
    view(vi.fn().mockResolvedValue(null));
    await screen.findAllByTestId("trade-snapshot");
    await user.click(screen.getByRole("button", { name: "Save a snapshot of the chart now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be photographed/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows the server's reason when the picture is refused, and keeps the person's note", async () => {
    uploadFails = true;
    const user = userEvent.setup();
    view(vi.fn().mockResolvedValue("data:image/png;base64,iVBORw0KGgo="));
    await screen.findAllByTestId("trade-snapshot");
    await user.type(screen.getByLabelText("Snapshot note"), "keep me");
    await user.click(screen.getByRole("button", { name: "Save a snapshot of the chart now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("image too large");
    expect(screen.getByLabelText("Snapshot note")).toHaveValue("keep me");
  });

  it("where no chart is open, says where to take a new one instead of offering a button that cannot work", async () => {
    view();
    await screen.findAllByTestId("trade-snapshot");
    expect(screen.queryByRole("button", { name: /Save a snapshot/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trade page" })).toHaveAttribute("href", "/trade?symbol=RELIANCE&segment=NSE");
  });
});

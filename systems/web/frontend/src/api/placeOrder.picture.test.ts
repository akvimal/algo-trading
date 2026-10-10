import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderRequest } from "../pages/tradeModel";
import { placeOrder } from "./trade";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

type Call = { url: string; method: string; body: any };
let calls: Call[];
let uploadFails: boolean;

beforeEach(() => {
  calls = [];
  uploadFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body = raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, v instanceof Blob ? `blob:${v.type}` : v])) : raw ? JSON.parse(raw as string) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/images")) return uploadFails ? json({ detail: "disk full" }, 500) : json({ id: "img1", kind: "entry" });
      if (url.endsWith("/positions/manual")) return json({ id: "p1", status: "OPEN" });
      if (url.endsWith("/option-groups/manual")) return json({ id: "g1", status: "OPEN" });
      if (url.includes("/option-groups/g1/")) return json({ ok: true });
      if (url.endsWith("/pending-orders")) return json({ id: "o1", trigger_price: 980 });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const position: OrderRequest = { kind: "position", path: "/positions/manual", body: { symbol: "RELIANCE", price: 1000, stop_loss_price: 950, target_price: 1100 } };
const option: OrderRequest = { kind: "option", path: "/option-groups/manual", body: { symbol: "NIFTY" }, stop: 22900, target: 23300, combinedStop: null, combinedTarget: null };
const pending: OrderRequest = { kind: "pending", path: "/pending-orders", body: { symbol: "RELIANCE", trigger_price: 980 } };
const uploads = () => calls.filter((c) => c.url.endsWith("/images"));

describe("the plan picture goes with the order", () => {
  it("is kept with a spot or future trade that opens, with the entry, stop and target it was placed at", async () => {
    const result = await placeOrder(position, { planPicture: PICTURE });
    expect(result).toMatchObject({ ok: true, message: "Paper order placed." });
    expect(result.warning).toBeUndefined();
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].url).toMatch(/\/positions\/p1\/images$/);
    expect(uploads()[0].body).toMatchObject({ kind: "entry", caption: "The plan at entry", entry_price: "1000", stop_price: "950", target_price: "1100", file: "blob:image/png" });
  });

  it("is kept with an option spread against the spread, with the underlying's stop and target", async () => {
    await placeOrder(option, { planPicture: PICTURE });
    expect(uploads()[0].url).toMatch(/\/option-groups\/g1\/images$/);
    expect(uploads()[0].body).toMatchObject({ kind: "entry", stop_price: "22900", target_price: "23300" });
    expect(uploads()[0].body).not.toHaveProperty("entry_price");
  });

  it("rides with a waiting order, which the server attaches when it fills (nothing is uploaded now)", async () => {
    const result = await placeOrder(pending, { planPicture: PICTURE });
    expect(result.ok).toBe(true);
    expect(uploads()).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith("/pending-orders"))!.body).toMatchObject({ trigger_price: 980, plan_snapshot_png_base64: PICTURE });
  });

  it("does nothing extra without a picture, and sends the order exactly as before", async () => {
    await placeOrder(position);
    await placeOrder(pending, { planPicture: null });
    expect(uploads()).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith("/pending-orders"))!.body).not.toHaveProperty("plan_snapshot_png_base64");
  });

  it("never fails the order when the picture cannot be saved, and says so", async () => {
    uploadFails = true;
    const result = await placeOrder(position, { planPicture: PICTURE });
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/chart picture could not be saved/);
  });

  it("keeps the option's own warning about a stop that did not attach alongside the picture's", async () => {
    uploadFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/option-groups/manual")) return json({ id: "g1", status: "OPEN" });
        if (url.endsWith("/images")) return json({ detail: "disk full" }, 500);
        return json({ detail: "no" }, 422); // the stop and target do not attach
      }),
    );
    const result = await placeOrder(option, { planPicture: PICTURE });
    expect(result.warning).toMatch(/stop-loss and target did not attach/);
    expect(result.warning).toMatch(/chart picture could not be saved/);
  });

  it("takes no picture of a rejected order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: "p9", status: "REJECTED", rejection_reason: "insufficient balance" })));
    const result = await placeOrder(position, { planPicture: PICTURE });
    expect(result).toMatchObject({ ok: false, message: "insufficient balance" });
  });
});

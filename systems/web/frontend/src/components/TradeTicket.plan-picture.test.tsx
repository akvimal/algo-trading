import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider } from "../auth/ProfileContext";
import { EMPTY_TICKET, type Ticket } from "../pages/tradeModel";
import { TradeTicket } from "./TradeTicket";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PICTURE = "data:image/png;base64,iVBORw0KGgo=";
type Call = { url: string; method: string; body: any };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body = raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, v instanceof Blob ? `blob:${v.type}` : v])) : raw ? JSON.parse(raw as string) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/positions/manual")) return json({ id: "p1", status: "OPEN" });
      if (url.endsWith("/pending-orders")) return json({ id: "o1", trigger_price: body.trigger_price });
      if (url.endsWith("/images")) return json({ id: "img1" });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const ctx = { price: 1000, lotSize: 1, capital: 100000, riskPct: 1, minRR: 2, requireStop: false, segment: "NSE" as const, symbol: "RELIANCE" };

function Harness({ capturePlan, start }: { capturePlan?: React.ComponentProps<typeof TradeTicket>["capturePlan"]; start?: Partial<Ticket> }) {
  const [t, setT] = useState<Ticket>({ ...EMPTY_TICKET, stop: "950", target: "1100", ...start });
  return (
    <MemoryRouter>
      <ProfileProvider>
        <TradeTicket ticket={t} onChange={setT} ctx={ctx} meta={{ instrument: "spot", interval: "daily", trendFollowed: false }} regime={null} budget={null} onPlaced={() => {}} capturePlan={capturePlan} />
      </ProfileProvider>
    </MemoryRouter>
  );
}

const placeButton = () => screen.getByRole("button", { name: /Buy RELIANCE/ });
const order = () => calls.findIndex((c) => c.url.endsWith("/positions/manual") || c.url.endsWith("/pending-orders"));

describe("the chart is photographed as the order is placed", () => {
  it("takes the picture BEFORE the order goes, with the plan's entry, stop and target, and keeps it with the trade that opens", async () => {
    const seen: string[] = [];
    const capturePlan = vi.fn(async () => {
      seen.push(`orders sent so far: ${calls.filter((c) => c.url.endsWith("/positions/manual")).length}`);
      return PICTURE;
    });
    const user = userEvent.setup();
    render(<Harness capturePlan={capturePlan} />);
    await user.click(placeButton());
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/images"))).toBe(true));
    expect(capturePlan).toHaveBeenCalledTimes(1);
    expect(capturePlan).toHaveBeenCalledWith({ entry: 1000, stop: 950, target: 1100 });
    expect(seen).toEqual(["orders sent so far: 0"]); // nothing had been sent yet: the plan lines were still on the chart
    const upload = calls.find((c) => c.url.endsWith("/images"))!;
    expect(upload.url).toMatch(/\/positions\/p1\/images$/);
    expect(upload.body).toMatchObject({ kind: "entry", entry_price: "1000", stop_price: "950", target_price: "1100" });
    expect(order()).toBeLessThan(calls.indexOf(upload));
  });

  it("sends it with a waiting order, to be attached when the order fills", async () => {
    const user = userEvent.setup();
    render(<Harness capturePlan={async () => PICTURE} start={{ orderType: "limit", entry: "980" }} />);
    await user.click(screen.getByRole("button", { name: /wait for price/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pending-orders"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/pending-orders"))!.body).toMatchObject({ trigger_price: 980, plan_snapshot_png_base64: PICTURE });
    expect(calls.some((c) => c.url.endsWith("/images"))).toBe(false);
  });

  it("never stops the order when the picture cannot be taken", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        capturePlan={async () => {
          throw new Error("chart not ready");
        }}
      />,
    );
    await user.click(placeButton());
    expect(await screen.findByText("Paper order placed.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/images"))).toBe(false);
  });

  it("places the order as before where there is no chart to photograph", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(placeButton());
    expect(await screen.findByText("Paper order placed.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/images"))).toBe(false);
  });
});

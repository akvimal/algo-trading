import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../auth/token";
import { FakeWebSocket } from "../test/fakeSocket";
import { nextDelay, socketUrl, useQuoteSocket, type QuoteSubscription, type QuoteTick } from "./useQuoteSocket";

const NIFTY: QuoteSubscription = { exchange: "NSE", symbol: "NIFTY" };
const GOLD: QuoteSubscription = { exchange: "MCX", symbol: "GOLDM" };

const ws = () => FakeWebSocket.last!;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(initial: QuoteSubscription[], onTick: (t: QuoteTick) => void = () => undefined) {
  return renderHook(({ subs }) => useQuoteSocket(subs, onTick), { initialProps: { subs: initial } });
}

describe("connection", () => {
  it("uses the page's own origin and scheme, through the /ws proxy", () => {
    expect(socketUrl({ protocol: "http:", host: "localhost:8095" })).toBe("ws://localhost:8095/ws/quotes");
    expect(socketUrl({ protocol: "https:", host: "app.example.com" })).toBe("wss://app.example.com/ws/quotes");
  });

  it("is not connected until the socket opens, and reports it when it does", () => {
    const { result } = mount([NIFTY]);
    expect(result.current.connected).toBe(false);
    act(() => ws().open());
    expect(result.current.connected).toBe(true);
  });

  it("identifies the person first, then subscribes: the token never goes in the URL", () => {
    setToken("jwt.abc.def");
    mount([NIFTY, GOLD]);
    act(() => ws().open());
    expect(ws().url).not.toContain("jwt");
    expect(ws().sent).toEqual([
      { action: "auth", token: "jwt.abc.def" },
      { action: "subscribe", exchange: "NSE", symbol: "NIFTY" },
      { action: "subscribe", exchange: "MCX", symbol: "GOLDM" },
    ]);
  });

  it("sends no auth frame when signed out, but still subscribes", () => {
    mount([NIFTY]);
    act(() => ws().open());
    expect(ws().sent).toEqual([{ action: "subscribe", exchange: "NSE", symbol: "NIFTY" }]);
  });

  it("closes the connection when the screen goes away, and does not reconnect", () => {
    const { unmount } = mount([NIFTY]);
    act(() => ws().open());
    const socket = ws();
    unmount();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    act(() => vi.advanceTimersByTime(120_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("ticks", () => {
  it("hands snapshots and ticks to the caller", () => {
    const seen: QuoteTick[] = [];
    mount([NIFTY], (t) => seen.push(t));
    act(() => ws().open());
    act(() => ws().push({ type: "snapshot", exchange: "NSE", symbol: "NIFTY", price: 23140.5 }));
    act(() => ws().push({ type: "tick", exchange: "NSE", symbol: "NIFTY", price: 23141 }));
    expect(seen.map((t) => t.price)).toEqual([23140.5, 23141]);
  });

  it("ignores malformed frames and frames that are not prices, without dropping the connection", () => {
    const seen: QuoteTick[] = [];
    const { result } = mount([NIFTY], (t) => seen.push(t));
    act(() => ws().open());
    act(() => ws().push("not json {"));
    act(() => ws().push({ type: "tick", exchange: "NSE", symbol: "NIFTY" })); // no price
    act(() => ws().push({ type: "tick", exchange: "NSE", symbol: "NIFTY", price: "23000" })); // price as text
    act(() => ws().push({ type: "error", detail: "max 5 symbols per connection" }));
    expect(seen).toEqual([]);
    expect(result.current.connected).toBe(true);
  });

  it("always uses the latest callback, not the one from the first render", () => {
    const first: number[] = [];
    const second: number[] = [];
    const { rerender } = renderHook(({ cb }) => useQuoteSocket([NIFTY], cb), { initialProps: { cb: (t: QuoteTick) => first.push(t.price) } });
    act(() => ws().open());
    rerender({ cb: (t: QuoteTick) => second.push(t.price) });
    act(() => ws().push({ type: "tick", exchange: "NSE", symbol: "NIFTY", price: 1 }));
    expect(first).toEqual([]);
    expect(second).toEqual([1]);
  });

  it("notices when the server says live data needs the person's own keys", () => {
    const { result } = mount([NIFTY]);
    act(() => ws().open());
    expect(result.current.keysRequired).toBe(false);
    act(() => ws().push({ type: "error", code: "own_dhan_keys_required", detail: "add your own Dhan API keys" }));
    expect(result.current.keysRequired).toBe(true);
  });
});

describe("changing symbols", () => {
  it("sends only the difference on the same connection", () => {
    const { rerender } = mount([NIFTY]);
    act(() => ws().open());
    const socket = ws();
    socket.sent.length = 0;
    rerender({ subs: [GOLD] });
    expect(socket.sent).toEqual([
      { action: "subscribe", exchange: "MCX", symbol: "GOLDM" },
      { action: "unsubscribe", exchange: "NSE", symbol: "NIFTY" },
    ]);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect
  });

  it("sends nothing when the same symbols are passed as a new array", () => {
    const { rerender } = mount([NIFTY]);
    act(() => ws().open());
    ws().sent.length = 0;
    rerender({ subs: [{ ...NIFTY }] });
    expect(ws().sent).toEqual([]);
  });

  it("a symbol chosen before the socket opened is subscribed when it opens", () => {
    const { rerender } = mount([NIFTY]);
    rerender({ subs: [GOLD] }); // still connecting
    act(() => ws().open());
    expect(ws().sent).toEqual([{ action: "subscribe", exchange: "MCX", symbol: "GOLDM" }]);
  });
});

describe("reconnecting", () => {
  it("retries after a drop with a growing delay, resubscribes to the current symbols, and resets the delay once connected", () => {
    const { result, rerender } = mount([NIFTY]);
    act(() => ws().open());
    act(() => ws().drop());
    expect(result.current.connected).toBe(false);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet: first retry is after 1s
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);

    rerender({ subs: [GOLD] }); // changed while down
    act(() => ws().drop()); // fails to connect: next wait is 2s
    act(() => vi.advanceTimersByTime(1_999));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => ws().open());
    expect(result.current.connected).toBe(true);
    expect(ws().sent).toEqual([{ action: "subscribe", exchange: "MCX", symbol: "GOLDM" }]); // current, not the original
    act(() => ws().drop());
    act(() => vi.advanceTimersByTime(1_000)); // back to 1s after a successful connection
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("caps the delay", () => {
    expect(nextDelay(1_000)).toBe(2_000);
    expect(nextDelay(20_000)).toBe(30_000);
    expect(nextDelay(30_000)).toBe(30_000);
  });
});

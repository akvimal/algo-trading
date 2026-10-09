import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketInfoMenu } from "./MarketInfoMenu";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const digest = { bias: "bearish", bias_reason: "Crude is rising.", digest: "A soft open is likely.", articles: [{ title: "Markets slip", url: "https://e.com/a", source: "ET", published_at: "2026-10-08T03:00:00Z", image_url: null, relevance_score: 7, why: "Moves the index" }] };

let urls: string[];
function stub(routes: (url: string) => Response) {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (urls.push(url), routes(url))));
}
// Only the clock is faked (timers stay real): which NSE tab leads depends on whether the market has opened.
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
beforeEach(() => at("2026-10-08T03:00:00Z")); // Thursday 08:30 IST, before the open
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MarketInfoMenu", () => {
  it("loads nothing until opened, then shows the pre-market report first and the symbol's news on the News tab", async () => {
    stub((url) => (url.includes("/news") ? json(digest) : json({ detail: "none" }, 404)));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE"]} />);
    expect(urls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByText(/No pre-market report yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "News" }));
    expect(await screen.findByRole("link", { name: "Markets slip" })).toHaveAttribute("href", "https://e.com/a");
    expect(screen.getByText("A soft open is likely.")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("/news?underlying=NIFTY&segment=NSE"))).toBe(true);
  });

  it("MCX and crypto get their own brief, built from /market-brief, with its own sections and the News tab beside it", async () => {
    const brief = {
      day: "2026-10-08", generated_at: new Date().toISOString(), bias: "bullish", agree: null, model: null, ai_error: "No OpenRouter key - showing the rule-based bias only.",
      inputs: [{ key: "btc", label: "Bitcoin", group: "crypto", ok: true, value: 62000, change: 1.4, unit: "pct", source: "yahoo", error: null }, { key: "fear_greed", label: "Crypto Fear & Greed", group: "risk", ok: true, value: 40, change: 3, unit: "pt", source: "alternative.me", error: null }],
      rules: { score: 0.4, bias: "bullish", coverage: 0.6, gift_gap_pct: null, factors: [] }, ai: null, macro: null,
    };
    stub((url) => (url.includes("/market-brief/CRYPTO") ? json(brief) : json(digest)));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="CRYPTO" symbol="BTCUSD" markets={["CRYPTO"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByRole("heading", { name: "Market brief" })).toBeInTheDocument();
    expect(await screen.findByTestId("premarket-bias")).toHaveTextContent("Bullish");
    await user.click(screen.getByText("Reasoning and numbers"));
    expect(screen.getByText("Bitcoin")).toBeInTheDocument();
    expect(screen.getByText("+3.0 pts")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("/premarket"))).toBe(false);
    await user.click(screen.getByRole("tab", { name: "News" }));
    expect(await screen.findByRole("link", { name: "Markets slip" })).toBeInTheDocument();
  });

  it("says so when a symbol has no news feed rather than showing an error", async () => {
    stub(() => json({ detail: "no news source" }, 404));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="MCX" symbol="XYZ" markets={["MCX"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    await user.click(screen.getByRole("tab", { name: "News" }));
    expect(await screen.findByText(/No news feed is set up for XYZ/)).toBeInTheDocument();
  });

  it("opens on the chart's market, and the pills read another market without leaving the chart", async () => {
    stub((url) => (url.includes("/news") ? json(digest) : url.includes("/premarket") ? json({ detail: "none" }, 404) : json({ detail: "x" }, 500)));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="MCX" symbol="GOLDM" markets={["NSE", "MCX", "CRYPTO"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(screen.getByRole("button", { name: "MCX", pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "NSE" }));
    expect(await screen.findByText(/No pre-market report yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "News" }));
    await screen.findByRole("link", { name: "Markets slip" });
    expect(urls.some((u) => u.includes("/news?underlying=NIFTY&segment=NSE"))).toBe(true); // the market's own index, not the MCX chart's symbol
  });

  it("says the AI read is being prepared while the server builds it, and checks back", async () => {
    const brief = { day: "2026-10-08", generated_at: new Date().toISOString(), bias: "neutral", agree: null, model: null, ai_error: null, ai_pending: true, inputs: [], rules: { score: 0, bias: "neutral", coverage: 1, gift_gap_pct: null, factors: [] }, ai: null, macro: null };
    stub(() => json(brief));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="MCX" symbol="GOLDM" markets={["MCX"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByTestId("ai-pending")).toBeInTheDocument();
  });

  const pulse = (over: Record<string, unknown> = {}) => ({
    day: "2026-10-08", generated_at: new Date().toISOString(), bias: "bearish", agree: null, model: null, ai_error: null,
    inputs: [{ key: "nifty", label: "Nifty 50", group: "index", ok: true, value: 22400, change: -0.8, unit: "pct", source: "yahoo", error: null }, { key: "indiavix", label: "India VIX", group: "risk", ok: true, value: 15, change: 4, unit: "pct", source: "yahoo", error: null }],
    rules: { score: -0.5, bias: "bearish", coverage: 1, gift_gap_pct: null, factors: [] }, ai: null, macro: null, ...over,
  });

  it("once the NSE market has opened it leads with the live pulse, with the morning report one tab over", async () => {
    at("2026-10-08T04:30:00Z"); // 10:00 IST
    stub((url) => (url.includes("/market-brief/NSE") ? json(pulse()) : url.includes("/premarket") ? json({ detail: "none" }, 404) : json(digest)));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByRole("heading", { name: "Market pulse" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pulse", selected: true })).toBeInTheDocument();
    await user.click(screen.getByText("Reasoning and numbers"));
    expect(screen.getByText("Nifty 50")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("/premarket"))).toBe(false); // the morning report is not fetched until its tab is opened
    await user.click(screen.getByRole("tab", { name: "Pre-market" }));
    expect(await screen.findByText(/No pre-market report yet/)).toBeInTheDocument();
  });

  it("leads with the morning report at the weekend and before the open, and has no Pulse tab on MCX or crypto", async () => {
    at("2026-10-10T05:00:00Z"); // Saturday
    stub(() => json({ detail: "none" }, 404));
    const user = userEvent.setup();
    const { unmount } = render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByRole("tab", { name: "Pre-market", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pulse" })).toBeInTheDocument();
    unmount();
    render(<MarketInfoMenu segment="MCX" symbol="GOLDM" markets={["MCX"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(screen.queryByRole("tab", { name: "Pulse" })).not.toBeInTheDocument();
  });

  it("says when the AI read was kept because the numbers had not meaningfully changed", async () => {
    at("2026-10-08T04:30:00Z");
    stub(() => json(pulse({ ai_reused: true, ai_read_at: "2026-10-08T04:15:00Z", ai: { bias: "bearish", confidence: 50, one_liner: "Weak tape.", reasons: [], risks: [], watch: "" } })));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    expect(await screen.findByTestId("ai-reused")).toHaveTextContent(/not meaningfully changed since the AI read at .*no new AI call/);
  });

  it("the Calendar tab lists the next days grouped by day, with times, impact and the figures the feed gave, and names what is missing", async () => {
    const cal = {
      segment: "NSE", start: "2026-10-08", end: "2026-10-14", notes: ["MCX contract expiry dates are not included yet."],
      events: [
        { date: "2026-10-08", time: "18:00", title: "USD: Unemployment Claims", kind: "global", impact: "medium", detail: null, forecast: "230K", previous: "225K", actual: null },
        { date: "2026-10-12", time: null, title: "India CPI inflation", kind: "data", impact: "high", detail: null, forecast: null, previous: null, actual: null },
        { date: "2026-10-12", time: null, title: "Nifty weekly options expiry", kind: "expiry", impact: "medium", detail: "Moved from Tuesday 20 Oct, an exchange holiday.", forecast: null, previous: null, actual: null },
      ],
    };
    stub((url) => (url.includes("/calendar/upcoming?segment=NSE") ? json(cal) : json({ detail: "none" }, 404)));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    await user.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(await screen.findByText("USD: Unemployment Claims")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today · Thu 8 Oct" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mon 12 Oct" })).toBeInTheDocument();
    expect(screen.getByText("18:00")).toBeInTheDocument();
    expect(screen.getByText(/Global · Forecast 230K · Previous 225K/)).toBeInTheDocument();
    expect(screen.getAllByText("All day")).toHaveLength(2);
    expect(screen.getByTitle("High impact")).toHaveTextContent("High");
    expect(screen.getByText(/Moved from Tuesday 20 Oct/)).toBeInTheDocument();
    expect(screen.getByText("MCX contract expiry dates are not included yet.")).toBeInTheDocument();
  });

  it("says plainly when nothing is scheduled, and the calendar follows the market chosen with the pills", async () => {
    stub((url) => json({ segment: url.includes("MCX") ? "MCX" : "NSE", start: "2026-10-08", end: "2026-10-14", events: [], notes: [] }));
    const user = userEvent.setup();
    render(<MarketInfoMenu segment="NSE" symbol="NIFTY" markets={["NSE", "MCX"]} />);
    await user.click(screen.getByRole("button", { name: /Market info/ }));
    await user.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(await screen.findByText(/Nothing scheduled in the next 7 days/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "MCX" }));
    expect(await screen.findByRole("heading", { name: /Next 7 days · MCX/ })).toBeInTheDocument();
    expect(urls.some((u) => u.includes("/calendar/upcoming?segment=MCX"))).toBe(true);
  });
});

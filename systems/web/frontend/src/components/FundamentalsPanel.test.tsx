import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FundamentalsPanel, readAge } from "./FundamentalsPanel";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Call = { url: string };
let calls: Call[];
let reply: () => Response;

const read = (over: object = {}) => ({
  symbol: "RELIANCE", bias: "bullish", confidence: 0.72, summary: "Steady profit growth and falling debt.", pros: ["Debt reduced"], cons: ["Valuation is high"],
  reasons: ["Profit up three years running"], fetched_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), refreshed: false, ...over,
});

beforeEach(() => {
  calls = [];
  reply = () => json(read());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push({ url });
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const view = () =>
  render(
    <MemoryRouter>
      <FundamentalsPanel symbol="RELIANCE" />
    </MemoryRouter>,
  );

describe("the fundamentals button", () => {
  it("does nothing until it is pressed", () => {
    view();
    expect(screen.getByRole("button", { name: "Fundamentals (AI)" })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("reads the stock on demand and shows the bias, summary, pros and cons and how old the read is", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    expect(await screen.findByText("Steady profit growth and falling debt.")).toBeInTheDocument();
    expect(calls[0].url).toMatch(/\/fundamentals\/RELIANCE$/);
    const card = screen.getByTestId("fundamentals");
    expect(card).toHaveTextContent("bullish");
    expect(card).toHaveTextContent("72% sure");
    expect(card).toHaveTextContent("Debt reduced");
    expect(card).toHaveTextContent("Valuation is high");
    expect(card).toHaveTextContent("Profit up three years running");
    expect(card).toHaveTextContent("3 days ago");
    expect(screen.getByRole("link", { name: /See what the AI read/ })).toHaveAttribute("href", expect.stringMatching(/\/weekly-advisor\/fundamentals\/RELIANCE\/screenshot$/));
    expect(card).toHaveTextContent(/Not advice/);
  });

  it("says it can take a while while it is reading", async () => {
    let release: () => void = () => undefined;
    reply = () => {
      throw new Error("not used");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(json(read()))))),
    );
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/up to a minute/);
    release();
    expect(await screen.findByText("Steady profit growth and falling debt.")).toBeInTheDocument();
  });
});

describe("refreshing", () => {
  it("asks for a fresh capture, and says so when the read was too recent to capture again", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    await screen.findByText("Steady profit growth and falling debt.");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("?refresh=true"))).toBe(true));
    expect(await screen.findByText(/less than a day old/)).toBeInTheDocument();
  });

  it("shows nothing about age limits when a fresh capture was made", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    await screen.findByText("Steady profit growth and falling debt.");
    reply = () => json(read({ refreshed: true, fetched_at: new Date().toISOString() }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByTestId("fundamentals")).toHaveTextContent("today"));
    expect(screen.queryByText(/less than a day old/)).not.toBeInTheDocument();
  });
});

describe("when it cannot be read", () => {
  it("points to Settings when an OpenRouter key is needed", async () => {
    reply = () => json({ detail: "Fundamentals are read by AI and need an OpenRouter key: add yours in Settings." }, 409, { "x-error-code": "openrouter_key_required" });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/OpenRouter key/);
    expect(screen.getByRole("link", { name: /Add your key in Settings/ })).toHaveAttribute("href", "/more/settings?tab=broker");
  });

  it("shows the server's message and offers to try again for any other failure", async () => {
    reply = () => json({ detail: "Could not read screener.in for RELIANCE. It may not be listed there, or the site is unavailable right now." }, 503);
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not read screener.in/);
    reply = () => json(read());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Steady profit growth and falling debt.")).toBeInTheDocument();
  });

  it("keeps the earlier read on screen when a refresh fails", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Fundamentals (AI)" }));
    await screen.findByText("Steady profit growth and falling debt.");
    reply = () => json({ detail: "The AI could not read this company's page right now. Try again in a minute." }, 502);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not read/);
    expect(screen.getByText("Steady profit growth and falling debt.")).toBeInTheDocument();
  });
});

describe("how old a read is", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  it("says today, yesterday, or the number of days", () => {
    expect(readAge("2026-10-12T02:00:00Z", now)).toBe("today");
    expect(readAge("2026-10-11T08:00:00Z", now)).toBe("yesterday");
    expect(readAge("2026-10-02T08:00:00Z", now)).toBe("10 days ago");
    expect(readAge(null, now)).toBe("");
  });
});

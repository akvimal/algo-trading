import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let profile: Record<string, any>;

beforeEach(() => {
  profile = {
    id: "u1", email: "me@x.com", name: "Me", is_admin: false, experience: "guided", onboarded_at: "2026-09-01T00:00:00Z",
    markets: ["NSE", "MCX", "CRYPTO"], default_instrument: "future", default_option_strategy: "naked",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me") && method === "GET") return json(profile);
      if (url.endsWith("/auth/me/preferences") && method === "PUT") {
        const body = JSON.parse(init!.body as string);
        const { segment_defaults, ...rest } = body;
        profile = { ...profile, ...rest, ...(segment_defaults ? { segment_defaults: { ...(profile.segment_defaults ?? {}), ...segment_defaults } } : {}) };
        return json(profile);
      }
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("default trade instrument, per market", () => {
  it("starts every market on Future, with no option-strategy choice shown, when nothing has been chosen", async () => {
    renderAt("/more");
    expect(await screen.findByRole("radiogroup", { name: "NSE default instrument" })).toBeInTheDocument();
    for (const m of ["MCX", "CRYPTO"]) expect(screen.getByRole("radiogroup", { name: `${m} default instrument` })).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: "Future", checked: true })).toHaveLength(3);
    expect(screen.queryByRole("radiogroup", { name: /default option strategy/ })).not.toBeInTheDocument();
  });

  it("choosing Option for one market saves only that market and reveals its naked/spread, defaulting to naked", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    const nse = within(await screen.findByRole("radiogroup", { name: "NSE default instrument" }));
    await user.click(nse.getByRole("radio", { name: "Option" }));
    await waitFor(() => expect(profile.segment_defaults.NSE).toEqual({ instrument: "option", option_strategy: "naked" }));
    const style = within(screen.getByRole("radiogroup", { name: "NSE default option strategy" }));
    expect(style.getByRole("radio", { name: "Naked" })).toHaveAttribute("aria-checked", "true");
    expect(profile.segment_defaults.CRYPTO).toBeUndefined();
    expect(screen.getAllByRole("radiogroup", { name: /default option strategy/ })).toHaveLength(1);
    expect(profile.default_instrument).toBe("future"); // the general default is untouched
  });

  it("choosing Spread keeps the instrument, and Future hides the style again", async () => {
    profile.segment_defaults = { MCX: { instrument: "option", option_strategy: "naked" } };
    const user = userEvent.setup();
    renderAt("/more");
    const style = within(await screen.findByRole("radiogroup", { name: "MCX default option strategy" }));
    await user.click(style.getByRole("radio", { name: "Spread" }));
    await waitFor(() => expect(profile.segment_defaults.MCX).toEqual({ instrument: "option", option_strategy: "spread" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "MCX default instrument" })).getByRole("radio", { name: "Future" }));
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "MCX default option strategy" })).not.toBeInTheDocument());
  });

  it("a market with no choice of its own follows the general default", async () => {
    profile.default_instrument = "option";
    profile.default_option_strategy = "spread";
    profile.segment_defaults = { CRYPTO: { instrument: "future", option_strategy: "naked" } };
    renderAt("/more");
    const nse = within(await screen.findByRole("radiogroup", { name: "NSE default instrument" }));
    expect(nse.getByRole("radio", { name: "Option" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "NSE default option strategy" })).getByRole("radio", { name: "Spread" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "CRYPTO default instrument" })).getByRole("radio", { name: "Future" })).toHaveAttribute("aria-checked", "true");
  });

  it("only lists the markets they practise", async () => {
    profile.markets = ["NSE"];
    renderAt("/more");
    await screen.findByRole("radiogroup", { name: "NSE default instrument" });
    expect(screen.queryByRole("radiogroup", { name: "MCX default instrument" })).not.toBeInTheDocument();
  });

  it("shows a notice and keeps the old choice if saving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/auth/me") && method === "GET") return json(profile);
        if (url.endsWith("/auth/me/preferences") && method === "PUT") return json({ detail: "server down" }, 500);
        return json({ detail: `unrouted ${url}` }, 404);
      }),
    );
    const user = userEvent.setup();
    renderAt("/more");
    const nse = within(await screen.findByRole("radiogroup", { name: "NSE default instrument" }));
    await user.click(nse.getByRole("radio", { name: "Option" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/server down|Could not save/);
    expect(nse.getByRole("radio", { name: "Future" })).toHaveAttribute("aria-checked", "true"); // unchanged
  });
});

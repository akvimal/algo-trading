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

let experience: "guided" | "pro";
let calls: string[];

beforeEach(() => {
  experience = "guided";
  calls = [];
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/auth/me")) return json({ id: "u1", email: "me@x.com", name: "Me", is_admin: false, experience, onboarded_at: "2026-09-01T00:00:00Z", markets: ["NSE"] });
      if (url.includes("/accounts")) return json([]);
      if (url.includes("/positions") || url.includes("/option-groups")) return json([]);
      if (url.includes("/options/sentiment")) return json({ exchanges: {} });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (path = "/") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
const nav = () => within(screen.getByRole("navigation", { name: "Main" }));
const findNav = async () => within(await screen.findByRole("navigation", { name: "Main" }));

describe("the collapsible sidebar", () => {
  it("starts expanded for a Guided person, and remembers a collapse", async () => {
    const user = userEvent.setup();
    renderAt();
    const toggle = await screen.findByRole("button", { name: "Collapse navigation" });
    expect(nav().getByText("Today")).toBeInTheDocument(); // the label is there, not just sr-only
    await user.click(toggle);
    expect(screen.getByRole("navigation", { name: "Main" })).toHaveClass("collapsed");
    expect(await screen.findByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
    expect(localStorage.getItem("web.nav.collapsed")).toBe("true");
  });

  it("starts collapsed for a Pro person who has never chosen", async () => {
    experience = "pro";
    renderAt();
    expect(await screen.findByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
  });

  it("an explicit choice overrides Guided/Pro, either way, and stays overridden once the profile loads", async () => {
    localStorage.setItem("web.nav.collapsed", "true");
    renderAt(); // still guided, but the person collapsed it themselves before
    expect(await screen.findByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((u) => u.includes("/auth/me"))).toBe(true)); // the profile has been asked for
    await new Promise((r) => setTimeout(r, 0)); // let its response (and the effect it drives) settle
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeInTheDocument(); // still collapsed, not reset to Guided's own default
  });

  it("keeps every destination reachable while collapsed, just without visible labels", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Collapse navigation" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toHaveClass("collapsed"));
    for (const label of ["Today", "Scan", "Trade", "Portfolio", "More"]) expect(nav().getByRole("link", { name: label })).toBeInTheDocument();
  });
});

describe("sign out from the sidebar", () => {
  it("is reachable without going into More", async () => {
    renderAt("/scan");
    expect(await (await findNav()).findByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out and returns to the sign-in screen", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await (await findNav()).findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: /Sign in|Welcome/i })).toBeInTheDocument();
  });
});

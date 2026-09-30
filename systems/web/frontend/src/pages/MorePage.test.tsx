import { render, screen, waitFor } from "@testing-library/react";
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
        profile = { ...profile, ...JSON.parse(init!.body as string) };
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

describe("default trade instrument", () => {
  it("starts on Future, with no option-strategy choice shown, when nothing has been chosen", async () => {
    renderAt("/more");
    expect(await screen.findByRole("radio", { name: "Future" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Option" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Default option strategy")).not.toBeInTheDocument();
  });

  it("choosing Option saves it and reveals naked/spread, defaulting to naked", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    await user.click(await screen.findByRole("radio", { name: "Option" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Option" })).toHaveAttribute("aria-checked", "true"));
    expect(profile.default_instrument).toBe("option");
    expect(screen.getByRole("radio", { name: "Naked" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Spread" })).toHaveAttribute("aria-checked", "false");
  });

  it("choosing Spread saves it independently of the instrument choice", async () => {
    profile.default_instrument = "option";
    const user = userEvent.setup();
    renderAt("/more");
    await user.click(await screen.findByRole("radio", { name: "Spread" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Spread" })).toHaveAttribute("aria-checked", "true"));
    expect(profile.default_option_strategy).toBe("spread");
    expect(profile.default_instrument).toBe("option"); // unaffected
  });

  it("hides the option-strategy choice again once switched back to Future, without losing the saved style", async () => {
    profile.default_instrument = "option";
    profile.default_option_strategy = "spread";
    const user = userEvent.setup();
    renderAt("/more");
    expect(await screen.findByText("Default option strategy")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Future" }));
    await waitFor(() => expect(screen.queryByText("Default option strategy")).not.toBeInTheDocument());
    expect(profile.default_option_strategy).toBe("spread"); // still there, just not shown
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
    await user.click(await screen.findByRole("radio", { name: "Option" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/server down|Could not save/);
    expect(screen.getByRole("radio", { name: "Future" })).toHaveAttribute("aria-checked", "true"); // unchanged
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, describeDetail, setUnauthorizedHandler } from "./http";
import { setToken } from "../auth/token";

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the request to fail");
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe("api", () => {
  it("sends the bearer token and returns the JSON", async () => {
    setToken("tok");
    fetchMock().mockResolvedValue(reply(200, { ok: 1 }));
    expect(await api("execution", "/accounts")).toEqual({ ok: 1 });
    const init = fetchMock().mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("does not send the token to public endpoints", async () => {
    setToken("tok");
    fetchMock().mockResolvedValue(reply(200, {}));
    await api("accounts", "/auth/login", { method: "POST", json: { a: 1 }, auth: false });
    const init = fetchMock().mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.body).toBe('{"a":1}');
  });

  it("surfaces the own-keys error as a typed code, from the header", async () => {
    fetchMock().mockResolvedValue(reply(403, { detail: "add your keys" }, { "x-error-code": "own_dhan_keys_required" }));
    const err = await fail(api("marketData", "/quotes/ltp"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.keysRequired).toBe(true);
  });

  it("recognises the own-keys error from a prefixed message too", async () => {
    fetchMock().mockResolvedValue(reply(403, { detail: "own_dhan_keys_required: Add your Dhan keys" }));
    const err = await fail(api("marketData", "/quotes/ltp"));
    expect(err.keysRequired).toBe(true);
    expect(err.message).toBe("Add your Dhan keys"); // the machine prefix is not shown to people
  });

  it("signs the user out on a 401 for a signed-in request", async () => {
    setToken("tok");
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock().mockResolvedValue(reply(401, { detail: "expired" }));
    await api("execution", "/accounts").catch(() => undefined);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does NOT sign out on a 401 from a wrong password at login", async () => {
    setToken("tok");
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock().mockResolvedValue(reply(401, { detail: "Invalid email or password" }));
    const err = await fail(api("accounts", "/auth/login", { method: "POST", json: {}, auth: false }));
    expect(handler).not.toHaveBeenCalled();
    expect(err.message).toBe("Invalid email or password");
  });

  it("reports an unreachable server as a network error", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await fail(api("execution", "/accounts"));
    expect(err.status).toBe(0);
    expect(err.code).toBe("network");
  });

  it("returns undefined for 204", async () => {
    fetchMock().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await api("execution", "/x", { method: "DELETE" })).toBeUndefined();
  });
});

describe("describeDetail", () => {
  it("flattens FastAPI validation errors", () => {
    const body = { detail: [{ loc: ["body", "password"], msg: "too short" }, { loc: ["body"], msg: "bad" }] };
    expect(describeDetail(body)).toBe("password: too short; bad");
  });
});

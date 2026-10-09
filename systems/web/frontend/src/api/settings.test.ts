import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCredentials } from "./settings";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const saved = { has_dhan: true, dhan_client_id: "10****" };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const urls = () => fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0])}`);

describe("saveCredentials", () => {
  it("saves the keys, then tells market-data to drop its cached copy of them", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, saved)).mockResolvedValueOnce(reply(200, { forgotten: true }));
    const out = await saveCredentials({ dhan_access_token: "x" });
    expect(out).toEqual(saved);
    const calls = urls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^PUT .*\/credentials$/);
    expect(calls[1]).toMatch(/^POST .*\/dhan\/forget-my-credentials$/);
  });

  it("still reports the save as done when the cache could not be cleared", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, saved)).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(saveCredentials({ dhan_access_token: "x" })).resolves.toEqual(saved);
  });

  it("does not tell market-data anything when the save itself failed", async () => {
    fetchMock.mockResolvedValueOnce(reply(422, { detail: "bad" }));
    await expect(saveCredentials({ dhan_access_token: "x" })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { clearToken, decodeClaims, getToken, isExpired, setToken } from "./token";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

describe("token store", () => {
  it("round-trips and clears", () => {
    setToken("abc", "a@b.com");
    expect(getToken()).toBe("abc");
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe("claims", () => {
  it("decodes url-safe base64 payloads", () => {
    const claims = decodeClaims(jwt({ sub: "u1", is_admin: true, email: "é?>@x.com", exp: 4102444800 }));
    expect(claims?.is_admin).toBe(true);
    expect(claims?.sub).toBe("u1");
  });

  it("treats garbage as no claims, and expired-or-unreadable as expired", () => {
    expect(decodeClaims("nonsense")).toBeNull();
    expect(decodeClaims(null)).toBeNull();
    expect(isExpired("nonsense")).toBe(true);
    expect(isExpired(null)).toBe(true);
  });

  it("compares expiry against the clock", () => {
    const token = jwt({ exp: 1000 });
    expect(isExpired(token, 999_000)).toBe(false);
    expect(isExpired(token, 1_000_000)).toBe(true);
    expect(isExpired(jwt({ sub: "no-exp" }))).toBe(false); // no exp claim: the server decides
  });
});

// The one login. This app has its own session (own localStorage key), separate from the
// classic iframe shell's, so the two never fight over a token while both exist. The token
// is the same accounts-issued JWT every backend already verifies.

const TOKEN_KEY = "web.authToken";
const EMAIL_KEY = "web.authEmail";

export type TokenClaims = { sub?: string; is_admin?: boolean; email?: string; exp?: number };

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked (private mode): behave as signed out rather than crash
  }
}

export function setToken(token: string, email?: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (email) localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* nothing to do: the session simply will not survive a reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
}

export function getEmail(): string | null {
  try {
    return localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

/** Reads the claims for DISPLAY and expiry only. It does not verify the signature: the
 * server does that on every request, and a forged token gets a 401 there. */
export function decodeClaims(token: string | null): TokenClaims | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(json) as TokenClaims;
  } catch {
    return null;
  }
}

export function isExpired(token: string | null, nowMs: number = Date.now()): boolean {
  const claims = decodeClaims(token);
  if (!claims) return true;
  return claims.exp != null && claims.exp * 1000 <= nowMs;
}

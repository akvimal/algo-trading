// Identity for the manual-trading SaaS (systems/accounts, see
// docs/architecture.md § "Manual Trading SaaS"). Called directly from the
// browser (CORS-enabled), same direct-from-browser cross-system pattern
// api.ts already uses for market-data/signal-generation - NOT execution's
// own /api proxy, since this isn't execution's data.

const ACCOUNTS_PORT = import.meta.env.VITE_ACCOUNTS_PORT ?? "8004";
const ACCOUNTS_BASE_URL = `http://${location.hostname}:${ACCOUNTS_PORT}`;

const TOKEN_KEY = "authToken";
const EMAIL_KEY = "authEmail";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

// Cached alongside the token purely for display (Nav's "logged in as ..."
// line) so it doesn't need its own GET /auth/me round-trip - AuthGate's own
// startup check already fetches the authoritative value.
export function getAuthEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY);
}

export function setAuthEmail(email: string): void {
  localStorage.setItem(EMAIL_KEY, email);
}

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export type CurrentUser = { id: string; email: string; is_admin: boolean };

export async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${ACCOUNTS_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await extractErrorDetail(res));
  const body = await res.json();
  return body.access_token as string;
}

export async function signup(email: string, password: string): Promise<string> {
  const res = await fetch(`${ACCOUNTS_BASE_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await extractErrorDetail(res));
  const body = await res.json();
  return body.access_token as string;
}

export async function fetchCurrentUser(token: string): Promise<CurrentUser> {
  const res = await fetch(`${ACCOUNTS_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await extractErrorDetail(res));
  return res.json();
}

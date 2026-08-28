// Admin identity for the Dhan data-provider section only (App.tsx's
// DhanAdminSection) - most of this dashboard (health, instrument sync,
// Delta's feed) needs no login at all, since only market-data's own Dhan
// ops routes (/dhan/credentials, /dhan/renew-token, /dhan/feed-status,
// /dhan/feed/subscribe) are admin-gated server-side (require_admin, see
// docs/architecture.md). Same accounts-backend/JWT mechanism
// execution/frontend already uses for its own (whole-app) admin gate -
// duplicated, not shared, matching that file's own copy-not-share
// precedent.

const ACCOUNTS_PORT = import.meta.env.VITE_ACCOUNTS_PORT ?? "8004";
const ACCOUNTS_BASE_URL = `http://${location.hostname}:${ACCOUNTS_PORT}`;

const TOKEN_KEY = "authToken";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  notifyShellOfToken(token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  notifyShellOfToken(null);
}

// Applies a token the SHELL told us about (see below) - local storage only,
// deliberately not routed through setAuthToken/clearAuthToken above, which
// would notify the shell right back and ping-pong between every embedded
// frontend forever.
export function applySharedToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// --- Shared login session across all embedded frontends -----------------
// Each frontend is its own browser origin (different port), so logging in
// on one doesn't carry over to another by default. The shell
// (shell/index.html) brokers a shared session across every frontend it
// embeds as an iframe - see its own comment for the full design. Only
// does anything when actually embedded there (window.parent !== window);
// standalone (e.g. `npm run dev` in a plain browser tab) skips all of
// this and behaves exactly as before. Since only DhanAdminSection needs
// a session at all here (the rest of this dashboard is public), this just
// means logging in there once (in any frontend, as the same admin) skips
// re-entering credentials for that section too.

function notifyShellOfToken(token: string | null): void {
  if (window.parent === window) return;
  window.parent.postMessage({ source: "algo-trading-app", type: "auth-token", token }, "*");
}

// One-shot: asks the shell for its shared token - resolves null if not
// embedded in the shell, or it doesn't reply within the timeout
// (standalone dev, or the shell has no session of its own yet either).
export function requestSharedToken(): Promise<string | null> {
  if (window.parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    function onMessage(event: MessageEvent) {
      if (!event.data || event.data.source !== "algo-trading-shell" || event.data.type !== "auth-token") return;
      window.removeEventListener("message", onMessage);
      resolve(event.data.token ?? null);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ source: "algo-trading-app", type: "request-token" }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 400);
  });
}

// Ongoing (unlike requestSharedToken's one-shot ask) - fires whenever a
// DIFFERENT frontend logs in/out later, e.g. this tab is already sitting
// on the login prompt when another tab authenticates. Returns an
// unsubscribe function for the caller's own cleanup.
export function subscribeToSharedToken(onToken: (token: string | null) => void): () => void {
  if (window.parent === window) return () => {};
  function onMessage(event: MessageEvent) {
    if (!event.data || event.data.source !== "algo-trading-shell" || event.data.type !== "auth-token") return;
    onToken(event.data.token ?? null);
  }
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export type CurrentUser = { id: string; email: string; name: string; is_admin: boolean };

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

export async function fetchCurrentUser(token: string): Promise<CurrentUser> {
  const res = await fetch(`${ACCOUNTS_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await extractErrorDetail(res));
  return res.json();
}

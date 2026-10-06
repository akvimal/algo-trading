import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api/http";
import type { TokenResponse } from "../api/types";
import { clearToken, decodeClaims, getEmail, getToken, isExpired, setToken } from "./token";

type Session = { email: string | null; isAdmin: boolean };

type AuthValue = {
  session: Session | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { name: string; email: string; password: string; acceptRisk: boolean }) => Promise<void>;
  signOut: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

function readSession(): Session | null {
  const token = getToken();
  if (!token || isExpired(token)) {
    if (token) clearToken(); // an expired token is useless; do not keep sending it
    return null;
  }
  const claims = decodeClaims(token);
  return { email: claims?.email ?? getEmail(), isAdmin: Boolean(claims?.is_admin) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession);

  const signOut = useCallback(() => {
    clearToken();
    setSession(null);
  }, []);

  // A 401 on a signed-in request means the server no longer accepts the token (expired,
  // rotated secret): drop the session and the router sends the user to sign in.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const accept = useCallback((token: string, email: string) => {
    setToken(token, email);
    setSession(readSession());
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api<TokenResponse>("accounts", "/auth/login", { method: "POST", json: { email, password }, auth: false });
      accept(res.access_token, email);
    },
    [accept],
  );

  const signUp = useCallback(
    async ({ name, email, password, acceptRisk }: { name: string; email: string; password: string; acceptRisk: boolean }) => {
      const res = await api<TokenResponse>("accounts", "/auth/signup", {
        method: "POST",
        json: { name, email, password, accept_risk_disclosure: acceptRisk },
        auth: false,
      });
      accept(res.access_token, email);
    },
    [accept],
  );

  const value = useMemo(() => ({ session, signIn, signUp, signOut }), [session, signIn, signUp, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Whether the signed-in person is an admin. False when nobody is signed in or there is no provider, so a screen that shows
 * operator-only controls fails closed. (The server checks again on every call; this only decides what is shown.) */
export function useIsAdmin(): boolean {
  return Boolean(useContext(AuthContext)?.session?.isAdmin);
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

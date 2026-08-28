import { ReactNode, useEffect, useState } from "react";
import {
  applySharedToken,
  clearAuthToken,
  CurrentUser,
  fetchCurrentUser,
  getAuthToken,
  requestSharedToken,
  setAuthEmail,
  subscribeToSharedToken,
} from "./auth";
import LoginPage from "./LoginPage";

type Status = "checking" | "authenticated" | "unauthenticated";

// Gates the whole app behind a logged-in session - added so Algo Trading
// isn't the one tab left open once every sibling module requires a login
// (execution/manual-trading/market-data's Dhan panel all already do).
// signal-engine's own backend has no auth of its own (every route stays
// open) - this is a frontend-only gate, same as manual-trading's. Any
// authenticated account is enough (not admin-only, unlike execution's
// AuthGate) - the shell's own top bar shows an "Admin" indicator next to
// the username when the logged-in account happens to be one, see
// shell/index.html. Sits outside the existing "?tab=" routing in App.tsx,
// which stays completely unchanged.
export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");

  function checkToken(token: string) {
    fetchCurrentUser(token)
      .then((u: CurrentUser) => {
        setAuthEmail(u.email);
        setStatus("authenticated");
      })
      .catch(() => {
        clearAuthToken();
        setStatus("unauthenticated");
      });
  }

  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      checkToken(token);
      return;
    }
    // No local session yet - ask the shell (see auth.ts's own comment) for
    // one before falling back to the login screen, so a session that
    // already exists in a sibling tab doesn't force logging in again here
    // too.
    requestSharedToken().then((shared) => {
      if (shared) {
        applySharedToken(shared);
        checkToken(shared);
      } else {
        setStatus("unauthenticated");
      }
    });
  }, []);

  // Ongoing - picks up a DIFFERENT frontend logging in/out later, even
  // while this one is already sitting on a login screen, rather than
  // staying stuck on stale state.
  useEffect(() => {
    return subscribeToSharedToken((token) => {
      if (token) {
        applySharedToken(token);
        window.location.reload();
      } else if (getAuthToken()) {
        applySharedToken(null);
        window.location.reload();
      }
    });
  }, []);

  if (status === "checking") return null;
  if (status === "unauthenticated") {
    return <LoginPage onAuthenticated={() => window.location.reload()} />;
  }
  return <>{children}</>;
}

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

// Gates the whole app behind a logged-in session - execution/frontend used
// to be admin-only (its own "platform operator's ops console" era, see
// docs/architecture.md's Phase 5) but is now open to any authenticated
// account, same as manual-trading/market-data/signal-engine and shown by
// the shell's own top-bar "Admin" badge rather than a separate gate here.
// execution-backend's own API was already "any authenticated user,
// row-scoped by user_id" the whole time (Phase 2) - only this frontend
// gate changed. Admin-only actions (platform-wide positions/accounts
// config, still enforced server-side via require_admin) simply surface a
// 403 inline for a non-admin caller, same as this app already handles any
// other backend error. Sits outside the existing "?view=" routing in
// App.tsx, which stays completely unchanged.
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
  // while this one is already sitting on a login screen (or mid-session)
  // rather than staying stuck on stale state.
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

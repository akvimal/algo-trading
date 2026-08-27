import { ReactNode, useEffect, useState } from "react";
import { clearAuthToken, CurrentUser, fetchCurrentUser, getAuthToken, setAuthEmail } from "./auth";
import LoginPage from "./LoginPage";

type Status = "checking" | "authenticated" | "unauthenticated" | "forbidden";

// Gates the whole app behind a logged-in ADMIN session - execution/frontend
// is the platform operator's own admin/ops console, not part of the SaaS
// product (manual-trading/frontend is - see docs/architecture.md §
// "Manual Trading SaaS"), so a valid but non-admin login is deliberately
// NOT enough to get in. Sits outside the existing "?view=" routing in
// App.tsx, which stays completely unchanged.
export default function AuthGate({ children }: { children: (user: CurrentUser) => ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setStatus("unauthenticated");
      return;
    }
    fetchCurrentUser(token)
      .then((u) => {
        setAuthEmail(u.email);
        if (!u.is_admin) {
          setStatus("forbidden");
          return;
        }
        setUser(u);
        setStatus("authenticated");
      })
      .catch(() => {
        clearAuthToken();
        setStatus("unauthenticated");
      });
  }, []);

  if (status === "checking") return null;
  if (status === "unauthenticated") {
    return <LoginPage onAuthenticated={() => window.location.reload()} />;
  }
  if (status === "forbidden") {
    // Not LoginPage - re-entering the same non-admin account would just
    // loop back here. Logout is the only useful action.
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Admins only</h1>
          <p className="subtitle">This app is the platform's admin console, not part of the SaaS product - your account doesn't have admin access.</p>
          <button
            type="button"
            onClick={() => {
              clearAuthToken();
              window.location.reload();
            }}
          >
            Logout
          </button>
        </div>
      </div>
    );
  }
  return <>{user && children(user)}</>;
}

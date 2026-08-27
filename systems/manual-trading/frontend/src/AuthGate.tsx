import { ReactNode, useEffect, useState } from "react";
import { clearAuthToken, CurrentUser, fetchCurrentUser, getAuthToken, setAuthEmail } from "./auth";
import LoginPage from "./LoginPage";

type Status = "checking" | "authenticated" | "unauthenticated";

// Gates the whole app behind a logged-in session - every execution route
// requires a Bearer token as of the multi-tenant SaaS migration (see
// docs/architecture.md § "Manual Trading SaaS"). Sits outside the existing
// "?tab=" routing in App.tsx, which stays completely unchanged.
export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setStatus("unauthenticated");
      return;
    }
    fetchCurrentUser(token)
      .then((u: CurrentUser) => {
        setAuthEmail(u.email);
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
  return <>{children}</>;
}

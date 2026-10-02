import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { ProfileProvider, useProfile } from "./auth/ProfileContext";
import { Skeleton } from "./components/bits";
import { AppShell } from "./layout/AppShell";
import { JobsPage } from "./pages/JobsPage";
import { MorePage } from "./pages/MorePage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { ScanPage } from "./pages/ScanPage";
import { NotesPage } from "./pages/NotesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import { StrategiesPage } from "./pages/StrategiesPage";
import { TodayPage } from "./pages/TodayPage";
import { TradePage } from "./pages/TradePage";
import { WelcomePage } from "./pages/WelcomePage";

function RequireAuth() {
  const { session } = useAuth();
  const location = useLocation();
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return (
    <ProfileProvider>
      <OnboardingGate />
    </ProfileProvider>
  );
}

/** The platform operator's screens: anyone else is sent back to More rather than shown a page whose data the server refuses them anyway. */
function RequireAdmin({ children }: { children: JSX.Element }) {
  const { session } = useAuth();
  return session?.isAdmin ? children : <Navigate to="/more" replace />;
}

/** A person who has not been through first-run setup is taken there, and once they have been it is
 * not offered again (it would reset their practice account). If the profile cannot be read the app
 * opens anyway: a failed lookup must never lock someone out of their own trades. */
function OnboardingGate() {
  const { profile, status } = useProfile();
  const { pathname } = useLocation();
  if (status === "loading") {
    return (
      <div className="signin">
        <Skeleton lines={4} />
      </div>
    );
  }
  const needsSetup = status === "ready" && profile != null && profile.onboarded_at == null;
  if (needsSetup && pathname !== "/welcome") return <Navigate to="/welcome" replace />;
  if (!needsSetup && pathname === "/welcome") return <Navigate to="/" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route element={<RequireAuth />}>
        <Route path="welcome" element={<WelcomePage />} />
        <Route element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="scan" element={<ScanPage />} />
          <Route path="trade" element={<TradePage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="more">
            <Route index element={<MorePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="strategies" element={<StrategiesPage />} />
            <Route path="jobs" element={<RequireAdmin><JobsPage /></RequireAdmin>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

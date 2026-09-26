import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { AppShell } from "./layout/AppShell";
import { ComingPage } from "./pages/ComingPage";
import { MorePage } from "./pages/MorePage";
import { ScanPage } from "./pages/ScanPage";
import { SettingsPage } from "./pages/SettingsPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { SignInPage } from "./pages/SignInPage";
import { TodayPage } from "./pages/TodayPage";

function RequireAuth() {
  const { session } = useAuth();
  const location = useLocation();
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="scan" element={<ScanPage />} />
          <Route path="trade" element={<ComingPage title="Trade" blurb="Place a paper trade with your stop-loss and target set up front." />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="more">
            <Route index element={<MorePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

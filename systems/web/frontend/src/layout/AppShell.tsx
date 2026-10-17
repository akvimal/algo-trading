import { Fragment, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { InboxBell } from "../components/InboxBell";
import { useProfile } from "../auth/ProfileContext";
import { loadSidebarChoice, saveSidebarChoice } from "./sidebarPrefs";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const Icon = {
  today: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  trade: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 17l5-5 4 4 7-8" />
      <path d="M15 8h5v5" />
    </svg>
  ),
  portfolio: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </svg>
  ),
} satisfies Record<string, ReactNode>;

/** Learn is a sidebar row on a desktop; on a phone the bottom bar is full at five, so it is reached from More. */
const LEARN_ICON = (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M2 9l10-5 10 5-10 5z" />
    <path d="M6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" />
  </svg>
);

/** Performance sits beside Portfolio in the sidebar; on a phone the bottom bar is full at five, so it is reached from the Portfolio page or More. */
const PERFORMANCE_ICON = (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M22 20H2" />
  </svg>
);

export const NAV = [
  { to: "/", label: "Today", icon: Icon.today, end: true },
  { to: "/scan", label: "Scan", icon: Icon.scan },
  { to: "/trade", label: "Trade", icon: Icon.trade },
  { to: "/portfolio", label: "Portfolio", icon: Icon.portfolio },
  { to: "/more", label: "More", icon: Icon.more },
] as const;

/** Points left when expanded, right when collapsed — a chevron that shows which way the click goes. */
function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <polyline points={collapsed ? "9 5 15 12 9 19" : "15 5 9 12 15 19"} />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

/** Bottom tab bar on a phone, sidebar on a desktop: the same five destinations, one component, no
 * separate "mobile site". On a desktop the sidebar can also collapse to an icon-only rail — the
 * person's own choice once they have made one, otherwise it follows Guided/Pro (Guided keeps the
 * labels while the nav is still being learned; Pro starts collapsed). Sign out lives at the bottom of
 * the sidebar, not only inside More, so it is reachable without leaving whatever screen you are on. */
export function AppShell() {
  const { session, signOut } = useAuth();
  const { guided, status } = useProfile();
  const [collapsed, setCollapsed] = useState<boolean>(() => loadSidebarChoice() ?? false);
  useEffect(() => {
    if (status !== "ready" || loadSidebarChoice() != null) return; // an explicit choice is never overridden
    setCollapsed(!guided);
  }, [status, guided]);
  function toggleCollapsed() {
    setCollapsed((c) => {
      saveSidebarChoice(!c);
      return !c;
    });
  }

  // The trading workstation needs the whole width: no reading-column limit on this one screen.
  const { pathname } = useLocation();
  const wide = pathname.startsWith("/trade");
  // Today lays positions and the Markets card side by side, so it gets a wider column than the reading pages.
  const dash = pathname === "/";
  return (
    <div className="app">
      <nav className={`nav ${collapsed ? "collapsed" : ""}`} aria-label="Main">
        <div className="nav-top">
          <div className="brand">Algo Trading</div>
          <button className="nav-collapse" aria-pressed={collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand" : "Collapse"} onClick={toggleCollapsed}>
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>
        {NAV.map((item) => (
          <Fragment key={item.to}>
            {item.to === "/more" && (
              <NavLink to="/learn" className="nav-desk-only" title={collapsed ? "Learn" : undefined}>
                {LEARN_ICON}
                <span className={collapsed ? "sr-only" : undefined}>Learn</span>
              </NavLink>
            )}
            <NavLink to={item.to} end={"end" in item ? item.end : false} title={collapsed ? item.label : undefined}>
              {item.icon}
              <span className={collapsed ? "sr-only" : undefined}>{item.label}</span>
            </NavLink>
            {item.to === "/portfolio" && (
              <NavLink to="/performance" className="nav-desk-only" title={collapsed ? "Performance" : undefined}>
                {PERFORMANCE_ICON}
                <span className={collapsed ? "sr-only" : undefined}>Performance</span>
              </NavLink>
            )}
          </Fragment>
        ))}
        {session?.email && (
          <div className="nav-bottom">
            <span className={`nav-email ${collapsed ? "sr-only" : ""}`} title={session.email}>
              {session.email}
            </span>
            <InboxBell variant="nav" collapsed={collapsed} />
            <NavLink to="/more/settings" title={collapsed ? "Settings" : undefined}>
              <SettingsIcon />
              <span className={collapsed ? "sr-only" : undefined}>Settings</span>
            </NavLink>
            <button className="nav-signout" onClick={signOut} title="Sign out" aria-label="Sign out">
              <SignOutIcon />
              <span className={collapsed ? "sr-only" : undefined}>Sign out</span>
            </button>
          </div>
        )}
      </nav>
      <main className={`app-main${wide ? " wide" : ""}${dash ? " dash" : ""}`}>
        <div className="inbox-bar">
          <InboxBell />
        </div>
        <Outlet />
      </main>
    </div>
  );
}

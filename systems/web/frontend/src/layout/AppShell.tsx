import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

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

export const NAV = [
  { to: "/", label: "Today", icon: Icon.today, end: true },
  { to: "/scan", label: "Scan", icon: Icon.scan },
  { to: "/trade", label: "Trade", icon: Icon.trade },
  { to: "/portfolio", label: "Portfolio", icon: Icon.portfolio },
  { to: "/more", label: "More", icon: Icon.more },
] as const;

/** Bottom tab bar on a phone, sidebar on a desktop: the same five destinations, one
 * component, no separate "mobile site". */
export function AppShell() {
  const { session } = useAuth();
  // The trading workstation needs the whole width: no reading-column limit on this one screen.
  const wide = useLocation().pathname.startsWith("/trade");
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="brand">Algo Trading</div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={"end" in item ? item.end : false}>
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
        {session?.email && <span className="sr-only">Signed in as {session.email}</span>}
      </nav>
      <main className={`app-main${wide ? " wide" : ""}`}>
        <Outlet />
      </main>
    </div>
  );
}

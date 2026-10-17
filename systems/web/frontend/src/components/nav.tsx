import type { MouseEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

/** Back to where the person came from. Opened directly (a bookmark, a new tab) there is no "where from", so it goes to `to`. */
export function BackLink({ to, label = "Back" }: { to: string; label?: string }) {
  const navigate = useNavigate();
  const { key } = useLocation();
  const onClick = (e: MouseEvent) => {
    if (key === "default") return; // first page of this visit: follow the link
    e.preventDefault();
    navigate(-1);
  };
  return (
    <Link to={to} onClick={onClick} className="back-link" aria-label={label}>
      <span aria-hidden="true">‹</span> {label}
    </Link>
  );
}

/** A whole row that goes to another place: title, one line of what is there, and a chevron. */
export function LinkRow({ to, title, hint }: { to: string; title: ReactNode; hint?: ReactNode }) {
  return (
    <Link to={to} className="link-row">
      <span>
        <strong>{title}</strong>
        {hint && <span className="dim link-row-hint">{hint}</span>}
      </span>
      <span aria-hidden="true" className="link-row-chevron">›</span>
    </Link>
  );
}

/** The one thing to do next, as a real button (44px tall), at the end of the notice or card it belongs to. */
export function NextStep({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="btn btn-primary next-step">
      {children}
    </Link>
  );
}

import type { ReactNode } from "react";
import { ApiError } from "../api/http";
import { Link } from "react-router-dom";
import { tone } from "../format";

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** A signed, coloured amount. The sign is in the TEXT (formatPnl), colour only reinforces it. */
export function Signed({ value, text, className = "" }: { value: number | null | undefined; text: string; className?: string }) {
  return <span className={`num ${tone(value)} ${className}`}>{text}</span>;
}

/** What an error means to the person, not what the server said. The keys case is the new
 * one every data screen must handle: with own-keys mode on, no Dhan keys = no live data. */
export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.keysRequired) {
    return (
      <div className="notice" role="alert">
        <strong>Add your Dhan keys to see live data.</strong>
        <p className="dim" style={{ margin: "6px 0 10px" }}>
          Live prices come from your own Dhan account. Add your Dhan client ID and access token, then come back here.
        </p>
        <Link className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }} to="/more/settings?tab=broker">
          Add Dhan keys
        </Link>
      </div>
    );
  }
  return (
    <div className="notice error" role="alert">
      <strong>{error.status === 0 ? "You seem to be offline." : "That did not load."}</strong>
      <p className="dim" style={{ margin: "6px 0 0" }}>{error.message}</p>
      {onRetry && (
        <button className="btn btn-small" style={{ marginTop: 10 }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <strong>{title}</strong>
      {children && <p className="dim" style={{ margin: "6px 0 0" }}>{children}</p>}
    </div>
  );
}

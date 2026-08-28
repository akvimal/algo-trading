import type { ReactNode } from "react";

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

// Collapsed by default - keeps a page's default view compact instead of a
// permanently-open explainer paragraph. Same pattern as signal-engine's
// own InfoDisclosure (duplicated, not shared, matching this repo's usual
// per-frontend convention for small UI atoms).
export function InfoDisclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="info-disclosure">
      <summary>
        <InfoIcon />
        {summary}
      </summary>
      <div className="info-disclosure-body">{children}</div>
    </details>
  );
}

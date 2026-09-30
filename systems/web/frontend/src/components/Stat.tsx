import type { ReactNode } from "react";

/** A label over a value. `hint` is the plain-language meaning, for terms a beginner may not know. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="dim" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
        {value}
      </div>
      {hint && (
        <div className="faint" style={{ fontSize: 11 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

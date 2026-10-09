import type { ReactNode } from "react";
import { CheckIcon, CrossIcon, WarnIcon } from "./BadgeIcons";

/** How a field stands: an icon beside its label (its text is the icon's accessible name and tooltip), and, only when it needs attention, the same
 * words under the input. "na" and "info" show nothing. */
export type FieldStatus = { tone: "good" | "warn" | "bad" | "na" | "info"; text: string; /** Mark only: the words stay in the icon's tooltip and accessible name, none under the input. */ quiet?: boolean };

/** A labelled number/text input with a plain-language hint and an inline error. The error is
 * tied to the input (aria-describedby) so a screen reader announces it with the field. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  inputMode = "decimal",
  placeholder,
  type = "text",
  suffix,
  id,
  action,
  dimmed = false,
  status,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string;
  inputMode?: "decimal" | "numeric" | "text";
  placeholder?: string;
  type?: "text" | "password";
  suffix?: string;
  id: string;
  /** Something to the right of the label, such as a "pick on chart" button. */
  action?: ReactNode;
  /** Shown quietly: the value is worked out for the person, and typing here overrides it. */
  dimmed?: boolean;
  /** A status mark beside the label, so what the ticket's checks used to say in rows sits on the field itself. */
  status?: FieldStatus;
}) {
  const marked = status && (status.tone === "good" || status.tone === "warn" || status.tone === "bad") ? status : null;
  const attention = marked && marked.tone !== "good" && !marked.quiet ? marked : null; // only a field that needs a look gets words under it, unless it asked for the mark alone
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : "", attention ? `${id}-status` : ""].filter(Boolean).join(" ") || undefined;
  const title = (
    <label htmlFor={id}>
      <span>{label}</span>
    </label>
  );
  return (
    <div className={dimmed ? "field field-auto" : "field"}>
      <div className="field-head">
        {marked ? (
          <span className="field-title">
            {title}
            <span className={`field-status ${marked.tone}`} role="img" aria-label={marked.text} title={marked.text} data-testid={`${id}-status-icon`}>
              {marked.tone === "good" ? <CheckIcon /> : marked.tone === "warn" ? <WarnIcon /> : <CrossIcon />}
            </span>
          </span>
        ) : (
          title
        )}
        {action}
      </div>
      <div className="input-row">
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="dim">{suffix}</span>}
      </div>
      {hint && (
        <div id={`${id}-hint`} className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          {hint}
        </div>
      )}
      {attention && (
        <div id={`${id}-status`} className={attention.tone === "bad" ? "dn" : undefined} style={{ fontSize: 12, marginTop: 4, ...(attention.tone === "warn" ? { color: "var(--warn)" } : {}) }} data-testid={`${id}-status`}>
          {attention.text}
        </div>
      )}
      {error && (
        <div id={`${id}-err`} className="dn" role="alert" style={{ fontSize: 13, marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** A yes/no setting with its explanation. A real checkbox: keyboard and screen-reader friendly. */
export function ToggleField({ label, hint, checked, onChange, id }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label className="check" htmlFor={id} style={{ alignItems: "flex-start" }}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span style={{ color: "var(--text)" }}>{label}</span>
        {hint && <span className="faint" style={{ display: "block", fontSize: 12 }}>{hint}</span>}
      </span>
    </label>
  );
}

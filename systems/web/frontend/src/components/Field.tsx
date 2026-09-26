import type { ReactNode } from "react";

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
}) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>
          <span>{label}</span>
        </label>
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

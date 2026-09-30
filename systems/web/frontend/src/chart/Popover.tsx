import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a small panel beneath it. Closes on a click elsewhere or Escape, returns focus
 * to the button, and tells assistive tech whether it is open. */
export function Popover({ label, badge, children, align = "left" }: { label: string; badge?: string | number; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover" ref={root}>
      <button ref={button} className="chip-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        {label}
        {badge != null && badge !== 0 && <span className="badge">{badge}</span>}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className={`popover-panel ${align}`} role="group" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a small panel beneath it. Closes on a click elsewhere or Escape, returns focus
 * to the button, and tells assistive tech whether it is open. */
export function Popover({
  label,
  badge,
  children,
  align = "left",
  icon,
  text,
  buttonLabel,
  variant = "chip",
  side = "below",
  pressed,
  title,
}: {
  label: string;
  badge?: string | number;
  /** The panel's content; a function gets a `close` to call once a choice is made. */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  /** Shown on the button before its text. */
  icon?: ReactNode;
  /** What the button says (default: `label`, which is also the panel's accessible name) - e.g. the current choice. */
  text?: string;
  /** The button's accessible name, when its visible text alone would not say what it opens. */
  buttonLabel?: string;
  /** "chip" (default) is a text button for the top bar; "tool" is an icon-only square for the left rail. */
  variant?: "chip" | "tool";
  /** Where the panel opens: under the button (default) or beside it, to the right - for the rail. */
  side?: "below" | "beside";
  /** For a tool button: whether what it opens is switched on, shown by highlighting it. */
  pressed?: boolean;
  /** A tool button's tooltip. */
  title?: string;
}) {
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
      {variant === "tool" ? (
        <button
          ref={button}
          className="tool popover-tool"
          aria-label={buttonLabel ?? label}
          title={title ?? label}
          aria-pressed={pressed}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen(!open)}
        >
          {icon}
          {badge != null && badge !== 0 && <span className="tool-count">{badge}</span>}
        </button>
      ) : (
        <button ref={button} className="chip-btn" aria-label={buttonLabel} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
          {icon}
          <span className="popover-text">{text ?? label}</span>
          {badge != null && badge !== 0 && <span className="badge">{badge}</span>}
          <span aria-hidden="true"> ▾</span>
        </button>
      )}
      {open && (
        <div className={`popover-panel ${side === "beside" ? "beside" : align}`} role="group" aria-label={label}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

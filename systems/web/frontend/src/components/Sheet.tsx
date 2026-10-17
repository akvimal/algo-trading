import { useEffect, useRef, type ReactNode } from "react";

/** Opens over the page, where it cannot be missed: a bottom sheet on a phone, a centred panel on a desktop. Closes on the backdrop, Escape or the content's own close button. */
export function Sheet({ children, onClose, label, testId }: { children: ReactNode; onClose: () => void; label: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose} data-testid={testId}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

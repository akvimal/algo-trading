import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** A picture shown large over the page: fits the screen to start with, click it to see it at its real size (and scroll
 * around it), click it again to fit again. Closes with Escape, the Close button or a click outside the picture, and
 * hands focus back to what opened it. */
export function ImageLightbox({ src, alt, fileName, onClose }: { src: string; alt: string; fileName?: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind does not scroll while the picture is up
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opened once; onClose is the opener's own setter
  }, []);

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} data-testid="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="faint">{actual ? "Real size - click the picture to fit the screen" : "Click the picture for its real size"}</span>
        <span className="notes-spacer" />
        <a className="btn" href={src} download={fileName ?? "snapshot.png"}>
          Download
        </a>
        <button ref={closeButton} className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className={`lightbox-stage ${actual ? "actual" : ""}`} onClick={(e) => e.stopPropagation()}>
        <img className="lightbox-image" src={src} alt={alt} onClick={() => setActual((v) => !v)} />
      </div>
    </div>,
    document.body,
  );
}

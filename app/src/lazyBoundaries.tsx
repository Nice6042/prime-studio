import { useRef } from "react";
import { useTopmostSurfaceEscape } from "./surfaceEscape";

export type LazySurface = "artifacts" | "modal" | "palette";

export function SurfaceFallback({
  surface,
  label,
  className = "",
  onClose,
}: {
  surface: LazySurface;
  label: string;
  className?: string;
  onClose?: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  // Focus intentionally stays on the opener while this shell is pending, so a
  // capture listener owns Escape before ChatPane can treat it as agent abort.
  useTopmostSurfaceEscape(backdropRef, onClose, surface !== "artifacts");

  const props = {
    role: "status" as const,
    "aria-live": "polite" as const,
    "aria-busy": true,
    "aria-label": label,
  };

  if (surface === "artifacts") {
    return (
      <aside className={"artifacts " + className + " lazy-surface lazy-surface-" + surface} {...props}>
        {label}
      </aside>
    );
  }
  if (surface === "palette") {
    return (
      <div ref={backdropRef} className="modal-backdrop lazy-surface-backdrop" onClick={onClose}>
        <div
          className={"palette " + className + " lazy-surface lazy-surface-" + surface}
          onClick={(event) => event.stopPropagation()}
          {...props}
        >
          {label}
        </div>
      </div>
    );
  }
  return (
    <div ref={backdropRef} className="modal-backdrop lazy-surface-backdrop" onClick={onClose}>
      <div
        className={"modal " + className + " lazy-surface lazy-surface-" + surface}
        onClick={(event) => event.stopPropagation()}
        {...props}
      >
        {label}
      </div>
    </div>
  );
}

export function MarkdownFallback({ text }: { text: string }) {
  return (
    <div
      className="md md-fallback"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading formatted message"
    >
      <p>{text}</p>
    </div>
  );
}

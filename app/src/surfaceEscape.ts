import { useEffect, type RefObject } from "react";

/** Give Escape to exactly one modal surface: the last rendered backdrop. */
export function useTopmostSurfaceEscape(
  backdropRef: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !onClose) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const backdrop = backdropRef.current;
      if (!backdrop || backdrop.querySelector("dialog[open]")) return;
      const backdrops = document.querySelectorAll(".modal-backdrop");
      if (backdrops.item(backdrops.length - 1) !== backdrop) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backdropRef, enabled, onClose]);
}

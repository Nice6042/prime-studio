import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const STUDIO_SURFACE_SELECTOR = ".modal-backdrop, [data-studio-overlay]";

export function hasOpenStudioOverlay(): boolean {
  return document.querySelector(STUDIO_SURFACE_SELECTOR) !== null;
}

function isTopmostSurface(surface: HTMLElement): boolean {
  const surfaces = document.querySelectorAll<HTMLElement>(STUDIO_SURFACE_SELECTOR);
  return surfaces.item(surfaces.length - 1) === surface;
}

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
      if (!isTopmostSurface(backdrop)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backdropRef, enabled, onClose]);
}

/** Escape ownership and trigger restoration for non-modal menus and popovers. */
export function usePopoverSurface(
  surfaceRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const opener = openerRef.current;
      queueMicrotask(() => {
        if (opener?.isConnected && !opener.matches(":disabled") && !opener.closest("[inert]")) opener.focus();
      });
    };
  }, [enabled, surfaceRef]);

  useTopmostSurfaceEscape(surfaceRef, onClose, enabled);
}

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

/**
 * Shared Escape, outside-pointer, and focus behavior for non-modal menus and
 * popovers. Only the topmost Studio surface may dismiss itself. Pointer
 * dismissal preserves the newly clicked target; Escape restores the opener.
 * Returns a one-close restoration suppressor for native Tab progression.
 */
export function usePopoverSurface(
  surfaceRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
  boundaryRef?: RefObject<HTMLElement | null>,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);

  useLayoutEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    restoreFocusRef.current = true;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (!restoreFocusRef.current) return;
      const opener = openerRef.current;
      queueMicrotask(() => {
        if (opener?.isConnected && !opener.matches(":disabled") && !opener.closest("[inert]")) opener.focus();
      });
    };
  }, [enabled, surfaceRef]);

  useEffect(() => {
    if (!enabled) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const surface = surfaceRef.current;
      const target = event.target;
      if (!surface || !(target instanceof Node) || !isTopmostSurface(surface)) return;
      const boundary = boundaryRef?.current ?? surface;
      if (boundary.contains(target)) return;
      restoreFocusRef.current = false;
      onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [boundaryRef, enabled, onClose, surfaceRef]);

  useTopmostSurfaceEscape(surfaceRef, onClose, enabled);
  return () => { restoreFocusRef.current = false; };
}

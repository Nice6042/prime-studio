import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const STUDIO_SURFACE_SELECTOR = ".modal-backdrop, [data-studio-overlay]";

function isPresentedSurface(surface: HTMLElement): boolean {
  return surface.isConnected
    && !surface.hidden
    && surface.getAttribute("aria-hidden") !== "true"
    && surface.closest("[hidden], [aria-hidden='true']") === null;
}

export function studioSurfaceElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(STUDIO_SURFACE_SELECTOR)).filter(isPresentedSurface);
}

export function hasOpenStudioOverlay(root: ParentNode = document): boolean {
  return studioSurfaceElements(root).length > 0;
}

export function isTopmostStudioSurface(surface: HTMLElement, root: ParentNode = document): boolean {
  const surfaces = studioSurfaceElements(root);
  return surfaces.at(-1) === surface;
}

function eventTargetsElement(event: Event, element: HTMLElement | null): boolean {
  if (!element) return false;
  if (typeof event.composedPath === "function" && event.composedPath().includes(element)) return true;
  return event.target instanceof Node && element.contains(event.target);
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected
      && !element.matches(":disabled")
      && element.getAttribute("aria-disabled") !== "true"
      && !element.closest("[inert], [hidden], [aria-hidden='true']"),
  );
}

/** Give Escape to exactly one modal or popover surface: the last presented surface. */
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
      if (!isTopmostStudioSurface(backdrop)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [backdropRef, enabled, onClose]);
}

/**
 * Shared non-modal menu/popover behavior.
 *
 * Escape restores the opener. Pointer or focus transfer outside closes without
 * stealing focus from the destination. The trigger itself is excluded from the
 * outside-pointer path so its click can perform the component's own toggle.
 * `identity` distinguishes two surfaces that reuse one ref while remaining open.
 * Returns a one-close restoration suppressor for native Tab progression.
 */
export function usePopoverSurface(
  surfaceRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
  identity: unknown = enabled,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  const closingRef = useRef(false);
  const closeOnce = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  };

  useLayoutEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    restoreFocusRef.current = true;
    closingRef.current = false;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (!restoreFocusRef.current) return;
      const opener = openerRef.current;
      queueMicrotask(() => {
        // A command may replace the popover with a modal or another menu. That
        // new topmost surface owns focus and must not be interrupted by stale restoration.
        if (hasOpenStudioOverlay()) return;
        if (canRestoreFocus(opener)) opener.focus();
      });
    };
  }, [enabled, identity, surfaceRef]);

  useEffect(() => {
    if (!enabled) return;
    const closeForTransfer = () => {
      restoreFocusRef.current = false;
      closeOnce();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const surface = surfaceRef.current;
      if (!surface || !isTopmostStudioSurface(surface)) return;
      if (eventTargetsElement(event, surface) || eventTargetsElement(event, openerRef.current)) return;
      closeForTransfer();
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const surface = surfaceRef.current;
      if (!surface || !isTopmostStudioSurface(surface)) return;
      if (eventTargetsElement(event, surface) || eventTargetsElement(event, openerRef.current)) return;
      closeForTransfer();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("focusin", closeOnOutsideFocus, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("focusin", closeOnOutsideFocus, true);
    };
  }, [enabled, identity, onClose, surfaceRef]);

  useTopmostSurfaceEscape(surfaceRef, closeOnce, enabled);
  return () => { restoreFocusRef.current = false; };
}

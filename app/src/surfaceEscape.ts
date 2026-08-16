import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const STUDIO_SURFACE_SELECTOR = ".modal-backdrop, [data-studio-overlay]";
const STUDIO_GLOBAL_SHORTCUT_KEYS = new Set(["n", "k", ",", "b", "j"]);

function isPresentedSurface(surface: HTMLElement): boolean {
  return surface.isConnected
    && !surface.hidden
    && surface.getAttribute("aria-hidden") !== "true"
    && surface.closest("[hidden], [aria-hidden='true']") === null;
}

function studioSurfaceElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(STUDIO_SURFACE_SELECTOR)).filter(isPresentedSurface);
}

export function hasOpenStudioOverlay(): boolean {
  return studioSurfaceElements().length > 0;
}

function isTopmostSurface(surface: HTMLElement): boolean {
  const surfaces = studioSurfaceElements();
  return surfaces[surfaces.length - 1] === surface;
}

function isStudioGlobalShortcut(event: KeyboardEvent): boolean {
  return !event.isComposing
    && event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && STUDIO_GLOBAL_SHORTCUT_KEYS.has(event.key.toLocaleLowerCase());
}

function eventTargetsElement(event: Event, element: HTMLElement | null): boolean {
  if (!element) return false;
  if (typeof event.composedPath === "function" && event.composedPath().includes(element)) return true;
  return event.target instanceof Node && element.contains(event.target);
}

function focusEligible(element: HTMLElement | null): void {
  if (
    element?.isConnected
    && !element.matches(":disabled")
    && element.getAttribute("aria-disabled") !== "true"
    && !element.closest("[inert], [hidden], [aria-hidden='true']")
  ) element.focus();
}

function activeSurfaceOwnsFocus(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement
    && active !== document.body
    && active !== document.documentElement
    && active.closest(STUDIO_SURFACE_SELECTOR) !== null;
}

/** Give keyboard ownership to exactly one surface: the last presented backdrop. */
export function useTopmostSurfaceEscape(
  backdropRef: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !onClose) return;
    const handleTopmostKey = (event: KeyboardEvent) => {
      const backdrop = backdropRef.current;
      if (!backdrop || !isTopmostSurface(backdrop)) return;
      if (isStudioGlobalShortcut(event)) {
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (event.key !== "Escape" || backdrop.querySelector("dialog[open]")) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleTopmostKey, true);
    return () => window.removeEventListener("keydown", handleTopmostKey, true);
  }, [backdropRef, enabled, onClose]);
}

/**
 * Shared Escape, outside-pointer, focus-transfer, shortcut, and restoration
 * behavior for non-modal menus and popovers. Only the topmost presented Studio
 * surface may dismiss itself or consume application-global shortcuts. Pointer
 * and focus dismissal preserve the destination; Escape and an evaporated
 * pointer target restore the admitted opener. A shared boundary may host sibling
 * triggers, so focus moving between them updates the exact restoration target.
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
  const closingRef = useRef(false);
  const closeOnce = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  };

  useLayoutEffect(() => {
    if (!enabled) return;
    restoreFocusRef.current = true;
    closingRef.current = false;
    return () => {
      if (!restoreFocusRef.current) return;
      const opener = openerRef.current;
      queueMicrotask(() => {
        if (!activeSurfaceOwnsFocus()) focusEligible(opener);
      });
    };
  }, [enabled]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const active = document.activeElement;
    if (!enabled || !surface || !(active instanceof HTMLElement) || surface.contains(active)) return;
    openerRef.current = active;
  });

  useEffect(() => {
    if (!enabled || !boundaryRef) return;
    const rememberBoundaryTrigger = (event: FocusEvent) => {
      const boundary = boundaryRef.current;
      const surface = surfaceRef.current;
      const target = event.target;
      if (
        !boundary
        || !surface
        || !(target instanceof HTMLElement)
        || !boundary.contains(target)
        || surface.contains(target)
      ) return;
      openerRef.current = target;
    };
    document.addEventListener("focusin", rememberBoundaryTrigger, true);
    return () => document.removeEventListener("focusin", rememberBoundaryTrigger, true);
  }, [boundaryRef, enabled, surfaceRef]);

  useEffect(() => {
    if (!enabled) return;
    const boundaryFor = (surface: HTMLElement) => boundaryRef?.current ?? surface;
    const closeForTransfer = () => {
      restoreFocusRef.current = false;
      closeOnce();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const surface = surfaceRef.current;
      if (!surface || !isTopmostSurface(surface)) return;
      const boundary = boundaryFor(surface);
      if (eventTargetsElement(event, boundary)) return;
      const target = event.target;
      const clickedTarget = target instanceof HTMLElement
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
      const fallbackOpener = openerRef.current;
      closeForTransfer();
      window.requestAnimationFrame(() => {
        if (!clickedTarget?.isConnected) focusEligible(fallbackOpener);
      });
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const surface = surfaceRef.current;
      if (!surface || !isTopmostSurface(surface)) return;
      if (eventTargetsElement(event, boundaryFor(surface))) return;
      closeForTransfer();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("focusin", closeOnOutsideFocus, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("focusin", closeOnOutsideFocus, true);
    };
  }, [boundaryRef, enabled, onClose, surfaceRef]);

  useTopmostSurfaceEscape(surfaceRef, closeOnce, enabled);
  return () => { restoreFocusRef.current = false; };
}

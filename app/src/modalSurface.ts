import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type InertClaim = {
  count: number;
  wasInert: boolean;
};

const inertClaims = new WeakMap<HTMLElement, InertClaim>();

function claimInert(element: HTMLElement): () => void {
  const existing = inertClaims.get(element);
  if (existing) {
    existing.count += 1;
  } else {
    inertClaims.set(element, { count: 1, wasInert: element.hasAttribute("inert") });
    element.setAttribute("inert", "");
  }

  return () => {
    const claim = inertClaims.get(element);
    if (!claim) return;
    claim.count -= 1;
    if (claim.count > 0) return;
    inertClaims.delete(element);
    if (!claim.wasInert) element.removeAttribute("inert");
  };
}

/**
 * Make every branch outside a modal backdrop inert without making an ancestor
 * of the backdrop inert. Nested modals use a body portal, so this also makes
 * the complete parent surface inert while its confirmation is topmost.
 */
function makeBackgroundInert(backdrop: HTMLElement): () => void {
  const releases: Array<() => void> = [];
  let branch: HTMLElement = backdrop;
  let parent = branch.parentElement;

  while (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        releases.push(claimInert(sibling));
      }
    }
    branch = parent;
    parent = parent.parentElement;
  }

  return () => {
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      releases[index]();
    }
  };
}

function isTopmostBackdrop(backdrop: HTMLElement): boolean {
  const backdrops = document.querySelectorAll<HTMLElement>(".modal-backdrop, [data-studio-overlay]");
  return backdrops.item(backdrops.length - 1) === backdrop;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true",
  );
}

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected
      && element.matches(FOCUSABLE)
      && !element.matches(":disabled")
      && element.getAttribute("aria-disabled") !== "true"
      && !element.closest("[inert], [hidden], [aria-hidden='true']"),
  );
}

/** Shared keyboard and background behavior for the app's non-native modals. */
export function useModalSurfaceFocus(
  backdropRef: RefObject<HTMLElement | null>,
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  restoreFallbackRef?: RefObject<HTMLElement | null>,
  enabled = true,
) {
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseBackground = makeBackgroundInert(backdrop);
    const focusInitial = () => {
      const target = initialFocusRef.current ?? focusableElements(dialog)[0] ?? dialog;
      target.focus();
    };

    focusInitial();
    const containProgrammaticFocus = (event: FocusEvent) => {
      if (!isTopmostBackdrop(backdrop) || dialog.contains(event.target as Node)) return;
      focusInitial();
    };
    document.addEventListener("focusin", containProgrammaticFocus);

    return () => {
      document.removeEventListener("focusin", containProgrammaticFocus);
      releaseBackground();
      const opener = openerRef.current;
      // React runs layout-effect cleanup before applying every mutation in the
      // commit. Wait until those mutations land so a synchronously disabled
      // opener is not mistaken for a valid restoration target.
      queueMicrotask(() => {
        const restoreTarget = canReceiveFocus(opener)
          ? opener
          : restoreFallbackRef?.current ?? null;
        if (canReceiveFocus(restoreTarget)) restoreTarget.focus();
      });
    };
  }, [backdropRef, dialogRef, enabled, initialFocusRef, restoreFallbackRef]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog || !isTopmostBackdrop(backdrop)) return;
    // React events from a portal still bubble through their component parent.
    // Keep the nested modal's Tab event away from the inert parent surface.
    event.stopPropagation();
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

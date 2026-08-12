import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { usePopoverSurface } from "../../surfaceEscape";
import { controlBinding } from "../conversation/controlBinding";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";

type ExecuteOperation = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

function FooterIcon({ kind }: { readonly kind: "chevron" | "settings" | "switch" | "logout" }) {
  const paths = {
    chevron: <path d="m9 6 6 6-6 6" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></>,
    switch: <><path d="M4 8h13" /><path d="m14 5 3 3-3 3" /><path d="M20 16H7" /><path d="m10 13-3 3 3 3" /></>,
    logout: <><path d="M10 5H5v14h5" /><path d="M14 8l4 4-4 4" /><path d="M9 12h9" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

function outcomeMessage(action: "workspace.switch" | "workspace.sign-out", outcome: StudioOperationOutcome): string {
  if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") return outcome.reason;
  if (outcome.status === "cancelled") return action === "workspace.switch" ? "Workspace switch cancelled." : "Sign out cancelled.";
  if (outcome.status === "queued") return action === "workspace.switch" ? "Workspace switch queued." : "Sign out queued.";
  return action === "workspace.switch" ? "Workspace switched." : "Signed out.";
}

export function WorkspaceFooter({ identity, variant, open, onExecute }: {
  readonly identity: WorkspaceIdentityProjection;
  readonly variant: "expanded" | "rail";
  readonly open: boolean;
  readonly onExecute: ExecuteOperation;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const configured = identity.status === "configured" ? identity : null;
  const close = () => { void onExecute({ action: "surface.popover.toggle", payload: { popoverId: null } }); };
  const suppressFocusRestore = usePopoverSurface(surfaceRef, close, open);

  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const toggle = () => {
    setMessage("");
    void onExecute({ action: "surface.popover.toggle", payload: { popoverId: open ? null : `workspace-footer-${variant}` } });
  };
  const runWorkspaceAction = async (action: "workspace.switch" | "workspace.sign-out") => {
    if (!configured) return;
    const outcome = await onExecute({ action, payload: { workspaceId: configured.workspaceId } });
    setMessage(outcomeMessage(action, outcome));
  };
  const openSettings = () => {
    setMessage("");
    void onExecute({ action: "route.settings.open", payload: {} });
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const trigger = triggerRef.current;
      const surface = surfaceRef.current;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !surface?.contains(element) && !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true");
      const triggerIndex = trigger ? candidates.indexOf(trigger) : -1;
      const offset = event.shiftKey ? -1 : 1;
      const target = triggerIndex >= 0 ? candidates[(triggerIndex + offset + candidates.length) % candidates.length] : null;
      suppressFocusRestore();
      target?.focus();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const active = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (active + 1 + items.length) % items.length
          : (active - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const label = identity.status === "configured" ? identity.name : identity.status === "loading" ? "Workspace loading" : "Workspace unavailable";
  const detail = identity.status === "configured" ? identity.detail : identity.status === "loading" ? "Loading configured workspace…" : identity.reason;
  const initials = configured?.initials ?? "—";

  return <div ref={rootRef} className="workspace-footer" data-variant={variant}>
    <button
      ref={triggerRef}
      type="button"
      className="workspace-footer-trigger"
      {...controlBinding(variant === "rail" ? "rail-workspace-menu" : "sidebar-workspace-menu", "surface.popover.toggle")}
      aria-label={`${label} workspace menu`}
      aria-haspopup="menu"
      aria-controls={open ? menuId : undefined}
      aria-expanded={open}
      title={variant === "rail" ? `${label}: ${detail}` : undefined}
      onClick={toggle}
    >
      <span className="workspace-avatar" aria-hidden="true">{initials}</span>
      {variant === "expanded" && <>
        <span className="workspace-copy"><strong>{label}</strong><small>{detail}</small></span>
        <span className="workspace-menu-chevron" aria-hidden="true"><FooterIcon kind="chevron" /></span>
      </>}
    </button>
    {open && <div
      ref={surfaceRef}
      data-studio-overlay="menu"
      className="workspace-menu"
    >
      <div className="workspace-menu-identity" aria-hidden="true">
        <strong>{label}</strong><span>{detail}</span>
      </div>
      <div id={menuId} ref={menuRef} role="menu" aria-label="Workspace actions" onKeyDown={onMenuKeyDown}>
        <button type="button" role="menuitem" {...controlBinding("workspace-switch", "workspace.switch")} disabled={!configured} onClick={() => { void runWorkspaceAction("workspace.switch"); }}><FooterIcon kind="switch" /><span>Switch workspace</span></button>
        <button type="button" role="menuitem" {...controlBinding("workspace-settings", "route.settings.open")} onClick={openSettings}><FooterIcon kind="settings" /><span>Settings</span></button>
        <div className="workspace-menu-separator" role="separator" />
        <button type="button" role="menuitem" className="workspace-sign-out" {...controlBinding("workspace-sign-out", "workspace.sign-out")} disabled={!configured} onClick={() => { void runWorkspaceAction("workspace.sign-out"); }}><FooterIcon kind="logout" /><span>Sign out</span></button>
      </div>
      <p className="workspace-menu-status" role="status" aria-live="polite">{message}</p>
    </div>}
  </div>;
}

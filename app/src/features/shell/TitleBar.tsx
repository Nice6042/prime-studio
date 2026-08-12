import { useEffect, useRef, useState, type ReactNode } from "react";

import type { StudioOperation } from "../../contracts/studioOperations";
import { controlBinding } from "../conversation/controlBinding";

const menus: readonly Readonly<{ label: string; items: readonly Readonly<{ label: string; hint?: string; operation: StudioOperation }>[] }>[] = [
  { label: "File", items: [
    { label: "New chat", hint: "Ctrl+N", operation: { action: "catalog.chat.create", payload: { projectId: "" } } },
    { label: "Settings", hint: "Ctrl+,", operation: { action: "route.settings.open", payload: {} } },
  ] },
  { label: "Edit", items: [
    { label: "Undo", hint: "Ctrl+Z", operation: { action: "history.undo", payload: {} } },
    { label: "Redo", hint: "Ctrl+Y", operation: { action: "history.redo", payload: {} } },
  ] },
  { label: "View", items: [
    { label: "Toggle sidebar", hint: "Ctrl+B", operation: { action: "layout.sidebar.toggle", payload: {} } },
    { label: "Toggle Harness", hint: "Ctrl+J", operation: { action: "layout.inspector.toggle", payload: {} } },
  ] },
  { label: "Window", items: [
    { label: "Minimize", operation: { action: "window.minimize", payload: {} } },
    { label: "Maximize", operation: { action: "window.maximize-toggle", payload: {} } },
  ] },
  { label: "Help", items: [
    { label: "Prime Agent documentation", operation: { action: "route.external-docs.open", payload: { document: "prime-agent" } } },
    { label: "Support", operation: { action: "route.external-docs.open", payload: { document: "support" } } },
  ] },
];

export function TitleBar({ title, actions, onOperation }: { readonly title: string; readonly actions?: ReactNode; readonly onOperation?: (operation: StudioOperation) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(null); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  return <div className="studio-titlebar" ref={root}>
    <span className="studio-title-mark" aria-hidden="true"><i /></span><strong>Prime Studio</strong>
    <nav className="studio-title-menus" aria-label="Application menu">{menus.map((menu) => <span className="studio-title-menu-root" key={menu.label}>
      <button type="button" aria-label={menu.label} aria-haspopup="menu" aria-expanded={open === menu.label} onClick={() => setOpen((value) => value === menu.label ? null : menu.label)} onPointerEnter={() => { if (open) setOpen(menu.label); }}>{menu.label}</button>
      {open === menu.label && <span className="studio-title-menu" role="menu" aria-label={`${menu.label} menu`}>{menu.items.map((item) => <button key={item.label} type="button" role="menuitem" aria-label={item.label} {...controlBinding(`title-${item.operation.action}`, item.operation.action)} disabled={!onOperation} onClick={() => { setOpen(null); onOperation?.(item.operation); }}><span>{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}</button>)}</span>}
    </span>)}</nav>
    <span className="studio-title-current" title={title}>{title}</span>
    <span className="studio-titlebar-actions">{actions}</span>
  </div>;
}

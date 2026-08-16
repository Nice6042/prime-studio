import { useRef, useState, type ReactNode } from "react";

import {
  commandAvailability,
  commandPlacements,
  studioCommand,
  type CommandAvailabilityContext,
  type StudioCommandId,
  type TitleMenuName,
} from "../../entities/commands/commandRegistry";
import { usePopoverSurface } from "../../surfaceEscape";
import { controlBinding } from "../conversation/controlBinding";

const menuNames: readonly TitleMenuName[] = ["File", "Edit", "View", "Window", "Help"];
const titlePlacements = commandPlacements("title-menu");
const windowPlacements = commandPlacements("window-control");

function WindowControlIcon({ kind }: { readonly kind: "minimize" | "maximize" | "close" }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="square">
    {kind === "minimize" && <path d="M3 11.5h10" />}
    {kind === "maximize" && <rect x="3.5" y="3.5" width="9" height="9" />}
    {kind === "close" && <><path d="m4 4 8 8" /><path d="m12 4-8 8" /></>}
  </svg>;
}

export function TitleBar({ title, actions, availability, onCommand }: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly availability: CommandAvailabilityContext;
  readonly onCommand?: (id: StudioCommandId) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const openMenu = useRef<HTMLSpanElement>(null);
  const openMenuRoot = useRef<HTMLSpanElement>(null);
  usePopoverSurface(openMenu, () => setOpen(null), open !== null, openMenuRoot);
  return <div className="studio-titlebar">
    <span className="studio-title-mark" aria-hidden="true"><i /></span><strong>Prime Studio</strong>
    <nav className="studio-title-menus" aria-label="Application menu">{menuNames.map((menu) => <span ref={open === menu ? openMenuRoot : undefined} className="studio-title-menu-root" key={menu}>
      <button type="button" {...controlBinding(`title-menu-${menu.toLocaleLowerCase()}`, "surface.popover.toggle")} aria-label={menu} aria-haspopup="menu" aria-expanded={open === menu} onClick={() => setOpen((value) => value === menu ? null : menu)} onPointerEnter={() => { if (open) setOpen(menu); }}>{menu}</button>
      {open === menu && <span ref={openMenu} data-studio-overlay="menu" className="studio-title-menu" role="menu" aria-label={`${menu} menu`}>{titlePlacements.filter((placement) => placement.menu === menu).map((placement) => {
        const command = studioCommand(placement.commandId);
        const state = commandAvailability(command, availability);
        const label = placement.label ?? command.label;
        return <button key={placement.id} type="button" role="menuitem" aria-label={label} {...controlBinding(placement.id, command.action)} disabled={!onCommand || !state.enabled} title={state.reason} onClick={() => { setOpen(null); onCommand?.(command.id); }}><span>{label}</span>{(placement.hint ?? command.shortcuts[0]) && <kbd>{placement.hint ?? command.shortcuts[0]}</kbd>}</button>;
      })}</span>}
    </span>)}</nav>
    <span className="studio-title-current" title={title}>{title}</span>
    <span className="studio-titlebar-actions">{actions}</span>
    <span className="studio-window-controls" aria-label="Window controls">
      {windowPlacements.map((placement) => {
        const command = studioCommand(placement.commandId);
        const state = commandAvailability(command, availability);
        const kind = command.id === "window.minimize" ? "minimize" : command.id === "window.maximize" ? "maximize" : "close";
        const label = placement.label ?? command.label;
        return <button key={placement.id} type="button" {...controlBinding(placement.id, command.action)} aria-label={label} disabled={!onCommand || !state.enabled} title={state.reason} onClick={() => onCommand?.(command.id)}><WindowControlIcon kind={kind} /></button>;
      })}
    </span>
  </div>;
}

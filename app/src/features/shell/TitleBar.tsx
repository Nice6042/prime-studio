import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
  const [open, setOpen] = useState<TitleMenuName | null>(null);
  const menuBar = useRef<HTMLElement>(null);
  const menuTriggers = useRef<Array<HTMLButtonElement | null>>([]);
  const openMenu = useRef<HTMLSpanElement>(null);
  const pendingMenuFocus = useRef<"first" | "last" | null>(null);
  const hoverOpenedMenu = useRef<TitleMenuName | null>(null);
  const closeMenu = () => {
    hoverOpenedMenu.current = null;
    pendingMenuFocus.current = null;
    setOpen(null);
  };
  const enabledMenuItems = () => Array.from(
    openMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
  );
  const focusMenuEdge = (edge: "first" | "last") => {
    const items = enabledMenuItems();
    (edge === "last" ? items[items.length - 1] : items[0])?.focus();
  };
  const openMenuWithFocus = (menu: TitleMenuName, edge: "first" | "last") => {
    if (open === menu) {
      pendingMenuFocus.current = null;
      focusMenuEdge(edge);
      return;
    }
    pendingMenuFocus.current = edge;
    setOpen(menu);
  };
  const onMenuTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, menu: TitleMenuName) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open === menu) closeMenu();
      else openMenuWithFocus(menu, "first");
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    openMenuWithFocus(menu, event.key === "ArrowUp" || event.key === "End" ? "last" : "first");
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!open) return;
      event.preventDefault();
      const currentMenuIndex = menuNames.indexOf(open);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const nextMenuIndex = (currentMenuIndex + delta + menuNames.length) % menuNames.length;
      const nextMenu = menuNames[nextMenuIndex]!;
      menuTriggers.current[nextMenuIndex]?.focus();
      openMenuWithFocus(nextMenu, "first");
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledMenuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (Math.max(current, -1) + 1) % items.length
          : current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };
  usePopoverSurface(openMenu, closeMenu, open !== null, menuBar);
  useLayoutEffect(() => {
    const edge = pendingMenuFocus.current;
    if (!open || !edge) return;
    pendingMenuFocus.current = null;
    focusMenuEdge(edge);
  }, [open]);
  return <div className="studio-titlebar">
    <span className="studio-title-mark" aria-hidden="true"><i /></span><strong>Prime Studio</strong>
    <nav ref={menuBar} className="studio-title-menus" aria-label="Application menu">{menuNames.map((menu, index) => <span className="studio-title-menu-root" key={menu}>
      <button
        ref={(node) => { menuTriggers.current[index] = node; }}
        type="button"
        {...controlBinding(`title-menu-${menu.toLocaleLowerCase()}`, "surface.popover.toggle")}
        aria-label={menu}
        aria-haspopup="menu"
        aria-expanded={open === menu}
        onKeyDown={(event) => onMenuTriggerKeyDown(event, menu)}
        onClick={() => {
          if (hoverOpenedMenu.current === menu) {
            hoverOpenedMenu.current = null;
            return;
          }
          setOpen((value) => value === menu ? null : menu);
        }}
        onPointerEnter={() => {
          if (open && open !== menu) {
            const menuOwnsFocus = document.activeElement instanceof HTMLElement
              && Boolean(openMenu.current?.contains(document.activeElement));
            hoverOpenedMenu.current = menu;
            if (menuOwnsFocus) {
              menuTriggers.current[index]?.focus();
              openMenuWithFocus(menu, "first");
            } else {
              setOpen(menu);
            }
          }
        }}
        onPointerLeave={() => {
          if (hoverOpenedMenu.current === menu) hoverOpenedMenu.current = null;
        }}
      >{menu}</button>
      {open === menu && <span ref={openMenu} data-studio-overlay="menu" className="studio-title-menu" role="menu" aria-label={`${menu} menu`} onKeyDown={onMenuKeyDown}>{titlePlacements.filter((placement) => placement.menu === menu).map((placement) => {
        const command = studioCommand(placement.commandId);
        const state = commandAvailability(command, availability);
        const label = placement.label ?? command.label;
        return <button key={placement.id} type="button" role="menuitem" aria-label={label} {...controlBinding(placement.id, command.action)} disabled={!onCommand || !state.enabled} title={state.reason} onClick={() => { closeMenu(); onCommand?.(command.id); }}><span>{label}</span>{(placement.hint ?? command.shortcuts[0]) && <kbd>{placement.hint ?? command.shortcuts[0]}</kbd>}</button>;
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

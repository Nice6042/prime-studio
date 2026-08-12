import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
import type { StudioCommandId } from "../../entities/commands/commandRegistry";
import { useModalSurfaceFocus } from "../../modalSurface";
import { useTopmostSurfaceEscape } from "../../surfaceEscape";
import { searchPaletteIndex, type PaletteChat, type PaletteMessage, type PaletteResult } from "./searchIndex";
import "./commandPalette.css";

const controls = {
  query: createControlBinding("palette.query", "palette.query.change"),
  result: createControlBinding("palette.result", "palette.result.execute"),
  close: createControlBinding("palette.close", "palette.close"),
};

export function CommandPalette({ admissionConnected, onRun, onClose, restoreFocusTo, chats = [], messages = [], onOpenChat, onOpenMessage }: {
  readonly admissionConnected: boolean;
  readonly onRun: (id: StudioCommandId) => void;
  readonly onClose: () => void;
  readonly restoreFocusTo?: HTMLElement | null;
  readonly chats?: readonly PaletteChat[];
  readonly messages?: readonly PaletteMessage[];
  readonly onOpenChat?: (chatId: string) => void;
  readonly onOpenMessage?: (chatId: string, messageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(restoreFocusTo ?? null);
  restoreFocusRef.current = restoreFocusTo ?? null;
  const results = useMemo(() => searchPaletteIndex(query, { admissionConnected }, chats, messages), [admissionConnected, chats, messages, query]);
  const groups = useMemo(() => (["Actions", "Chats", "Messages"] as const).map((name) => ({ name, rows: results.filter((result) => result.group === name) })).filter((group) => group.rows.length > 0), [results]);
  const enabledIndexes = useMemo(() => results.flatMap((result, index) => result.enabled ? [index] : []), [results]);
  const selectedIndex = results[active]?.enabled ? active : (enabledIndexes[0] ?? -1);
  const current = selectedIndex >= 0 ? results[selectedIndex] : undefined;

  useTopmostSurfaceEscape(backdropRef, onClose);
  const keepFocusInside = useModalSurfaceFocus(backdropRef, dialogRef, inputRef, restoreFocusRef);
  useEffect(() => setActive(0), [query]);

  const execute = (result: PaletteResult | undefined) => {
    if (!result?.enabled) return;
    if (result.kind === "command") onRun(result.command.id);
    else if (result.kind === "chat") onOpenChat?.(result.chatId);
    else onOpenMessage?.(result.chatId, result.messageId);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); if (enabledIndexes.length > 0) setActive(enabledIndexes[(enabledIndexes.indexOf(selectedIndex) + 1) % enabledIndexes.length]); }
    else if (event.key === "ArrowUp") { event.preventDefault(); if (enabledIndexes.length > 0) setActive(enabledIndexes[(enabledIndexes.indexOf(selectedIndex) - 1 + enabledIndexes.length) % enabledIndexes.length]); }
    else if (event.key === "Enter") { event.preventDefault(); execute(current); }
  };

  return <div ref={backdropRef} data-studio-overlay="dialog" className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} onKeyDown={keepFocusInside}>
      <div className="command-palette-search"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg><input ref={inputRef} role="combobox" aria-label="Search commands, chats, and messages" aria-controls="studio-command-results" aria-expanded="true" aria-activedescendant={current ? `palette-${current.id}` : undefined} data-control-id={controls.query.controlId} data-action={controls.query.action} value={query} onChange={(event) => setQuery(event.currentTarget.value.slice(0, 200))} onKeyDown={onKeyDown} placeholder="Search actions, chats, and messages" /><kbd>Esc</kbd></div>
      <div id="studio-command-results" className="command-palette-results" role="listbox" aria-label="Search results">
        {results.length === 0 && <p className="command-palette-empty">No results</p>}
        {groups.map((group) => <section role="group" aria-label={group.name} key={group.name}><h2>{group.name}</h2>{group.rows.map((result) => {
          const index = results.indexOf(result);
          return <button id={`palette-${result.id}`} key={result.id} type="button" role="option" aria-selected={index === selectedIndex} aria-disabled={!result.enabled} data-control-id={`${controls.result.controlId}.${result.id}`} data-action={controls.result.action} onMouseMove={() => { if (result.enabled) setActive(index); }} onClick={() => execute(result)}><span><strong>{result.title}</strong><small>{result.detail}</small></span>{result.kind === "command" && result.command.shortcuts[0] && <kbd>{result.command.shortcuts[0]}</kbd>}</button>;
        })}</section>)}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><button type="button" data-control-id={controls.close.controlId} data-action={controls.close.action} onClick={onClose}>Close</button></footer>
    </section>
  </div>;
}

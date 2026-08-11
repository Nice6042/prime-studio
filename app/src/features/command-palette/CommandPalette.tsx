import { useEffect, useMemo, useRef, useState } from "react";

import { searchStudioCommands, type StudioCommandId } from "../../entities/commands/commandRegistry";
import "./commandPalette.css";

export function CommandPalette({ admissionConnected, onRun, onClose, restoreFocusTo }: {
  readonly admissionConnected: boolean;
  readonly onRun: (id: StudioCommandId) => void;
  readonly onClose: () => void;
  readonly restoreFocusTo?: HTMLElement | null;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchStudioCommands(query), [query]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => { if (restoreFocusTo?.isConnected && !restoreFocusTo.hasAttribute("disabled")) restoreFocusTo.focus(); };
  }, [restoreFocusTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="command-palette-search"><span aria-hidden="true">⌕</span><input ref={inputRef} role="combobox" aria-label="Search commands" aria-controls="studio-command-results" aria-expanded="true" value={query} onChange={(event) => setQuery(event.target.value.slice(0, 200))} placeholder="Search commands" /><kbd>Esc</kbd></div>
      <div id="studio-command-results" className="command-palette-results" role="listbox" aria-label="Commands">
        {results.length === 0 && <p className="command-palette-empty">No commands found</p>}
        {results.map((command) => {
          const availability = command.availability({ admissionConnected });
          return <button
            key={command.id}
            type="button"
            role="option"
            aria-selected="false"
            aria-disabled={!availability.enabled}
            onClick={() => { if (availability.enabled) { onRun(command.id); onClose(); } }}
          ><span><strong>{command.label}</strong><small>{availability.reason ?? command.group}</small></span>{command.shortcuts[0] && <kbd>{command.shortcuts[0]}</kbd>}</button>;
        })}
      </div>
    </section>
  </div>;
}

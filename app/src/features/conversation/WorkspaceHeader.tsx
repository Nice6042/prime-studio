import { useEffect, useRef, useState } from "react";

import type { ActiveWorkspaceChat, WorkspaceChatSummary, WorkspaceOperationState } from "./workspacePresentation";
import { controlBinding } from "./controlBinding";
import { useModalSurfaceFocus } from "../../modalSurface";
import { usePopoverSurface, useTopmostSurfaceEscape } from "../../surfaceEscape";

function HeaderIcon({ kind }: { readonly kind: "folder" | "chevron" | "down" | "pin" | "more" | "panel" }) {
  const path = {
    folder: <path d="M3 7h7l2 2h9v10H3z" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    down: <path d="m6 9 6 6 6-6" />,
    pin: <><path d="M12 17v5M9 4h6l1 7 3 2H5l3-2z" /></>,
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  }[kind];
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path}</svg>;
}

export function WorkspaceHeader({
  projectName,
  chat,
  chats,
  moveTargets = [],
  operation,
  inspectorHidden = false,
  onSelectChat,
  onSetPinned,
  onRename,
  onDuplicate,
  onMove,
  onArchive,
  onDelete,
  onOpenInspector,
}: {
  readonly projectName: string;
  readonly chat: ActiveWorkspaceChat;
  readonly chats: readonly WorkspaceChatSummary[];
  readonly moveTargets?: readonly Readonly<{ id: string; name: string }>[];
  readonly operation: WorkspaceOperationState;
  readonly inspectorHidden?: boolean;
  readonly onSelectChat: (chatId: string) => void;
  readonly onSetPinned: (pinned: boolean) => void;
  readonly onRename: (title: string) => void;
  readonly onDuplicate: () => void;
  readonly onMove: (targetProjectId: string) => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onOpenInspector: () => void;
}) {
  const [menu, setMenu] = useState<"switcher" | "actions" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState("");
  const [renameDraft, setRenameDraft] = useState(chat.title);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuSurface = useRef<HTMLDivElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const renameBackdrop = useRef<HTMLDivElement>(null);
  const renameDialog = useRef<HTMLElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const moveBackdrop = useRef<HTMLDivElement>(null);
  const moveDialog = useRef<HTMLElement>(null);
  const moveSelect = useRef<HTMLSelectElement>(null);
  const busy = operation.phase === "pending";

  usePopoverSurface(menuSurface, () => setMenu(null), menu !== null);
  useTopmostSurfaceEscape(renameBackdrop, () => { setRenameDraft(chat.title); setRenaming(false); }, renaming);
  useTopmostSurfaceEscape(moveBackdrop, () => { setMoveTargetId(""); setMoving(false); }, moving);
  const keepRenameFocus = useModalSurfaceFocus(renameBackdrop, renameDialog, renameInput, optionsButton, renaming);
  const keepMoveFocus = useModalSurfaceFocus(moveBackdrop, moveDialog, moveSelect, optionsButton, moving);

  useEffect(() => setRenameDraft(chat.title), [chat.title]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menuRoot.current && event.target instanceof Node && !menuRoot.current.contains(event.target)) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  const run = (callback: () => void) => {
    setMenu(null);
    callback();
  };

  return <>
    <header className="conversation-header" ref={menuRoot}>
      <HeaderIcon kind="folder" />
      <span className="conversation-breadcrumb-project">{projectName}</span>
      <span className="conversation-breadcrumb-chevron"><HeaderIcon kind="chevron" /></span>
      <div className="conversation-header-popover-root">
        <button type="button" className="conversation-chat-switcher" aria-haspopup="menu" aria-expanded={menu === "switcher"} aria-label="Switch chat" onClick={() => setMenu((value) => value === "switcher" ? null : "switcher")}>
          <span>{chat.title}</span><HeaderIcon kind="down" />
        </button>
        {menu === "switcher" && <div ref={menuSurface} data-studio-overlay="menu" className="conversation-popover conversation-switcher-menu" role="menu" aria-label="Chats">
          {chats.map((candidate) => <button key={candidate.id} type="button" role="menuitemradio" {...controlBinding(`chat-switch-${candidate.id}`, "catalog.chat.select")} aria-checked={candidate.id === chat.id} onClick={() => run(() => onSelectChat(candidate.id))}>
            <span>{candidate.title}</span>{candidate.id === chat.id && <span aria-hidden="true">✓</span>}
          </button>)}
          {chats.length === 0 && <p>No other chats</p>}
        </div>}
      </div>
      <span className="conversation-header-spacer" />
      <button type="button" className="conversation-header-action conversation-pin-action" {...controlBinding("chat-pin-toggle", "catalog.chat.pin-toggle")} aria-label={chat.pinned ? "Unpin chat" : "Pin chat"} aria-pressed={chat.pinned} disabled={busy} onClick={() => onSetPinned(!chat.pinned)}><HeaderIcon kind="pin" /></button>
      <div className="conversation-header-popover-root">
        <button ref={optionsButton} type="button" className="conversation-header-action" aria-label="Chat options" aria-haspopup="menu" aria-expanded={menu === "actions"} disabled={busy} onClick={() => setMenu((value) => value === "actions" ? null : "actions")}><HeaderIcon kind="more" /></button>
        {menu === "actions" && <div ref={menuSurface} data-studio-overlay="menu" className="conversation-popover conversation-action-menu" role="menu" aria-label="Chat options">
          <button type="button" role="menuitem" {...controlBinding("chat-pin-menu-toggle", "catalog.chat.pin-toggle")} onClick={() => run(() => onSetPinned(!chat.pinned))}>{chat.pinned ? "Unpin chat" : "Pin chat"}</button>
          <button type="button" role="menuitem" {...controlBinding("chat-rename", "catalog.chat.rename")} onClick={() => { setMenu(null); setRenaming(true); }}>Rename</button>
          <button type="button" role="menuitem" {...controlBinding("chat-duplicate", "catalog.chat.duplicate")} onClick={() => run(onDuplicate)}>Duplicate</button>
          <button type="button" role="menuitem" {...controlBinding("chat-move", "catalog.chat.move")} disabled={moveTargets.length === 0} title={moveTargets.length === 0 ? "No other active projects" : undefined} onClick={() => { setMenu(null); setMoving(true); }}>Move to project</button>
          <hr />
          <button type="button" role="menuitem" {...controlBinding("chat-archive", "catalog.chat.archive")} onClick={() => run(onArchive)}>Archive chat</button>
          <button type="button" role="menuitem" {...controlBinding("chat-delete", "catalog.chat.delete")} className="conversation-menu-danger" onClick={() => run(onDelete)}>Delete chat</button>
        </div>}
      </div>
      {inspectorHidden && <button type="button" className="conversation-header-action" {...controlBinding("inspector-open", "layout.inspector.toggle")} aria-label="Open Harness panel" onClick={onOpenInspector}><HeaderIcon kind="panel" /></button>}
      {operation.phase === "pending" && <span className="conversation-header-status" role="status">{operation.label}</span>}
      {operation.phase === "error" && <span className="conversation-header-status error" role="alert">{operation.message}</span>}
      {operation.phase === "success" && <span className="conversation-header-status" role="status">{operation.message}</span>}
      {operation.phase === "disabled" && <span className="conversation-header-status" role="status">{operation.reason}</span>}
    </header>
    {renaming && <div ref={renameBackdrop} data-studio-overlay="dialog" className="conversation-dialog-backdrop" role="presentation">
      <section ref={renameDialog} className="conversation-dialog" role="dialog" aria-modal="true" aria-label="Rename chat" tabIndex={-1} onKeyDown={keepRenameFocus}>
        <h2>Rename chat</h2>
        <label>Chat name<input ref={renameInput} aria-label="Chat name" value={renameDraft} maxLength={160} onChange={(event) => setRenameDraft(event.currentTarget.value)} /></label>
        <div className="conversation-dialog-actions">
          <button type="button" onClick={() => { setRenameDraft(chat.title); setRenaming(false); }}>Cancel</button>
          <button type="button" className="primary" {...controlBinding("chat-rename-save", "catalog.chat.rename")} disabled={!renameDraft.trim() || renameDraft.trim() === chat.title} onClick={() => { onRename(renameDraft.trim()); setRenaming(false); }}>Save name</button>
        </div>
      </section>
    </div>}
    {moving && <div ref={moveBackdrop} data-studio-overlay="dialog" className="conversation-dialog-backdrop" role="presentation">
      <section ref={moveDialog} className="conversation-dialog" role="dialog" aria-modal="true" aria-label="Move chat" tabIndex={-1} onKeyDown={keepMoveFocus}>
        <h2>Move chat</h2>
        <label>Destination project<select ref={moveSelect} aria-label="Destination project" value={moveTargetId} onChange={(event) => setMoveTargetId(event.currentTarget.value)}>
          <option value="">Choose a project</option>
          {moveTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select></label>
        <div className="conversation-dialog-actions">
          <button type="button" onClick={() => { setMoveTargetId(""); setMoving(false); }}>Cancel</button>
          <button type="button" className="primary" {...controlBinding("chat-move-save", "catalog.chat.move")} disabled={!moveTargetId} onClick={() => {
            onMove(moveTargetId);
            setMoveTargetId("");
            setMoving(false);
          }}>Move chat</button>
        </div>
      </section>
    </div>}
  </>;
}

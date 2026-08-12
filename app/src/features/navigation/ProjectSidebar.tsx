import { useEffect, useRef, useState } from "react";

import type { NavigationProject } from "./navigationSelectors";
import { controlBinding } from "../conversation/controlBinding";
import { useModalSurfaceFocus } from "../../modalSurface";
import { useTopmostSurfaceEscape } from "../../surfaceEscape";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { WorkspaceFooter } from "./WorkspaceFooter";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";
import "./navigation.css";

export function CreateProjectDialog({ onCreate, onCancel, restoreFocusTo }: {
  readonly onCreate: (name: string, folderPath: string) => void;
  readonly onCancel: () => void;
  readonly restoreFocusTo?: HTMLElement | null;
}) {
  const [projectName, setProjectName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(restoreFocusTo ?? null);
  restoreFocusRef.current = restoreFocusTo ?? null;
  useTopmostSurfaceEscape(backdropRef, onCancel);
  const keepFocusInside = useModalSurfaceFocus(backdropRef, dialogRef, initialFocusRef, restoreFocusRef);
  return <div ref={backdropRef} data-studio-overlay="dialog" className="project-dialog-backdrop" role="presentation">
    <section ref={dialogRef} className="project-dialog" role="dialog" aria-modal="true" aria-label="Create project" tabIndex={-1} onKeyDown={keepFocusInside}>
      <h2>Create project</h2>
      <label>Project name<input ref={initialFocusRef} aria-label="Project name" value={projectName} maxLength={160} onChange={(event) => setProjectName(event.currentTarget.value)} /></label>
      <label>Folder path<input aria-label="Folder path" value={folderPath} maxLength={4096} onChange={(event) => setFolderPath(event.currentTarget.value)} placeholder="C:\\path\\to\\project" /></label>
      <div className="project-dialog-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" {...controlBinding("project-create-save", "catalog.project.create")} disabled={!projectName.trim() || !folderPath.trim()} onClick={() => onCreate(projectName.trim(), folderPath.trim())}>Create project</button>
      </div>
    </section>
  </div>;
}

export function NavigationIcon({ kind }: { readonly kind: "add" | "search" | "folder" | "chat" | "settings" | "pin" | "chevron" | "menu" | "harness" | "editor" | "command" | "archive" | "more" | "collapse" }) {
  const paths = {
    add: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    folder: <path d="M3 7.5h7l2 2h9v9.5H3z" />,
    chat: <path d="M4 5h16v11H9l-5 4z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></>,
    pin: <path d="m9 3 6 6-2 2 3 3-2 2-3-3-2 2-6-6 2-2 2 2 2-2z" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    menu: <><path d="M5 7h14M5 12h14M5 17h14" /></>,
    harness: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M9 5v14M13 9h4M13 13h4" /></>,
    editor: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    command: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M8 11h6M11 8v6" /></>,
    archive: <><path d="M3 8v13h18V8M1 3h22v5H1" /><path d="M10 12h4" /></>,
    more: <><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" /></>,
    collapse: <><path d="m11 7-5 5 5 5M18 7l-5 5 5 5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

export function ProjectSidebar({
  projects,
  query = "",
  onSearch,
  onSelectChat,
  onToggleProject,
  onNewChat,
  onOpenSettings,
  onOpenSearch,
  onNewProject,
  onOpenArchived,
  workspace,
  workspaceMenuOpen,
  onExecuteWorkspaceOperation,
  onCollapse,
  newChatDisabledReason,
}: {
  readonly projects: readonly NavigationProject[];
  readonly query?: string;
  readonly onSearch?: (query: string) => void;
  readonly onSelectChat: (chatId: string) => void;
  readonly onToggleProject: (projectId: string) => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenSearch?: () => void;
  readonly onNewProject?: (name: string, folderPath: string) => void;
  readonly onOpenArchived?: () => void;
  readonly workspace: WorkspaceIdentityProjection;
  readonly workspaceMenuOpen: boolean;
  readonly onExecuteWorkspaceOperation: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly onCollapse?: () => void;
  readonly newChatDisabledReason?: string;
}) {
  const [search, setSearch] = useState(query);
  const [creatingProject, setCreatingProject] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const newProjectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  return <div className="project-sidebar">
    <div className="project-sidebar-brand">
      <span className="project-mark" aria-hidden="true"><span /></span>
      <strong>Prime Studio</strong>
      {onCollapse && <button type="button" className="project-brand-action" {...controlBinding("sidebar-collapse", "layout.sidebar.toggle")} aria-label="Collapse sidebar" onClick={onCollapse}><NavigationIcon kind="collapse" /></button>}
    </div>
    <button
      className="project-primary-action"
      type="button"
      aria-label="New chat"
      {...controlBinding("sidebar-new-chat", "catalog.chat.create")}
      onClick={onNewChat}
      disabled={Boolean(newChatDisabledReason)}
      title={newChatDisabledReason}
    ><NavigationIcon kind="add" /><span>New chat</span><kbd>Ctrl+N</kbd></button>
    {onOpenSearch ? <button type="button" className="project-search-trigger" {...controlBinding("sidebar-search", "palette.open")} aria-label="Search" onClick={onOpenSearch}><NavigationIcon kind="search" /><span>Search</span><kbd>Ctrl+K</kbd></button> : <label className="project-search">
        <NavigationIcon kind="search" />
        <span className="sr-only">Search chats</span>
        <input
          ref={searchRef}
          type="search"
          aria-label="Search chats"
          value={search}
          placeholder="Search chats"
          onChange={(event) => {
            const bounded = Array.from(event.currentTarget.value).slice(0, 200).join("");
            setSearch(bounded);
            onSearch?.(bounded);
          }}
        />
      </label>}
    <div className="project-list" aria-label="Projects">
      <div className="project-section-label"><NavigationIcon kind="pin" /><span>Pinned</span></div>
      <div className="project-pinned-list">
        {projects.flatMap((project) => project.chats.filter((chat) => chat.pinned).map((chat) => ({ ...chat, projectName: project.name }))).map((chat) => <button key={chat.id} type="button" {...controlBinding(`sidebar-pinned-${chat.id}`, "catalog.chat.select")} className="chat-row pinned-chat-row" aria-label={`${chat.title}, pinned${chat.unread ? ", unread" : ""}`} aria-current={chat.selected ? "page" : undefined} onClick={() => onSelectChat(chat.id)}>
          <NavigationIcon kind="chat" /><span className="chat-title">{chat.title}</span>{chat.unread && <span className="chat-unread" aria-hidden="true" />}
        </button>)}
      </div>
      <div className="project-section-heading"><span>Projects</span>{onNewProject && <button ref={newProjectRef} type="button" {...controlBinding("sidebar-new-project", "catalog.project.create")} aria-label="New project" onClick={() => setCreatingProject(true)}><NavigationIcon kind="add" /></button>}</div>
      {projects.map((project) => <section className="project-group" key={project.id}>
        <button
          type="button"
          className="project-disclosure"
          {...controlBinding(`sidebar-project-${project.id}`, "catalog.project.toggle")}
          aria-expanded={project.expanded}
          onClick={() => onToggleProject(project.id)}
        >
          <span className="project-chevron" aria-hidden="true" data-expanded={project.expanded}><NavigationIcon kind="chevron" /></span>
          <NavigationIcon kind="folder" />
          <span>{project.name}</span>
          {project.pinned && <span className="project-pin" title="Pinned"><NavigationIcon kind="pin" /></span>}
        </button>
        {project.expanded && <div className="chat-list" role="list" aria-label={`${project.name} chats`}>
          {project.chats.map((chat) => {
            const state = chat.status === "idle" ? "" : `, ${chat.status}`;
            const unread = chat.unread ? ", unread" : "";
            return <div role="listitem" key={chat.id}>
              <button
                type="button"
                {...controlBinding(`sidebar-chat-${chat.id}`, "catalog.chat.select")}
                className="chat-row"
                data-session-status={chat.status}
                aria-label={`${chat.title}${state}${unread}`}
                aria-current={chat.selected ? "page" : undefined}
                onClick={() => onSelectChat(chat.id)}
              >
                <NavigationIcon kind="chat" />
                <span className="chat-title">{chat.title}</span>
                {chat.status === "working" && <span className="chat-working" aria-hidden="true" />}
                {chat.status !== "idle" && chat.status !== "working" && <span className={`chat-status chat-status-${chat.status}`}>{chat.status}</span>}
                {chat.unread && <span className="chat-unread" aria-hidden="true" />}
              </button>
            </div>;
          })}
        </div>}
      </section>)}
      {projects.length === 0 && <p className="project-empty">No matching chats</p>}
      {onOpenArchived && <button type="button" className="project-archived" {...controlBinding("sidebar-archived", "route.archived.open")} onClick={onOpenArchived}><NavigationIcon kind="archive" />Archived chats</button>}
    </div>
    <footer className="project-sidebar-footer">
      <button className="project-settings" type="button" {...controlBinding("sidebar-settings", "route.settings.open")} aria-label="Settings" onClick={onOpenSettings}><NavigationIcon kind="settings" /><span>Settings</span><kbd>Ctrl+,</kbd></button>
      <WorkspaceFooter identity={workspace} variant="expanded" open={workspaceMenuOpen} onExecute={onExecuteWorkspaceOperation} />
    </footer>
    {creatingProject && <CreateProjectDialog restoreFocusTo={newProjectRef.current} onCancel={() => setCreatingProject(false)} onCreate={(name, path) => { onNewProject?.(name, path); setCreatingProject(false); }} />}
  </div>;
}

import { useEffect, useId, useRef, useState } from "react";

import type { NavigationProject } from "./navigationSelectors";
import { controlBinding } from "../conversation/controlBinding";
import { useModalSurfaceFocus } from "../../modalSurface";
import { useTopmostSurfaceEscape } from "../../surfaceEscape";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { commandPlacements, studioCommand, type StudioCommandId } from "../../entities/commands/commandRegistry";
import { WorkspaceFooter } from "./WorkspaceFooter";
import type { WorkspaceIdentityProjection } from "./workspaceIdentity";
import type { NavigationChat } from "./navigationSelectors";
import "./navigation.css";

function sidebarPresentation(commandId: StudioCommandId) {
  const placement = commandPlacements("sidebar").find((candidate) => candidate.commandId === commandId);
  if (!placement) throw new Error(`Missing sidebar placement for ${commandId}.`);
  const command = studioCommand(commandId);
  return { id: placement.id, label: placement.label ?? command.label, hint: placement.hint ?? command.shortcuts[0], action: command.action };
}

const sidebarCommands = {
  newChat: sidebarPresentation("chat.new"),
  search: sidebarPresentation("palette.open"),
  newProject: sidebarPresentation("project.new"),
  archived: sidebarPresentation("archived.open"),
  settings: sidebarPresentation("settings.open"),
  collapse: sidebarPresentation("sidebar.toggle"),
};

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

function ChatLifecycleIndicator({ chat, descriptionId }: { readonly chat: NavigationChat; readonly descriptionId: string }) {
  const { status, label, detail } = chat.lifecycle;
  const description = `${label}: ${detail}`;
  return <>
    <span className={`chat-lifecycle chat-lifecycle-${status}`} title={description} aria-hidden="true">
      <span className="chat-lifecycle-mark" />
      <span className="chat-lifecycle-label">{label}</span>
    </span>
    <span id={descriptionId} role="tooltip" className="sr-only">{description}</span>
  </>;
}

function ChatRow({ chat, pinned = false, onSelect }: { readonly chat: NavigationChat; readonly pinned?: boolean; readonly onSelect: () => void }) {
  const lifecycleDescriptionId = useId();
  return <button
    type="button"
    {...controlBinding(`${pinned ? "sidebar-pinned" : "sidebar-chat"}-${chat.id}`, "catalog.chat.select")}
    className={`chat-row${pinned ? " pinned-chat-row" : ""}`}
    data-session-status={chat.lifecycle.status}
    aria-label={`${chat.title}${pinned ? ", pinned" : ""}, status: ${chat.lifecycle.label}${chat.unread ? ", unread" : ""}`}
    aria-describedby={lifecycleDescriptionId}
    aria-current={chat.selected ? "page" : undefined}
    onClick={onSelect}
  >
    <NavigationIcon kind="chat" />
    <span className="chat-title">{chat.title}</span>
    <ChatLifecycleIndicator chat={chat} descriptionId={lifecycleDescriptionId} />
    {chat.unread && <span className="chat-unread" title="Unread" aria-hidden="true" />}
  </button>;
}

function ProjectGroup({ project, onToggleProject, onSelectChat }: {
  readonly project: NavigationProject;
  readonly onToggleProject: (projectId: string) => void;
  readonly onSelectChat: (chatId: string) => void;
}) {
  const chatListId = useId();
  const toggle = () => onToggleProject(project.id);
  const onDisclosureKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowRight" && !project.expanded) || (event.key === "ArrowLeft" && project.expanded)) {
      event.preventDefault();
      toggle();
    }
  };
  return <section className="project-group">
    <button
      type="button"
      className="project-disclosure"
      {...controlBinding(`sidebar-project-${project.id}`, "catalog.project.toggle")}
      aria-label={`${project.name} project`}
      aria-expanded={project.expanded}
      aria-controls={chatListId}
      onClick={toggle}
      onKeyDown={onDisclosureKeyDown}
    >
      <span className="project-chevron" aria-hidden="true" data-expanded={project.expanded}><NavigationIcon kind="chevron" /></span>
      <NavigationIcon kind="folder" />
      <span>{project.name}</span>
      {project.pinned && <span className="project-pin" title="Pinned"><NavigationIcon kind="pin" /></span>}
    </button>
    <div id={chatListId} className="chat-list" role="list" aria-label={`${project.name} chats`} hidden={!project.expanded}>
      {project.chats.map((chat) => <div role="listitem" key={chat.id}><ChatRow chat={chat} onSelect={() => onSelectChat(chat.id)} /></div>)}
    </div>
  </section>;
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
      {onCollapse && <button
        type="button"
        className="project-brand-action"
        {...controlBinding(sidebarCommands.collapse.id, sidebarCommands.collapse.action)}
        aria-label={sidebarCommands.collapse.label}
        onClick={onCollapse}
      ><NavigationIcon kind="collapse" /></button>}
    </div>
    <button
      className="project-primary-action"
      type="button"
      aria-label={sidebarCommands.newChat.label}
      {...controlBinding(sidebarCommands.newChat.id, sidebarCommands.newChat.action)}
      onClick={onNewChat}
      disabled={Boolean(newChatDisabledReason)}
      title={newChatDisabledReason}
    ><NavigationIcon kind="add" /><span>{sidebarCommands.newChat.label}</span><kbd>{sidebarCommands.newChat.hint}</kbd></button>
    {onOpenSearch ? <button type="button" className="project-search-trigger" {...controlBinding(sidebarCommands.search.id, sidebarCommands.search.action)} aria-label={sidebarCommands.search.label} onClick={onOpenSearch}><NavigationIcon kind="search" /><span>{sidebarCommands.search.label}</span><kbd>{sidebarCommands.search.hint}</kbd></button> : <label className="project-search">
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
        {projects.flatMap((project) => project.chats.filter((chat) => chat.pinned)).map((chat) => <ChatRow key={chat.id} chat={chat} pinned onSelect={() => onSelectChat(chat.id)} />)}
      </div>
      <div className="project-section-heading"><span>Projects</span>{onNewProject && <button ref={newProjectRef} type="button" {...controlBinding(sidebarCommands.newProject.id, sidebarCommands.newProject.action)} aria-label={sidebarCommands.newProject.label} onClick={() => setCreatingProject(true)}><NavigationIcon kind="add" /></button>}</div>
      {projects.map((project) => <ProjectGroup key={project.id} project={project} onToggleProject={onToggleProject} onSelectChat={onSelectChat} />)}
      {projects.length === 0 && <p className="project-empty">No matching chats</p>}
      {onOpenArchived && <button type="button" className="project-archived" {...controlBinding(sidebarCommands.archived.id, sidebarCommands.archived.action)} onClick={onOpenArchived}><NavigationIcon kind="archive" />{sidebarCommands.archived.label}</button>}
    </div>
    <footer className="project-sidebar-footer">
      <button className="project-settings" type="button" {...controlBinding(sidebarCommands.settings.id, sidebarCommands.settings.action)} aria-label={sidebarCommands.settings.label} onClick={onOpenSettings}><NavigationIcon kind="settings" /><span>{sidebarCommands.settings.label}</span><kbd>{sidebarCommands.settings.hint}</kbd></button>
      <WorkspaceFooter identity={workspace} variant="expanded" open={workspaceMenuOpen} onExecute={onExecuteWorkspaceOperation} />
    </footer>
    {creatingProject && <CreateProjectDialog restoreFocusTo={newProjectRef.current} onCancel={() => setCreatingProject(false)} onCreate={(name, path) => { onNewProject?.(name, path); setCreatingProject(false); }} />}
  </div>;
}

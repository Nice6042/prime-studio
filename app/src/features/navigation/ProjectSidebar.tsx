import { useEffect, useRef, useState } from "react";

import type { NavigationProject } from "./navigationSelectors";
import "./navigation.css";

export function NavigationIcon({ kind }: { readonly kind: "add" | "search" | "folder" | "chat" | "settings" | "pin" | "chevron" }) {
  const paths = {
    add: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    folder: <path d="M3 7.5h7l2 2h9v9.5H3z" />,
    chat: <path d="M4 5h16v11H9l-5 4z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></>,
    pin: <path d="m9 3 6 6-2 2 3 3-2 2-3-3-2 2-6-6 2-2 2 2 2-2z" />,
    chevron: <path d="m9 6 6 6-6 6" />,
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
  newChatDisabledReason,
}: {
  readonly projects: readonly NavigationProject[];
  readonly query?: string;
  readonly onSearch?: (query: string) => void;
  readonly onSelectChat: (chatId: string) => void;
  readonly onToggleProject: (projectId: string) => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly newChatDisabledReason?: string;
}) {
  const [search, setSearch] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);
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
      <span className="project-mark" aria-hidden="true">P</span>
      <strong>Prime Studio</strong>
    </div>
    <button
      className="project-primary-action"
      type="button"
      onClick={onNewChat}
      disabled={Boolean(newChatDisabledReason)}
      title={newChatDisabledReason}
    ><NavigationIcon kind="add" />New chat</button>
    <label className="project-search">
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
    </label>
    <div className="project-list" role="list" aria-label="Projects">
      {projects.map((project) => <section className="project-group" key={project.id} role="listitem">
        <button
          type="button"
          className="project-disclosure"
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
                className="chat-row"
                aria-label={`${chat.title}${state}${unread}`}
                aria-current={chat.selected ? "page" : undefined}
                onClick={() => onSelectChat(chat.id)}
              >
                <NavigationIcon kind="chat" />
                <span className="chat-title">{chat.title}</span>
                {chat.status === "working" && <span className="chat-working" aria-hidden="true" />}
                {chat.unread && <span className="chat-unread" aria-hidden="true" />}
              </button>
            </div>;
          })}
        </div>}
      </section>)}
      {projects.length === 0 && <p className="project-empty">No matching chats</p>}
    </div>
    <button className="project-settings" type="button" onClick={onOpenSettings}><NavigationIcon kind="settings" />Settings</button>
  </div>;
}

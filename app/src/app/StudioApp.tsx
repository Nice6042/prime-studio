import { useEffect, useMemo, useState } from "react";

import * as rpc from "../rpc";
import type { LayoutPreferencesV1 } from "../types";
import { RuntimeStatusBar } from "../features/shell/RuntimeStatusBar";
import { TitleBar } from "../features/shell/TitleBar";
import { WorkspaceShell } from "../features/shell/WorkspaceShell";
import { CollapsedSidebar } from "../features/navigation/CollapsedSidebar";
import { ProjectSidebar } from "../features/navigation/ProjectSidebar";
import { selectNavigationProjects } from "../features/navigation/navigationSelectors";
import { ParentConversation } from "../features/conversation/ParentConversation";
import { useStudioSelector, useStudioStore } from "./AppProviders";

function useViewportWidth() {
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export function StudioApp() {
  const store = useStudioStore();
  const navigation = useStudioSelector((state) => state.navigation);
  const projectCatalog = useStudioSelector((state) => state.projectCatalog);
  const selectedChat = useStudioSelector((state) => navigation.selectedChatId ? state.chats[navigation.selectedChatId] : null);
  const sessions = useStudioSelector((state) => state.sessions);
  const selectedSession = Object.values(sessions).find((session) => session.chatId === navigation.selectedChatId) ?? null;
  const compatibility = useStudioSelector((state) => state.compatibility);
  const viewport = useViewportWidth();
  const [layout, setLayout] = useState<LayoutPreferencesV1>({
    schemaVersion: 1,
    sidebarOpen: true,
    sidebarWidth: 264,
    inspectorOpen: true,
    inspectorWidth: 384,
    editorOpen: false,
    editorWidth: 400,
  });
  const [query, setQuery] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(projectCatalog.projects.filter((project) => !project.archived).map((project) => project.id)),
  );

  const sessionStates = useMemo(() => Object.fromEntries(
    Object.values(sessions).map((session) => [session.chatId, session.state]),
  ), [sessions]);
  const projects = useMemo(() => selectNavigationProjects(projectCatalog, {
    expandedProjectIds,
    activityMs: {},
    unreadChatIds: new Set(),
    sessionStates,
    query,
  }), [expandedProjectIds, projectCatalog, query, sessionStates]);

  useEffect(() => {
    let active = true;
    void rpc.getLayoutPreferences().then((preferences) => {
      if (active) setLayout(preferences);
    });
    return () => { active = false; };
  }, []);

  const changeLayout = (patch: Partial<LayoutPreferencesV1>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    void rpc.setLayoutPreferences(next).catch(() => undefined);
  };

  const openSettings = () => store.dispatch({ type: "route/settings" });
  const sidebarContent = layout.sidebarOpen
    ? <ProjectSidebar
        projects={projects}
        query={query}
        onSearch={setQuery}
        onSelectChat={(chatId) => {
          const project = projectCatalog.projects.find((candidate) => candidate.chats.some((chat) => chat.id === chatId));
          if (project) store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: project.id, chatId } });
        }}
        onToggleProject={(projectId) => setExpandedProjectIds((current) => {
          const next = new Set(current);
          if (next.has(projectId)) next.delete(projectId);
          else next.add(projectId);
          return next;
        })}
        onNewChat={() => undefined}
        newChatDisabledReason="New chat activation is not connected yet."
        onOpenSettings={openSettings}
      />
    : <CollapsedSidebar
        onExpand={() => changeLayout({ sidebarOpen: true })}
        onNewChat={() => undefined}
        newChatDisabledReason="New chat activation is not connected yet."
        onOpenSettings={openSettings}
      />;

  if (navigation.route === "settings") {
    return <main aria-label="Settings"><h1>Settings</h1></main>;
  }

  const title = selectedChat?.title ?? "Prime Studio";
  const archived = projectCatalog.projects.some((project) => project.chats.some(
    (chat) => chat.id === navigation.selectedChatId && chat.archived,
  ));
  return <div className="studio-application">
    <TitleBar title={title} />
    <WorkspaceShell
      viewport={viewport}
      sidebar={{ open: layout.sidebarOpen, preferred: layout.sidebarWidth }}
      inspector={{ open: layout.inspectorOpen, preferred: layout.inspectorWidth }}
      editor={{ open: layout.editorOpen, preferred: layout.editorWidth }}
      conversationLabel={title}
      onSidebarPreferred={(sidebarWidth) => changeLayout({ sidebarWidth })}
      onInspectorPreferred={(inspectorWidth) => changeLayout({ inspectorWidth })}
      onEditorPreferred={(editorWidth) => changeLayout({ editorWidth })}
      sidebarContent={sidebarContent}
      conversation={<ParentConversation title={title} session={selectedSession} archived={archived} />}
      inspectorContent={<div><strong>Harness</strong><p>{compatibility.status.replace("_", " ")}</p></div>}
    />
    <RuntimeStatusBar session={selectedSession} />
  </div>;
}

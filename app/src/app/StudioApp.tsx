import { useEffect, useMemo, useState } from "react";

import * as rpc from "../rpc";
import type { Account, AppSettings, LayoutPreferencesV1 } from "../types";
import { RuntimeStatusBar } from "../features/shell/RuntimeStatusBar";
import { TitleBar } from "../features/shell/TitleBar";
import { WorkspaceShell } from "../features/shell/WorkspaceShell";
import { CollapsedSidebar } from "../features/navigation/CollapsedSidebar";
import { NavigationIcon, ProjectSidebar } from "../features/navigation/ProjectSidebar";
import { selectNavigationProjects } from "../features/navigation/navigationSelectors";
import { applyProjectCatalogCommand, loadProjectCatalog } from "../features/navigation/projectCatalogClient";
import { ParentConversation } from "../features/conversation/ParentConversation";
import { Composer } from "../features/conversation/Composer";
import { WorkspaceHeader } from "../features/conversation/WorkspaceHeader";
import type { WorkspaceOperationState } from "../features/conversation/workspacePresentation";
import { deriveComposerState } from "../features/conversation/composerModel";
import { HarnessInspector } from "../features/harness/HarnessInspector";
import { SettingsShell } from "../features/settings/SettingsShell";
import { CommandPalette } from "../features/command-palette/CommandPalette";
import type { StudioCommandId } from "../entities/commands/commandRegistry";
import { EditorPane } from "../features/editor/EditorPane";
import { useStudioSelector, useStudioStore } from "./AppProviders";

let bootstrapPromise: ReturnType<typeof rpc.bootstrapHarness> | null = null;
let catalogPromise: ReturnType<typeof loadProjectCatalog> | null = null;

function loadHarnessProjection() {
  bootstrapPromise ??= rpc.bootstrapHarness().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });
  return bootstrapPromise;
}

function loadCatalogProjection() {
  catalogPromise ??= loadProjectCatalog().catch((error) => {
    catalogPromise = null;
    throw error;
  });
  return catalogPromise;
}

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
  const drafts = useStudioSelector((state) => state.drafts);
  const attachments = useStudioSelector((state) => state.attachments);
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
  const [settings, setSettings] = useState<AppSettings>({});
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteOpener, setPaletteOpener] = useState<HTMLElement | null>(null);
  const [activeSheet, setActiveSheet] = useState<"sidebar" | "inspector" | "editor" | null>(null);
  const [canvas, setCanvas] = useState<Readonly<{ chatId: string; messageId: string; displayRevision: number; content: string }> | null>(null);
  const [displayRevisions, setDisplayRevisions] = useState<Readonly<Record<string, Readonly<Record<string, Readonly<{ revision: number; content: string }>>>>>>({});
  const [inspectorRouteRequest, setInspectorRouteRequest] = useState<Readonly<{ id: number; route: "overview" | "usage" | "activity" }> | undefined>();
  const [admissionPhase, setAdmissionPhase] = useState<"idle" | "submitting" | "aborting">("idle");
  const [admissionMessage, setAdmissionMessage] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(projectCatalog.projects.filter((project) => !project.archived).map((project) => project.id)),
  );
  const [catalogOperation, setCatalogOperation] = useState<WorkspaceOperationState>({ phase: "idle" });

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

  useEffect(() => {
    let active = true;
    void rpc.getAppSettings().then((next) => { if (active) setSettings(next); });
    void rpc.listAccounts().then((next) => { if (active) setAccounts(next); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void loadHarnessProjection().then((projection) => {
      if (!active) return;
      store.dispatch({ type: "harness/bootstrap-loaded", projection });
      unsubscribe = rpc.subscribeHarnessEvents((event) => {
        if (active) store.dispatch({ type: "harness/session-projected", session: event.session });
      });
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [store]);

  useEffect(() => {
    setAdmissionPhase("idle");
    setAdmissionMessage("");
  }, [navigation.selectedChatId]);

  useEffect(() => {
    let active = true;
    void loadCatalogProjection().then((snapshot) => {
      if (active) store.dispatch({ type: "project-catalog/loaded", snapshot });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [store]);

  const changeLayout = (patch: Partial<LayoutPreferencesV1>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    void rpc.setLayoutPreferences(next).catch(() => undefined);
  };

  const openPalette = () => {
    setPaletteOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setPaletteOpen(true);
  };

  const applyCatalog = async (command: Parameters<typeof applyProjectCatalogCommand>[1], label: string) => {
    const revision = store.getSnapshot().catalogRevision;
    if (revision === null) {
      setCatalogOperation({ phase: "error", message: `${label} failed because the project catalog is unavailable.` });
      return;
    }
    setCatalogOperation({ phase: "pending", label });
    try {
      const snapshot = await applyProjectCatalogCommand(revision, command);
      store.dispatch({ type: "project-catalog/loaded", snapshot });
      setCatalogOperation({ phase: "success", message: `${label} complete.` });
    } catch {
      setCatalogOperation({ phase: "error", message: `${label} failed. Retry the action.` });
    }
  };

  const createChat = () => {
    const projectId = store.getSnapshot().projectCatalog.selectedProjectId;
    void applyCatalog({ type: "chat.create", projectId, chatId: `chat-${crypto.randomUUID()}`, title: "New chat" }, "Creating chat");
  };

  const runCommand = (id: StudioCommandId) => {
    switch (id) {
      case "chat.new": createChat(); return;
      case "palette.open": openPalette(); return;
      case "settings.open": store.dispatch({ type: "route/settings" }); return;
      case "settings.usage": store.dispatch({ type: "route/settings", section: "usage" }); return;
      case "sidebar.toggle": changeLayout({ sidebarOpen: !layout.sidebarOpen }); return;
      case "inspector.toggle": changeLayout({ inspectorOpen: !layout.inspectorOpen }); return;
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !event.ctrlKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLocaleLowerCase();
      const command = key === "k" ? "palette.open" : key === "," ? "settings.open" : key === "b" ? "sidebar.toggle" : key === "j" ? "inspector.toggle" : key === "n" ? "chat.new" : null;
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openSettings = () => store.dispatch({ type: "route/settings" });
  const admissionConnected = Boolean(
    selectedSession
    && selectedSession.freshness === "live"
    && (compatibility.status === "ready" || compatibility.status === "degraded")
    && compatibility.capabilities.includes("session_input_admission"),
  );
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
        onNewChat={createChat}
        newChatDisabledReason={catalogOperation.phase === "pending" ? catalogOperation.label : undefined}
        onOpenSearch={openPalette}
        onOpenArchived={() => store.dispatch({ type: "route/settings", section: "archived" })}
        onCollapse={() => changeLayout({ sidebarOpen: false })}
        onOpenSettings={openSettings}
      />
    : <CollapsedSidebar
        onExpand={() => changeLayout({ sidebarOpen: true })}
        onNewChat={createChat}
        newChatDisabledReason={catalogOperation.phase === "pending" ? catalogOperation.label : undefined}
        onOpenSearch={openPalette}
        onOpenSettings={openSettings}
      />;
  const sidebarRailContent = <CollapsedSidebar
    onExpand={() => changeLayout({ sidebarOpen: true })}
    onNewChat={createChat}
    newChatDisabledReason={catalogOperation.phase === "pending" ? catalogOperation.label : undefined}
    onOpenSearch={openPalette}
    onOpenSettings={openSettings}
  />;

  if (navigation.route === "settings") {
    return <><SettingsShell
      section={navigation.settingsSection}
      onSection={(section) => store.dispatch({ type: "route/settings", section })}
      onBack={() => store.dispatch({ type: "route/workspace" })}
      compatibility={compatibility}
      settings={settings}
      accounts={accounts}
      onAccountsChanged={(next) => {
        if (next) setAccounts(next);
        else void rpc.listAccounts().then(setAccounts).catch(() => undefined);
      }}
      onSetting={(key, value) => {
        void rpc.setAppSetting(key, value).then(setSettings).catch(() => undefined);
      }}
    />{paletteOpen && <CommandPalette admissionConnected={admissionConnected} onRun={runCommand} onClose={() => setPaletteOpen(false)} restoreFocusTo={paletteOpener} />}</>;
  }

  const title = selectedChat?.title ?? "Prime Studio";
  const archived = projectCatalog.projects.some((project) => project.chats.some(
    (chat) => chat.id === navigation.selectedChatId && chat.archived,
  ));
  const draft = navigation.selectedChatId ? (drafts[navigation.selectedChatId] ?? "") : "";
  const composerState = deriveComposerState({
    compatibility,
    sessionState: selectedSession?.state ?? null,
    archived,
    draft,
    phase: admissionPhase,
    admissionConnected,
  });
  const submitToHarness = async (kind: "prompt" | "steer" | "follow_up" | "abort", text: string) => {
    if (!selectedSession || !navigation.selectedChatId || !admissionConnected) return;
    if ((attachments[navigation.selectedChatId] ?? []).length > 0) {
      setAdmissionMessage("Attachments are retained in this draft until native attachment admission is available.");
      return;
    }
    setAdmissionPhase(kind === "abort" ? "aborting" : "submitting");
    setAdmissionMessage("");
    try {
      const result = await rpc.sendHarnessCommand({
        sessionId: selectedSession.sessionId,
        commandId: `studio-${crypto.randomUUID()}`,
        expectedCursor: selectedSession.cursor,
        kind,
        text,
      });
      store.dispatch({ type: "harness/session-projected", session: result.session });
      if (kind !== "abort") {
        store.dispatch({ type: "draft/change", chatId: navigation.selectedChatId, draft: "" });
      }
      setAdmissionMessage(result.outcome === "queued" ? "Prompt queued." : result.outcome === "reconciled" ? "Command reconciled after reconnect." : "");
    } catch {
      setAdmissionMessage("The Harness did not admit this command. Your draft was preserved.");
    } finally {
      setAdmissionPhase("idle");
    }
  };
  return <div className="studio-application">
    <TitleBar title={title} actions={<>
      <button type="button" className="studio-command-trigger" aria-label="Projects" aria-pressed={viewport < 760 ? activeSheet === "sidebar" : layout.sidebarOpen} onClick={() => { if (viewport < 760) { changeLayout({ sidebarOpen: true }); setActiveSheet((value) => value === "sidebar" ? null : "sidebar"); } else changeLayout({ sidebarOpen: !layout.sidebarOpen }); }}><NavigationIcon kind="menu" /></button>
      <button type="button" className="studio-command-trigger" aria-label="Harness" aria-pressed={viewport < 760 ? activeSheet === "inspector" : layout.inspectorOpen} onClick={() => { if (viewport < 760) { changeLayout({ inspectorOpen: true }); setActiveSheet((value) => value === "inspector" ? null : "inspector"); } else changeLayout({ inspectorOpen: !layout.inspectorOpen }); }}><NavigationIcon kind="harness" /></button>
      <button type="button" className="studio-command-trigger" aria-label={layout.editorOpen ? "Close editor" : "Open editor"} onClick={() => { changeLayout({ editorOpen: !layout.editorOpen }); setActiveSheet(layout.editorOpen ? null : "editor"); }}><NavigationIcon kind="editor" /></button>
      <button type="button" className="studio-command-trigger" aria-label="Open command palette" onClick={openPalette}><NavigationIcon kind="command" /></button>
    </>} />
    <WorkspaceShell
      viewport={viewport}
      sidebar={{ open: layout.sidebarOpen, preferred: layout.sidebarWidth }}
      inspector={{ open: layout.inspectorOpen, preferred: layout.inspectorWidth }}
      editor={{ open: layout.editorOpen, preferred: layout.editorWidth }}
      conversationLabel={title}
      onSidebarPreferred={(sidebarWidth) => changeLayout({ sidebarWidth })}
      onInspectorPreferred={(inspectorWidth) => changeLayout({ inspectorWidth })}
      onEditorPreferred={(editorWidth) => changeLayout({ editorWidth })}
      activeSheet={activeSheet}
      sidebarContent={sidebarContent}
      sidebarRailContent={sidebarRailContent}
      conversation={<div className="conversation-stage">
        {selectedChat && (() => {
          const project = projectCatalog.projects.find((candidate) => candidate.id === selectedChat.projectId);
          const catalogChat = project?.chats.find((candidate) => candidate.id === selectedChat.id);
          return <WorkspaceHeader
            projectName={project?.name ?? "Personal"}
            chat={{ id: selectedChat.id, title: selectedChat.title, pinned: catalogChat?.pinned ?? false }}
            chats={project?.chats.filter((candidate) => !candidate.archived).map((candidate) => ({ id: candidate.id, title: candidate.title })) ?? []}
            operation={catalogOperation}
            inspectorHidden={!layout.inspectorOpen}
            onSelectChat={(chatId) => { if (project) store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: project.id, chatId } }); }}
            onSetPinned={(pinned) => { if (project) void applyCatalog({ type: "chat.set-pinned", projectId: project.id, chatId: selectedChat.id, pinned }, pinned ? "Pinning chat" : "Unpinning chat"); }}
            onRename={(nextTitle) => { if (project) void applyCatalog({ type: "chat.rename", projectId: project.id, chatId: selectedChat.id, title: nextTitle }, "Renaming chat"); }}
            onDuplicate={() => { if (project) void applyCatalog({ type: "chat.duplicate", projectId: project.id, chatId: selectedChat.id, newChatId: `chat-${crypto.randomUUID()}`, title: `${selectedChat.title} copy` }, "Duplicating chat"); }}
            onMove={() => setCatalogOperation({ phase: "disabled", reason: "Choose a destination project from the project menu before moving this chat." })}
            onArchive={() => { if (project) void applyCatalog({ type: "chat.archive", projectId: project.id, chatId: selectedChat.id }, "Archiving chat"); }}
            onDelete={() => { if (project) void applyCatalog({ type: "chat.delete", projectId: project.id, chatId: selectedChat.id }, "Deleting chat"); }}
            onOpenInspector={() => changeLayout({ inspectorOpen: true })}
          />;
        })()}
        <ParentConversation
          title={title}
          session={selectedSession}
          archived={archived}
          displayRevisions={navigation.selectedChatId ? displayRevisions[navigation.selectedChatId] : undefined}
          onOpenCanvas={navigation.selectedChatId ? (messageId, content) => {
            const existing = displayRevisions[navigation.selectedChatId!]?.[messageId];
            setCanvas({ chatId: navigation.selectedChatId!, messageId, displayRevision: existing?.revision ?? 1, content });
            changeLayout({ editorOpen: true });
            setActiveSheet("editor");
          } : undefined}
          onSuggestionFill={navigation.selectedChatId ? (text) => store.dispatch({ type: "draft/change", chatId: navigation.selectedChatId!, draft: text }) : undefined}
        />
        {navigation.selectedChatId && <Composer
          draft={draft}
          state={composerState}
          attachments={attachments[navigation.selectedChatId] ?? []}
          onDraftChange={(nextDraft) => store.dispatch({ type: "draft/change", chatId: navigation.selectedChatId!, draft: nextDraft })}
          onAttachmentsChange={(nextAttachments) => store.dispatch({ type: "attachments/change", chatId: navigation.selectedChatId!, attachments: nextAttachments })}
          onSubmit={() => { void submitToHarness(
            selectedSession?.state === "working" || selectedSession?.state === "blocked"
              ? compatibility.status !== "unavailable" && compatibility.status !== "read_only" && compatibility.capabilities.includes("queue_management") ? "follow_up" : "steer"
              : "prompt",
            draft,
          ); }}
          onAbort={() => { void submitToHarness("abort", ""); }}
          statusMessage={admissionMessage}
          onOpenUsage={() => {
            changeLayout({ inspectorOpen: true });
            setInspectorRouteRequest((current) => ({ id: (current?.id ?? 0) + 1, route: "usage" }));
          }}
        />}
      </div>}
      inspectorContent={<HarnessInspector
        chatId={navigation.selectedChatId}
        session={selectedSession}
        compatibility={compatibility}
        routeRequest={inspectorRouteRequest}
        onCollapse={() => { changeLayout({ inspectorOpen: false }); setActiveSheet(null); }}
        onOpenAccountUsage={() => store.dispatch({ type: "route/settings", section: "usage" })}
      />}
      editorContent={<EditorPane
        onClose={() => { changeLayout({ editorOpen: false }); setActiveSheet(null); }}
        canvas={canvas?.chatId === navigation.selectedChatId ? canvas : null}
        onCanvasApply={canvas ? (content) => {
          const revision = canvas.displayRevision + 1;
          setDisplayRevisions((current) => Object.freeze({ ...current, [canvas.chatId]: Object.freeze({ ...(current[canvas.chatId] ?? {}), [canvas.messageId]: Object.freeze({ revision, content }) }) }));
          setCanvas({ ...canvas, displayRevision: revision, content });
        } : undefined}
      />}
    />
    <RuntimeStatusBar session={selectedSession} />
    {paletteOpen && <CommandPalette admissionConnected={admissionConnected} onRun={runCommand} onClose={() => setPaletteOpen(false)} restoreFocusTo={paletteOpener} />}
  </div>;
}

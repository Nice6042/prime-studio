import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

import * as rpc from "../rpc";
import type { Account, AppSettings, LayoutPreferencesV1 } from "../types";
import { RuntimeStatusBar } from "../features/shell/RuntimeStatusBar";
import { TitleBar } from "../features/shell/TitleBar";
import { WorkspaceShell } from "../features/shell/WorkspaceShell";
import { CollapsedSidebar } from "../features/navigation/CollapsedSidebar";
import { CreateProjectDialog, NavigationIcon, ProjectSidebar } from "../features/navigation/ProjectSidebar";
import { selectNavigationProjects } from "../features/navigation/navigationSelectors";
import { applyProjectCatalogCommand, branchResidentCatalogChat, createResidentForCatalogChat, loadProjectCatalog } from "../features/navigation/projectCatalogClient";
import { residentCreationDisabledReason } from "../features/navigation/residentCreationPolicy";
import { ParentConversation } from "../features/conversation/ParentConversation";
import { controlBinding } from "../features/conversation/controlBinding";
import { Composer } from "../features/conversation/Composer";
import { WorkspaceHeader } from "../features/conversation/WorkspaceHeader";
import type { WorkspaceOperationState } from "../features/conversation/workspacePresentation";
import { deriveComposerState, deriveSlashCommands, type SlashCommand } from "../features/conversation/composerModel";
import { projectConversationPresentations } from "../features/conversation/conversationDisplay";
import { routeSlashCommand } from "../features/conversation/conversationRouting";
import { HarnessInspector } from "../features/harness/HarnessInspector";
import { unavailableHarnessInspectorAdapter, type HarnessComposerProjection, type HarnessInspectorAdapter } from "../features/harness/adapter";
import { SettingsShell } from "../features/settings/SettingsShell";
import { ArchivedCatalogSettings } from "../features/settings/ArchivedCatalogSettings";
import { CommandPalette } from "../features/command-palette/CommandPalette";
import type { PaletteChat, PaletteMessage } from "../features/command-palette/searchIndex";
import { studioCommands, type StudioCommandId } from "../entities/commands/commandRegistry";
import { EditorPane } from "../features/editor/EditorPane";
import type { ArtifactDocument } from "../entities/editor/types";
import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { createStudioOperationDispatcher } from "../contracts/dispatcher/studioOperationDispatcher";
import { useStudioSelector, useStudioStore } from "./AppProviders";
import { installWorkspacePreferences } from "./workspacePreferences";
import { hasOpenStudioOverlay } from "../surfaceEscape";
import { chatAttentionEvidence, deriveUnreadChatIds } from "../attention/attentionLedger";
import { loadAttentionSnapshot, markAttentionSeen } from "../attention/attentionClient";

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

function operationAccepted(status: string): boolean {
  return status === "accepted" || status === "updated";
}

function artifactDraftKey(document: ArtifactDocument): string {
  return `${document.ref.brokerId}:${document.ref.rootSessionId}:${document.ref.artifactId}`;
}

export function StudioApp({ harnessAdapter = unavailableHarnessInspectorAdapter }: { readonly harnessAdapter?: HarnessInspectorAdapter } = {}) {
  const store = useStudioStore();
  const navigation = useStudioSelector((state) => state.navigation);
  const projectCatalog = useStudioSelector((state) => state.projectCatalog);
  const selectedChat = useStudioSelector((state) => navigation.selectedChatId ? state.chats[navigation.selectedChatId] : null);
  const sessions = useStudioSelector((state) => state.sessions);
  const selectedCatalogChat = navigation.selectedChatId
    ? projectCatalog.projects.flatMap((project) => project.chats).find((chat) => chat.id === navigation.selectedChatId && !chat.archived) ?? null
    : null;
  const selectedSession = selectedCatalogChat?.binding ? sessions[selectedCatalogChat.binding.sessionId] ?? null : null;
  const selectedChatEvidence = selectedSession ? chatAttentionEvidence(selectedSession) : null;
  const compatibility = useStudioSelector((state) => state.compatibility);
  const drafts = useStudioSelector((state) => state.drafts);
  const attachments = useStudioSelector((state) => state.attachments);
  const conversationDisplay = useStudioSelector((state) => state.conversationDisplay);
  const attention = useStudioSelector((state) => state.attention);
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
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectOpener, setCreateProjectOpener] = useState<HTMLElement | null>(null);
  const [paletteOpener, setPaletteOpener] = useState<HTMLElement | null>(null);
  const [activeSheet, setActiveSheet] = useState<"sidebar" | "inspector" | "editor" | null>(null);
  const sheetOpener = useRef<HTMLElement | null>(null);
  const [canvas, setCanvas] = useState<Readonly<{ chatId: string; messageId: string; displayRevision: number; content: string }> | null>(null);
  const [editorArtifact, setEditorArtifact] = useState<ArtifactDocument | null>(null);
  const [artifactDrafts, setArtifactDrafts] = useState<Readonly<Record<string, string>>>({});
  const [displayRevisions, setDisplayRevisions] = useState<Readonly<Record<string, Readonly<Record<string, Readonly<{ revision: number; content: string }>>>>>>({});
  const [inspectorRouteRequest, setInspectorRouteRequest] = useState<Readonly<{ id: number; route: "overview" | "usage" | "activity" }> | undefined>();
  const [admissionPhase, setAdmissionPhase] = useState<"idle" | "submitting" | "aborting">("idle");
  const [admissionMessage, setAdmissionMessage] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(projectCatalog.projects.filter((project) => !project.archived).map((project) => project.id)),
  );
  const [catalogOperation, setCatalogOperation] = useState<WorkspaceOperationState>({ phase: "idle" });
  const [operationFeedback, setOperationFeedback] = useState<string | null>(null);
  const [loadedComposer, setLoadedComposer] = useState<Readonly<{ sessionId: string; projection: HarnessComposerProjection }> | null>(null);
  const [composerUnavailableReason, setComposerUnavailableReason] = useState<string | null>(null);

  const adapterConnected = harnessAdapter.availability.status === "available";
  const hasCapability = (capability: string) => compatibility.status !== "unavailable" && compatibility.status !== "read_only" && compatibility.capabilities.includes(capability as typeof compatibility.capabilities[number]);

  const sessionStates = useMemo(() => Object.fromEntries(
    projectCatalog.projects.flatMap((project) => project.chats).flatMap((chat) => {
      const session = chat.binding ? sessions[chat.binding.sessionId] : null;
      return session ? [[chat.id, session.state] as const] : [];
    }),
  ), [projectCatalog.projects, sessions]);
  const projects = useMemo(() => selectNavigationProjects(projectCatalog, {
    expandedProjectIds,
    activityMs: {},
    unreadChatIds: deriveUnreadChatIds(projectCatalog, sessions, navigation.selectedChatId, attention),
    sessionStates,
    query,
  }), [attention, expandedProjectIds, navigation.selectedChatId, projectCatalog, query, sessionStates, sessions]);
  const paletteChats = useMemo<readonly PaletteChat[]>(() => projectCatalog.projects.flatMap((project) =>
    project.chats.map((chat) => ({ id: chat.id, title: chat.title, project: project.name, archived: project.archived || chat.archived })),
  ), [projectCatalog]);
  const paletteMessages = useMemo<readonly PaletteMessage[]>(() => Object.values(sessions).flatMap((session) => {
    const project = projectCatalog.projects.find((candidate) => candidate.chats.some((chat) => chat.binding?.sessionId === session.sessionId));
    const chat = project?.chats.find((candidate) => candidate.binding?.sessionId === session.sessionId);
    if (!chat) return [];
    return session.parentMessages.map((message) => {
      const excerpt = message.kind === "assistant"
        ? message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join(" ")
        : message.text;
      return { id: message.id, chatId: chat.id, project: project?.name ?? "Personal", excerpt, channel: "parent" as const };
    });
  }), [projectCatalog.projects, sessions]);

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

  useEffect(
    () => installWorkspacePreferences(settings),
    [settings.theme, settings.density, settings.reducedMotion],
  );

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
    let active = true;
    if (!selectedSession || !adapterConnected || !hasCapability("model_catalog") || !harnessAdapter.loadComposer) {
      setLoadedComposer(null);
      setComposerUnavailableReason(harnessAdapter.loadComposer ? null : "The verified Harness adapter does not expose session composer configuration.");
      return () => { active = false; };
    }
    setComposerUnavailableReason(null);
    void harnessAdapter.loadComposer(selectedSession.sessionId).then((projection) => {
      if (active) setLoadedComposer({ sessionId: selectedSession.sessionId, projection });
    }).catch((error) => {
      if (!active) return;
      setLoadedComposer(null);
      setComposerUnavailableReason(error instanceof Error ? error.message : "Verified composer configuration is unavailable.");
    });
    return () => { active = false; };
  }, [adapterConnected, compatibility, harnessAdapter, selectedSession?.cursor.runtimeGeneration, selectedSession?.cursor.sequence, selectedSession?.sessionId]);

  useEffect(() => {
    setAdmissionPhase("idle");
    setAdmissionMessage("");
    setEditorArtifact(null);
  }, [navigation.selectedChatId]);

  useEffect(() => {
    if (!activeSheet) return;
    const opener = sheetOpener.current;
    const frame = window.requestAnimationFrame(() => {
      const sheet = document.querySelector<HTMLElement>(`[data-studio-sheet="${activeSheet}"]`);
      sheet?.querySelector<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setActiveSheet(null);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.requestAnimationFrame(() => opener?.focus());
    };
  }, [activeSheet]);

  useEffect(() => {
    let active = true;
    void loadCatalogProjection().then((snapshot) => {
      if (active) store.dispatch({ type: "project-catalog/loaded", snapshot });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [store]);

  useEffect(() => {
    let active = true;
    void loadAttentionSnapshot().then((snapshot) => {
      if (active) store.dispatch({ type: "attention/loaded", snapshot });
    }).catch((error) => {
      if (active) store.dispatch({ type: "attention/unavailable", reason: error instanceof Error ? error.message : "Attention ledger unavailable." });
    });
    return () => { active = false; };
  }, [store]);

  const changeLayout = async (patch: Partial<LayoutPreferencesV1>): Promise<StudioOperationOutcome> => {
    const next = { ...layout, ...patch };
    setLayout(next);
    try {
      const persisted = await rpc.setLayoutPreferences(next);
      setLayout(persisted);
      return { status: "updated", revision: JSON.stringify(persisted) };
    } catch {
      return { status: "rejected", reason: "The layout changed for this session but could not be saved.", retryable: true };
    }
  };

  const openPalette = () => {
    setPaletteOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setPaletteOpen(true);
  };

  const openCreateProject = () => {
    setCreateProjectOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCreateProjectOpen(true);
  };

  const applyCatalog = async (command: Parameters<typeof applyProjectCatalogCommand>[1], label: string): Promise<StudioOperationOutcome> => {
    const revision = store.getSnapshot().catalogRevision;
    if (revision === null) {
      setCatalogOperation({ phase: "error", message: `${label} failed because the project catalog is unavailable.` });
      return { status: "unavailable", reason: `${label} failed because the project catalog is unavailable.` };
    }
    setCatalogOperation({ phase: "pending", label });
    try {
      const snapshot = await applyProjectCatalogCommand(revision, command);
      store.dispatch({ type: "project-catalog/loaded", snapshot });
      setCatalogOperation({ phase: "success", message: `${label} complete.` });
      return { status: "updated", revision: snapshot.revision };
    } catch {
      setCatalogOperation({ phase: "error", message: `${label} failed. Retry the action.` });
      return { status: "rejected", reason: `${label} failed. Retry the action.`, retryable: true };
    }
  };

  const persistSeenEvidence = async (chatId: string, channel: "chat" | "activity", activityEvidence?: Parameters<typeof markAttentionSeen>[3]): Promise<StudioOperationOutcome> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = store.getSnapshot();
      if (current.attention.status !== "available") return { status: "unavailable", reason: current.attention.status === "unavailable" ? current.attention.reason : "Attention ledger is still loading." };
      const matches = current.projectCatalog.projects.flatMap((project) => project.chats).filter((chat) => chat.id === chatId && !chat.archived);
      const binding = matches.length === 1 ? matches[0]!.binding : null;
      const session = binding ? current.sessions[binding.sessionId] ?? null : null;
      if (!binding || !session || binding.accountId !== session.accountId || (binding.agentId !== null && binding.agentId !== session.chatId)) return { status: "unavailable", reason: "The chat has no authoritative Harness evidence." };
      const evidence = channel === "chat" ? chatAttentionEvidence(session) : activityEvidence ?? null;
      if (!evidence) return { status: "updated", revision: current.attention.revision };
      try {
        const snapshot = await markAttentionSeen(current.attention.revision, chatId, channel, evidence);
        store.dispatch({ type: "attention/loaded", snapshot });
        return { status: "updated", revision: snapshot.revision };
      } catch (error) {
        if (attempt > 0) return { status: "rejected", reason: error instanceof Error ? error.message : "Attention state could not be saved.", retryable: true };
        try {
          store.dispatch({ type: "attention/loaded", snapshot: await loadAttentionSnapshot() });
        } catch (reloadError) {
          const reason = reloadError instanceof Error ? reloadError.message : "Attention ledger unavailable.";
          store.dispatch({ type: "attention/unavailable", reason });
          return { status: "unavailable", reason };
        }
      }
    }
    return { status: "rejected", reason: "Attention state could not be saved.", retryable: true };
  };

  const createResidentChat = async (projectId: string): Promise<StudioOperationOutcome> => {
    const selectionReason = residentCreationDisabledReason(settings);
    if (selectionReason) return { status: "unavailable", reason: selectionReason };
    const revision = store.getSnapshot().catalogRevision;
    if (revision === null) return { status: "unavailable", reason: "Creating chat failed because the project catalog is unavailable." };
    const chatId = `chat-${crypto.randomUUID()}`;
    setCatalogOperation({ phase: "pending", label: "Creating resident chat" });
    try {
      const created = await applyProjectCatalogCommand(revision, { type: "chat.create", projectId, chatId, title: "New chat" });
      store.dispatch({ type: "project-catalog/loaded", snapshot: created });
      let bound;
      try {
        bound = await createResidentForCatalogChat(created.revision, projectId, chatId);
      } catch {
        const recovered = await loadProjectCatalog();
        store.dispatch({ type: "project-catalog/loaded", snapshot: recovered });
        bound = await createResidentForCatalogChat(recovered.revision, projectId, chatId);
      }
      store.dispatch({ type: "project-catalog/loaded", snapshot: bound.catalog });
      store.dispatch({ type: "harness/session-projected", session: bound.session });
      setCatalogOperation({ phase: "success", message: "Resident chat ready." });
      return { status: "updated", revision: bound.catalog.revision };
    } catch {
      const reason = "The chat was preserved, but its verified Harness session is unavailable. Retry creating the resident session.";
      setCatalogOperation({ phase: "error", message: reason });
      return { status: "rejected", reason, retryable: true };
    }
  };

  const durableExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {
    const catalog = store.getSnapshot().projectCatalog;
    const locateChat = (chatId: string) => catalog.projects.find((project) => project.chats.some((candidate) => candidate.id === chatId));
    switch (operation.action) {
      case "catalog.project.create":
        return applyCatalog({ type: "project.create", projectId: `project-${crypto.randomUUID()}`, name: operation.payload.title, folderPath: operation.payload.folderPath ?? "" }, "Creating project");
      case "catalog.project.restore":
        return applyCatalog({ type: "project.restore", projectId: operation.payload.projectId }, "Restoring project");
      case "catalog.chat.create": {
        const projectId = operation.payload.projectId || catalog.selectedProjectId;
        return createResidentChat(projectId);
      }
      case "catalog.chat.rename": {
        const project = locateChat(operation.payload.chatId);
        return project ? applyCatalog({ type: "chat.rename", projectId: project.id, chatId: operation.payload.chatId, title: operation.payload.title }, "Renaming chat") : { status: "unavailable", reason: "The selected chat is no longer available." };
      }
      case "catalog.chat.duplicate": {
        const project = locateChat(operation.payload.chatId);
        const source = project?.chats.find((chat) => chat.id === operation.payload.chatId);
        return project && source ? applyCatalog({ type: "chat.duplicate", projectId: project.id, chatId: source.id, newChatId: `chat-${crypto.randomUUID()}`, title: `${source.title} copy` }, "Duplicating chat") : { status: "unavailable", reason: "The selected chat is no longer available." };
      }
      case "catalog.chat.move": {
        const project = locateChat(operation.payload.chatId);
        return project ? applyCatalog({ type: "chat.move", projectId: project.id, chatId: operation.payload.chatId, targetProjectId: operation.payload.projectId }, "Moving chat") : { status: "unavailable", reason: "The selected chat is no longer available." };
      }
      case "catalog.chat.pin-toggle": {
        const project = locateChat(operation.payload.chatId);
        const source = project?.chats.find((chat) => chat.id === operation.payload.chatId);
        return project && source ? applyCatalog({ type: "chat.set-pinned", projectId: project.id, chatId: source.id, pinned: !source.pinned }, source.pinned ? "Unpinning chat" : "Pinning chat") : { status: "unavailable", reason: "The selected chat is no longer available." };
      }
      case "catalog.chat.archive":
      case "catalog.chat.delete":
      case "catalog.chat.restore": {
        const project = locateChat(operation.payload.chatId);
        if (!project) return { status: "unavailable", reason: "The selected chat is no longer available." };
        const type = operation.action === "catalog.chat.archive" ? "chat.archive" : operation.action === "catalog.chat.delete" ? "chat.delete" : "chat.restore";
        const label = operation.action === "catalog.chat.archive" ? "Archiving chat" : operation.action === "catalog.chat.delete" ? "Deleting chat" : "Restoring chat";
        return applyCatalog({ type, projectId: project.id, chatId: operation.payload.chatId }, label);
      }
      case "catalog.chat.unread-clear":
        return persistSeenEvidence(operation.payload.chatId, "chat");
      case "activity.seen.mark":
        return persistSeenEvidence(operation.payload.chatId, "activity", operation.payload.evidence);
      case "conversation.user-version.select":
      case "conversation.assistant-version.select":
        store.dispatch({ type: "conversation/version-selected", chatId: operation.payload.chatId, messageId: operation.payload.messageId, kind: operation.action === "conversation.user-version.select" ? "user" : "assistant", version: operation.payload.version });
        return { status: "updated", revision: operation.payload.version };
      case "settings.preference.set": {
        const next = await rpc.setAppSetting(operation.payload.key as keyof AppSettings, String(operation.payload.value));
        setSettings(next);
        return { status: "updated", revision: JSON.stringify(next) };
      }
      case "settings.preference.reset": {
        const next = await rpc.setAppSetting(operation.payload.key as keyof AppSettings, null);
        setSettings(next);
        return { status: "updated", revision: JSON.stringify(next) };
      }
      default:
        return { status: "unavailable", reason: `${operation.action} has no registered durable implementation.` };
    }
  };

  const rendererExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {
    switch (operation.action) {
      case "layout.sidebar.toggle": return changeLayout({ sidebarOpen: !layout.sidebarOpen });
      case "layout.sidebar.resize": return changeLayout({ sidebarWidth: operation.payload.width });
      case "layout.sidebar.reset": return changeLayout({ sidebarWidth: 264 });
      case "layout.inspector.toggle": return changeLayout({ inspectorOpen: !layout.inspectorOpen });
      case "layout.inspector.resize": return changeLayout({ inspectorWidth: operation.payload.width });
      case "layout.inspector.reset": return changeLayout({ inspectorWidth: 384 });
      case "layout.editor.toggle": return changeLayout({ editorOpen: !layout.editorOpen });
      case "layout.editor.resize": return changeLayout({ editorWidth: operation.payload.width });
      case "layout.editor.close": setActiveSheet(null); return changeLayout({ editorOpen: false });
      case "route.settings.open": store.dispatch({ type: "route/settings", section: operation.payload.section }); break;
      case "route.archived.open": store.dispatch({ type: "route/settings", section: "archived" }); break;
      case "route.settings.back":
      case "route.workspace.open": store.dispatch({ type: "route/workspace" }); break;
      case "usage.account.open": store.dispatch({ type: "route/settings", section: "usage" }); break;
      case "palette.open": openPalette(); break;
      case "palette.close": setPaletteOpen(false); break;
      case "surface.popover.toggle":
        if (operation.payload.popoverId === "create-project") openCreateProject();
        else if (operation.payload.popoverId === null) setCreateProjectOpen(false);
        else return { status: "unavailable", reason: `Popover ${operation.payload.popoverId} is unavailable.` };
        break;
      case "catalog.project.toggle": setExpandedProjectIds((current) => { const next = new Set(current); if (next.has(operation.payload.projectId)) next.delete(operation.payload.projectId); else next.add(operation.payload.projectId); return next; }); break;
      case "catalog.chat.select": store.dispatch({ type: "project-chat/command", command: { type: "selection.select-chat", projectId: operation.payload.projectId, chatId: operation.payload.chatId } }); break;
      case "conversation.user-edit.start":
      case "conversation.user-edit.cancel":
      case "conversation.work-details.toggle":
      case "harness.tab.select":
      case "harness.child.open":
      case "harness.child.back":
      case "harness.child.tab-select":
      case "activity.filter.select":
      case "activity.row.toggle":
      case "activity.child.open":
      case "editor.mode.select":
      case "editor.content.change":
      case "settings.search.change":
      case "settings.section.select":
      case "usage.account.range-select":
      case "usage.account.series-toggle":
      case "surface.accordion.toggle":
      case "overlay.topmost.close":
      case "toast.dismiss": break;
      case "conversation.suggestion.fill":
      case "composer.draft.change": store.dispatch({ type: "draft/change", chatId: operation.payload.chatId, draft: operation.payload.text }); break;
      case "composer.attachment.remove": store.dispatch({ type: "attachments/change", chatId: operation.payload.chatId, attachments: (attachments[operation.payload.chatId] ?? []).filter((attachment) => attachment.id !== operation.payload.attachmentId) }); break;
      default: return { status: "unavailable", reason: `${operation.action} has no registered renderer implementation.` };
    }
    return { status: "updated", revision: Date.now() };
  };

  const nativeExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {
    switch (operation.action) {
      case "window.minimize": await getCurrentWindow().minimize(); break;
      case "window.maximize-toggle": await getCurrentWindow().toggleMaximize(); break;
      case "window.close": await getCurrentWindow().close(); break;
      case "route.external-docs.open": await openUrl(operation.payload.document === "support" ? "https://github.com/Nice6042/prime-studio/blob/main/SUPPORT.md" : "https://www.npmjs.com/package/prime-agent"); break;
      case "conversation.response.copy": await navigator.clipboard.writeText(operation.payload.text); break;
      case "activity.command.copy": await navigator.clipboard.writeText(operation.payload.command); break;
      case "history.undo": if (!document.execCommand("undo")) return { status: "rejected", reason: "Undo is unavailable in the active surface.", retryable: false }; break;
      case "history.redo": if (!document.execCommand("redo")) return { status: "rejected", reason: "Redo is unavailable in the active surface.", retryable: false }; break;
      default: return { status: "unavailable", reason: `${operation.action} has no registered native implementation.` };
    }
    return { status: "updated", revision: Date.now() };
  };

  const branchResidentChat = async (sessionId: string, messageId: string): Promise<StudioOperationOutcome> => {
    const current = store.getSnapshot();
    const revision = current.catalogRevision;
    if (revision === null) return { status: "unavailable", reason: "Branching failed because the project catalog is unavailable." };
    const sourceSession = current.sessions[sessionId];
    const matches = current.projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({ project, chat }))).filter(({ chat }) => (
      !chat.archived
      && chat.binding?.sessionId === sessionId
      && chat.id === current.navigation.selectedChatId
    ));
    const source = matches.length === 1 ? matches[0] : null;
    if (
      !sourceSession
      || !source?.chat.binding
      || source.chat.binding.accountId !== sourceSession.accountId
      || (source.chat.binding.agentId !== null && source.chat.binding.agentId !== sourceSession.chatId)
      || !sourceSession.parentMessages.some((message) => message.id === messageId)
    ) return { status: "unavailable", reason: "The selected message has no authoritative resident Harness session to branch." };

    const request = {
      expectedRevision: revision,
      projectId: source.project.id,
      sourceChatId: source.chat.id,
      sourceSessionId: sourceSession.sessionId,
      messageId,
      expectedCursor: sourceSession.cursor,
    };
    setCatalogOperation({ phase: "pending", label: "Creating resident branch" });
    try {
      let branched;
      try {
        branched = await branchResidentCatalogChat(request);
      } catch {
        const recovered = await loadProjectCatalog();
        branched = await branchResidentCatalogChat({ ...request, expectedRevision: recovered.revision });
      }
      store.dispatch({ type: "project-catalog/loaded", snapshot: branched.catalog });
      store.dispatch({ type: "harness/session-projected", session: branched.session });
      setCatalogOperation({ phase: "success", message: "Resident branch ready." });
      return { status: "updated", revision: branched.catalog.revision };
    } catch (error) {
      const detail = error instanceof Error && error.message !== "Project catalog unavailable." ? ` ${error.message}` : "";
      const reason = `The branch could not be verified, so the parent chat remains selected.${detail}`;
      setCatalogOperation({ phase: "error", message: reason });
      return { status: "rejected", reason, retryable: true };
    }
  };

  const harnessExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {
    if (operation.action === "conversation.branch.create") return branchResidentChat(operation.payload.sessionId, operation.payload.messageId);
    if (operation.action === "editor.artifact.open" || operation.action === "activity.file.open" || operation.action === "harness.context-source.open") {
      if (harnessAdapter.availability.status !== "available") return { status: "unavailable", reason: harnessAdapter.availability.reason };
      if (!harnessAdapter.openArtifact) return { status: "unavailable", reason: "The native identity-bound artifact resolver is unavailable." };
      const sessionId = operation.payload.sessionId;
      const candidateId = operation.action === "editor.artifact.open" ? operation.payload.artifactId : operation.action === "activity.file.open" ? operation.payload.fileId : operation.payload.sourceId;
      const result = await harnessAdapter.openArtifact(sessionId, candidateId);
      if (result.kind === "unsupported") return { status: "unavailable", reason: result.reason };
      setEditorArtifact(result.document);
      setCanvas(null);
      await changeLayout({ editorOpen: true });
      if (viewport <= 900) setActiveSheet("editor");
      return { status: "updated", revision: result.document.ref.revision };
    }
    if (operation.action === "harness.session.prompt" || operation.action === "harness.session.follow-up" || operation.action === "harness.session.steer" || operation.action === "harness.session.abort") {
      const sessionId = operation.payload.sessionId;
      const session = Object.values(store.getSnapshot().sessions).find((candidate) => candidate.sessionId === sessionId);
      if (!session) return { status: "unavailable", reason: "The selected Harness session is no longer attached." };
      const kind = operation.action === "harness.session.prompt" ? "prompt" : operation.action === "harness.session.follow-up" ? "follow_up" : operation.action === "harness.session.steer" ? "steer" : "abort";
      const text = operation.action === "harness.session.abort" ? "" : operation.payload.text;
      const result = await rpc.sendHarnessCommand({ sessionId, commandId: `studio-${crypto.randomUUID()}`, expectedCursor: session.cursor, kind, text });
      store.dispatch({ type: "harness/session-projected", session: result.session });
      if (kind !== "abort") store.dispatch({ type: "draft/change", chatId: session.chatId, draft: "" });
      if (result.outcome === "queued") return { status: "queued", commandId: result.commandId, position: null };
      return result.outcome === "accepted" ? { status: "accepted", commandId: result.commandId } : { status: "updated", revision: result.session.cursor.sequence };
    }
    return harnessAdapter.availability.status === "available"
      ? harnessAdapter.execute(operation)
      : { status: "unavailable", reason: harnessAdapter.availability.reason };
  };

  const dispatchOperation = createStudioOperationDispatcher({
    harness: harnessExecutor,
    studioDurable: durableExecutor,
    renderer: rendererExecutor,
    native: nativeExecutor,
    onOutcome: (_operation, outcome) => {
      if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") setOperationFeedback(outcome.reason);
    },
  });

  const selectCatalogChat = async (projectId: string, chatId: string) => {
    const selected = await dispatchOperation({ action: "catalog.chat.select", payload: { projectId, chatId } });
    if (selected.status === "updated" || selected.status === "accepted") {
      await dispatchOperation({ action: "catalog.chat.unread-clear", payload: { chatId } });
    }
  };

  const openCatalogChat = (chatId: string) => {
    const project = store.getSnapshot().projectCatalog.projects.find((candidate) => candidate.chats.some((chat) => chat.id === chatId && !chat.archived));
    if (project) void selectCatalogChat(project.id, chatId);
  };

  useEffect(() => {
    if (attention.status === "available" && navigation.selectedChatId && selectedSession) {
      void dispatchOperation({ action: "catalog.chat.unread-clear", payload: { chatId: navigation.selectedChatId } });
    }
  }, [attention.status, navigation.selectedChatId, selectedChatEvidence?.runtimeGeneration, selectedChatEvidence?.marker, selectedChatEvidence?.occurredAtMs]);

  const createChat = () => {
    const projectId = store.getSnapshot().projectCatalog.selectedProjectId;
    void dispatchOperation({ action: "catalog.chat.create", payload: { projectId } });
  };

  const createProject = (name: string, folderPath: string) => {
    void dispatchOperation({ action: "catalog.project.create", payload: { title: name, folderPath } });
  };

  const runCommand = (id: StudioCommandId) => {
    const command = studioCommands.find((candidate) => candidate.id === id);
    if (!command) return;
    const operation: StudioOperation = id === "chat.new" ? { action: "catalog.chat.create", payload: { projectId: store.getSnapshot().projectCatalog.selectedProjectId } }
      : id === "project.new" ? { action: "surface.popover.toggle", payload: { popoverId: "create-project" } }
        : id === "archived.open" ? { action: "route.archived.open", payload: {} }
          : id === "settings.open" ? { action: "route.settings.open", payload: {} }
            : id === "settings.usage" ? { action: "usage.account.open", payload: {} }
              : id === "sidebar.toggle" ? { action: "layout.sidebar.toggle", payload: {} }
                : id === "inspector.toggle" ? { action: "layout.inspector.toggle", payload: {} }
                  : { action: "palette.open", payload: {} };
    void dispatchOperation(operation);
  };

  const runTitleOperation = (operation: StudioOperation) => {
    const normalized = operation.action === "catalog.chat.create" ? { ...operation, payload: { projectId: store.getSnapshot().projectCatalog.selectedProjectId } } as StudioOperation : operation;
    void dispatchOperation(normalized).then((outcome) => {
      if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") setAdmissionMessage(outcome.reason);
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || hasOpenStudioOverlay() || !event.ctrlKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLocaleLowerCase();
      const command = key === "k" ? "palette.open" : key === "," ? "settings.open" : key === "b" ? "sidebar.toggle" : key === "j" ? "inspector.toggle" : key === "n" ? "chat.new" : null;
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openSettings = () => { void dispatchOperation({ action: "route.settings.open", payload: {} }); };
  const newChatDisabledReason = catalogOperation.phase === "pending" ? catalogOperation.label : residentCreationDisabledReason(settings) ?? undefined;
  const admissionConnected = Boolean(
    selectedSession
    && selectedSession.freshness === "live"
    && (compatibility.status === "ready" || compatibility.status === "degraded")
    && compatibility.capabilities.includes("session_input_admission"),
  );
  const executeSettingOperation = (operation: StudioOperation, key: keyof AppSettings, value: string | null) => {
    void harnessAdapter.execute(operation).then((outcome) => {
      if (operationAccepted(outcome.status)) void rpc.setAppSetting(key, value).then(setSettings).catch(() => undefined);
    }).catch(() => undefined);
  };
  const writeHarnessSetting = adapterConnected && harnessAdapter.settings?.harnessPolicy ? (key: keyof AppSettings, value: string | null) => {
    executeSettingOperation({ action: "settings.harness-policy.set", payload: { key, value: value ?? "" } }, key, value);
  } : undefined;
  const writeToolSetting = adapterConnected && harnessAdapter.settings?.toolPolicy ? (key: keyof AppSettings, value: string | null) => {
    executeSettingOperation({ action: "settings.tool.set-enabled", payload: { toolId: "configurable-tools", enabled: value === "enabled" } }, key, value);
  } : undefined;
  const composerProjection = adapterConnected && hasCapability("model_catalog")
    ? loadedComposer && loadedComposer.sessionId === selectedSession?.sessionId ? loadedComposer.projection : harnessAdapter.composer
    : undefined;
  const sidebarContent = layout.sidebarOpen
    ? <ProjectSidebar
        projects={projects}
        query={query}
        onSearch={setQuery}
        onSelectChat={(chatId) => {
          const project = projectCatalog.projects.find((candidate) => candidate.chats.some((chat) => chat.id === chatId));
          if (project) void selectCatalogChat(project.id, chatId);
        }}
        onToggleProject={(projectId) => { void dispatchOperation({ action: "catalog.project.toggle", payload: { projectId } }); }}
        onNewChat={createChat}
        onNewProject={createProject}
        newChatDisabledReason={newChatDisabledReason}
        onOpenSearch={openPalette}
        onOpenArchived={() => { void dispatchOperation({ action: "route.archived.open", payload: {} }); }}
        onCollapse={() => { if (layout.sidebarOpen) void dispatchOperation({ action: "layout.sidebar.toggle", payload: {} }); }}
        onOpenSettings={openSettings}
      />
    : <CollapsedSidebar
        onExpand={() => { if (!layout.sidebarOpen) void dispatchOperation({ action: "layout.sidebar.toggle", payload: {} }); }}
        onNewChat={createChat}
        newChatDisabledReason={newChatDisabledReason}
        onOpenSearch={openPalette}
        onOpenSettings={openSettings}
      />;
  const sidebarRailContent = <CollapsedSidebar
    onExpand={() => {
      sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!layout.sidebarOpen) void dispatchOperation({ action: "layout.sidebar.toggle", payload: {} });
      if (viewport < 760) setActiveSheet("sidebar");
    }}
    onNewChat={createChat}
    newChatDisabledReason={newChatDisabledReason}
    onOpenSearch={openPalette}
    onOpenSettings={openSettings}
  />;

  if (navigation.route === "settings") {
    if (navigation.settingsSection === "archived") {
      return <>{operationFeedback && <p className="studio-operation-feedback" role="alert" aria-label="Studio operation failed">{operationFeedback}</p>}<main className="studio-settings" aria-label="Archived chats">
        <section className="studio-settings-content"><div className="studio-settings-page"><header><button type="button" className="studio-settings-back" aria-label="Back to chat" onClick={() => store.dispatch({ type: "route/workspace" })}>Back to chat</button><h1>Archived chats</h1><span>Restore archived projects and conversations.</span></header>
          <ArchivedCatalogSettings catalog={projectCatalog} operation={catalogOperation} onRestoreProject={(projectId) => { void dispatchOperation({ action: "catalog.project.restore", payload: { projectId } }); }} onRestoreChat={(_projectId, chatId) => { void dispatchOperation({ action: "catalog.chat.restore", payload: { chatId } }); }} />
        </div></section>
      </main></>;
    }
    return <>{operationFeedback && <p className="studio-operation-feedback" role="alert" aria-label="Studio operation failed">{operationFeedback}</p>}<SettingsShell
      section={navigation.settingsSection}
      onSection={(section) => { void dispatchOperation({ action: "route.settings.open", payload: { section } }); }}
      onBack={() => { void dispatchOperation({ action: "route.settings.back", payload: {} }); }}
      compatibility={compatibility}
      settings={settings}
      accounts={accounts}
      onAccountsChanged={(next) => {
        if (next) setAccounts(next);
        else void rpc.listAccounts().then(setAccounts).catch(() => setOperationFeedback("Account status could not be refreshed."));
      }}
      onSetting={(key, value) => { void dispatchOperation(value === null ? { action: "settings.preference.reset", payload: { key } } : { action: "settings.preference.set", payload: { key, value } }); }}
      onHarnessSetting={writeHarnessSetting}
      onToolSetting={writeToolSetting}
      onExportUsageCsv={rpc.exportAccountUsageCsv}
      composer={composerProjection}
    />{paletteOpen && <CommandPalette admissionConnected={admissionConnected} onRun={runCommand} onClose={() => { void dispatchOperation({ action: "palette.close", payload: {} }); }} restoreFocusTo={paletteOpener} chats={paletteChats} messages={paletteMessages} onOpenChat={openCatalogChat} onOpenMessage={(chatId) => openCatalogChat(chatId)} />}
    {createProjectOpen && <CreateProjectDialog restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}</>;
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
  const supportsComposerCommand = (command: "model" | "effort" | "compact" | "fork" | "export") => Boolean(composerProjection?.supportedCommands.includes(command));
  const latestMessageId = selectedSession?.parentMessages[selectedSession.parentMessages.length - 1]?.id ?? null;
  const slashCommands = deriveSlashCommands({
    model: Boolean(composerProjection?.models.length) && supportsComposerCommand("model"),
    effort: Boolean(composerProjection?.thinkingLevels.length) && supportsComposerCommand("effort"),
    compact: Boolean(selectedSession) && supportsComposerCommand("compact"),
    fork: Boolean(selectedSession && latestMessageId) && hasCapability("resident_sessions") && supportsComposerCommand("fork"),
    new: store.getSnapshot().catalogRevision !== null,
    usage: Boolean(selectedSession),
    export: Boolean(selectedSession) && supportsComposerCommand("export"),
  });
  const runAdapterOperation = async (operation: StudioOperation, label: string, accepted?: () => void) => {
    if (!adapterConnected) {
      setAdmissionMessage(harnessAdapter.availability.reason);
      return;
    }
    setAdmissionMessage(`${label}…`);
    try {
      const outcome = await dispatchOperation(operation);
      if (operationAccepted(outcome.status)) accepted?.();
      if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") setAdmissionMessage(outcome.reason);
      else if (outcome.status === "queued") setAdmissionMessage(outcome.position === null ? `${label} queued.` : `${label} queued at position ${outcome.position}.`);
      else setAdmissionMessage(`${label} accepted.`);
    } catch (error) {
      setAdmissionMessage(error instanceof Error ? error.message : `${label} failed.`);
    }
  };
  const openCurrentUsage = () => {
    if (!layout.inspectorOpen) void dispatchOperation({ action: "layout.inspector.toggle", payload: {} });
    setInspectorRouteRequest((current) => ({ id: (current?.id ?? 0) + 1, route: "usage" }));
  };
  const runSlashCommand = (command: SlashCommand["id"]) => {
    if (!navigation.selectedChatId) return;
    const route = routeSlashCommand(command, { chatId: navigation.selectedChatId, sessionId: selectedSession?.sessionId ?? null, messageId: latestMessageId });
    if (!route) {
      setAdmissionMessage("This command has no verified target in the active chat.");
      return;
    }
    if (route.kind === "new-chat") { createChat(); return; }
    if (route.kind === "usage") { openCurrentUsage(); return; }
    if (route.kind === "model-picker") { setAdmissionMessage("Choose a verified model below."); return; }
    if (route.kind === "effort-picker") { setAdmissionMessage("Choose a verified thinking level below."); return; }
    if (route.kind !== "operation") return;
    void runAdapterOperation(route.operation, command === "compact" ? "Compaction" : command === "fork" ? "Branch" : "Export");
  };
  const submitToHarness = async (kind: "prompt" | "steer" | "follow_up" | "abort", text: string) => {
    if (!selectedSession || !navigation.selectedChatId || !admissionConnected) return;
    if ((attachments[navigation.selectedChatId] ?? []).length > 0) {
      setAdmissionMessage("Attachments are retained in this draft until native attachment admission is available.");
      return;
    }
    setAdmissionPhase(kind === "abort" ? "aborting" : "submitting");
    setAdmissionMessage("");
    try {
      const operation: StudioOperation = kind === "abort" ? { action: "harness.session.abort", payload: { sessionId: selectedSession.sessionId } }
        : kind === "follow_up" ? { action: "harness.session.follow-up", payload: { sessionId: selectedSession.sessionId, text } }
          : kind === "steer" ? { action: "harness.session.steer", payload: { sessionId: selectedSession.sessionId, text } }
            : { action: "harness.session.prompt", payload: { sessionId: selectedSession.sessionId, text } };
      const outcome = await dispatchOperation(operation);
      if (outcome.status === "queued") setAdmissionMessage(outcome.position === null ? "Prompt queued." : `Prompt queued at position ${outcome.position}.`);
      else if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") setAdmissionMessage(outcome.reason);
      else setAdmissionMessage("");
    } catch {
      setAdmissionMessage("The Harness did not admit this command. Your draft was preserved.");
    } finally {
      setAdmissionPhase("idle");
    }
  };
  return <div className="studio-application">
    <TitleBar title={title} onOperation={runTitleOperation} actions={<>
      <button type="button" {...controlBinding("title-projects", "layout.sidebar.toggle")} className="studio-command-trigger" aria-label="Projects" aria-pressed={viewport < 760 ? activeSheet === "sidebar" : layout.sidebarOpen} onClick={(event) => { if (viewport < 760) { sheetOpener.current = event.currentTarget; if (!layout.sidebarOpen) void dispatchOperation({ action: "layout.sidebar.toggle", payload: {} }); setActiveSheet((value) => value === "sidebar" ? null : "sidebar"); } else void dispatchOperation({ action: "layout.sidebar.toggle", payload: {} }); }}><NavigationIcon kind="menu" /></button>
      <button type="button" {...controlBinding("title-harness", "layout.inspector.toggle")} className="studio-command-trigger" aria-label="Harness" aria-pressed={viewport < 760 ? activeSheet === "inspector" : layout.inspectorOpen} onClick={(event) => { if (viewport < 760) { sheetOpener.current = event.currentTarget; if (!layout.inspectorOpen) void dispatchOperation({ action: "layout.inspector.toggle", payload: {} }); setActiveSheet((value) => value === "inspector" ? null : "inspector"); } else void dispatchOperation({ action: "layout.inspector.toggle", payload: {} }); }}><NavigationIcon kind="harness" /></button>
      <button type="button" {...controlBinding("title-editor", layout.editorOpen ? "layout.editor.close" : "layout.editor.toggle")} className="studio-command-trigger" aria-label={layout.editorOpen ? "Close editor" : "Open editor"} onClick={(event) => { if (!layout.editorOpen) sheetOpener.current = event.currentTarget; void dispatchOperation({ action: layout.editorOpen ? "layout.editor.close" : "layout.editor.toggle", payload: {} }); setActiveSheet(layout.editorOpen ? null : "editor"); }}><NavigationIcon kind="editor" /></button>
      <button type="button" {...controlBinding("title-command-palette", "palette.open")} className="studio-command-trigger" aria-label="Open command palette" onClick={() => { void dispatchOperation({ action: "palette.open", payload: {} }); }}><NavigationIcon kind="command" /></button>
    </>} />
    {operationFeedback && <p className="studio-operation-feedback" role="alert" aria-label="Studio operation failed">{operationFeedback}</p>}
    <WorkspaceShell
      viewport={viewport}
      sidebar={{ open: layout.sidebarOpen, preferred: layout.sidebarWidth }}
      inspector={{ open: layout.inspectorOpen, preferred: layout.inspectorWidth }}
      editor={{ open: layout.editorOpen, preferred: layout.editorWidth }}
      conversationLabel={title}
      onSidebarPreferred={(sidebarWidth) => { void dispatchOperation({ action: "layout.sidebar.resize", payload: { width: sidebarWidth } }); }}
      onInspectorPreferred={(inspectorWidth) => { void dispatchOperation({ action: "layout.inspector.resize", payload: { width: inspectorWidth } }); }}
      onEditorPreferred={(editorWidth) => { void dispatchOperation({ action: "layout.editor.resize", payload: { width: editorWidth } }); }}
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
            moveTargets={projectCatalog.projects.filter((candidate) => !candidate.archived && candidate.id !== project?.id).map((candidate) => ({ id: candidate.id, name: candidate.name }))}
            operation={catalogOperation}
            inspectorHidden={!layout.inspectorOpen}
            onSelectChat={(chatId) => { if (project) void selectCatalogChat(project.id, chatId); }}
            onSetPinned={() => { void dispatchOperation({ action: "catalog.chat.pin-toggle", payload: { chatId: selectedChat.id } }); }}
            onRename={(nextTitle) => { void dispatchOperation({ action: "catalog.chat.rename", payload: { chatId: selectedChat.id, title: nextTitle } }); }}
            onDuplicate={() => { void dispatchOperation({ action: "catalog.chat.duplicate", payload: { chatId: selectedChat.id } }); }}
            onMove={(targetProjectId) => { void dispatchOperation({ action: "catalog.chat.move", payload: { chatId: selectedChat.id, projectId: targetProjectId } }); }}
            onArchive={() => { void dispatchOperation({ action: "catalog.chat.archive", payload: { chatId: selectedChat.id } }); }}
            onDelete={() => { void dispatchOperation({ action: "catalog.chat.delete", payload: { chatId: selectedChat.id } }); }}
            onOpenInspector={() => { if (!layout.inspectorOpen) void dispatchOperation({ action: "layout.inspector.toggle", payload: {} }); }}
          />;
        })()}
        <ParentConversation
          title={title}
          session={selectedSession}
          archived={archived}
          displayRevisions={navigation.selectedChatId ? displayRevisions[navigation.selectedChatId] : undefined}
          presentations={navigation.selectedChatId && conversationDisplay[navigation.selectedChatId] ? projectConversationPresentations(conversationDisplay[navigation.selectedChatId]!) : undefined}
          onOpenCanvas={navigation.selectedChatId ? (messageId, content) => {
            const existing = displayRevisions[navigation.selectedChatId!]?.[messageId];
            setCanvas({ chatId: navigation.selectedChatId!, messageId, displayRevision: existing?.revision ?? 1, content });
            if (!layout.editorOpen) void dispatchOperation({ action: "layout.editor.toggle", payload: {} });
            setActiveSheet("editor");
          } : undefined}
          onSuggestionFill={navigation.selectedChatId ? (text) => { void dispatchOperation({ action: "conversation.suggestion.fill", payload: { chatId: navigation.selectedChatId!, text } }); } : undefined}
          onSelectUserVersion={navigation.selectedChatId ? (messageId, version) => { void dispatchOperation({ action: "conversation.user-version.select", payload: { chatId: navigation.selectedChatId!, messageId, version } }); } : undefined}
          onSelectAssistantVersion={navigation.selectedChatId ? (messageId, version) => { void dispatchOperation({ action: "conversation.assistant-version.select", payload: { chatId: navigation.selectedChatId!, messageId, version } }); } : undefined}
          showSuggestions={settings.promptSuggestions !== "disabled"}
          onEditUserMessage={!archived && navigation.selectedChatId && adapterConnected && hasCapability("resident_sessions") ? (messageId, text) => {
            const chatId = navigation.selectedChatId!;
            void runAdapterOperation({ action: "conversation.user-version.create", payload: { chatId, messageId, text } }, "Edit", () => {
              store.dispatch({ type: "conversation/version-appended", chatId, messageId, kind: "user", text });
            });
          } : undefined}
          onBranchFrom={selectedSession && adapterConnected && hasCapability("resident_sessions") ? (messageId) => {
            void runAdapterOperation({ action: "conversation.branch.create", payload: { sessionId: selectedSession.sessionId, messageId } }, "Branch");
          } : undefined}
          onRegenerate={!archived && selectedSession && adapterConnected && hasCapability("session_input_admission") ? (messageId) => {
            void runAdapterOperation({ action: "conversation.response.regenerate", payload: { sessionId: selectedSession.sessionId, messageId } }, "Regeneration");
          } : undefined}
        />
        {navigation.selectedChatId && <Composer
          draft={draft}
          state={composerState}
          attachments={attachments[navigation.selectedChatId] ?? []}
          onDraftChange={(nextDraft) => { void dispatchOperation({ action: "composer.draft.change", payload: { chatId: navigation.selectedChatId!, text: nextDraft } }); }}
          onAttachmentsChange={(nextAttachments) => store.dispatch({ type: "attachments/change", chatId: navigation.selectedChatId!, attachments: nextAttachments })}
          onSubmit={() => { void submitToHarness(
            selectedSession?.state === "working" || selectedSession?.state === "blocked"
              ? compatibility.status !== "unavailable" && compatibility.status !== "read_only" && compatibility.capabilities.includes("queue_management") ? "follow_up" : "steer"
              : "prompt",
            draft,
          ); }}
          onAbort={() => { void submitToHarness("abort", ""); }}
          models={composerProjection?.models ?? []}
          selectedModel={composerProjection?.selectedModel ?? undefined}
          thinking={composerProjection?.selectedThinking ?? undefined}
          thinkingLevels={composerProjection?.thinkingLevels ?? []}
          slashCommands={slashCommands}
          sendShortcut={settings.sendShortcut === "ctrl-enter" ? "ctrl-enter" : "enter"}
          showTokenEstimate={settings.tokenEstimate !== "disabled"}
          onSelectModel={navigation.selectedChatId && supportsComposerCommand("model") ? (modelId) => {
            void runAdapterOperation({ action: "composer.model.select", payload: { chatId: navigation.selectedChatId!, modelId } }, "Model change");
          } : undefined}
          onSelectThinking={navigation.selectedChatId && supportsComposerCommand("effort") ? (level) => {
            void runAdapterOperation({ action: "composer.thinking.select", payload: { chatId: navigation.selectedChatId!, level } }, "Thinking change");
          } : undefined}
          onSlashCommand={runSlashCommand}
          statusMessage={admissionMessage || composerUnavailableReason || undefined}
          onOpenUsage={openCurrentUsage}
        />}
      </div>}
      inspectorContent={<HarnessInspector
        chatId={navigation.selectedChatId}
        session={selectedSession}
        compatibility={compatibility}
        adapter={harnessAdapter}
        attention={attention}
        onExecute={dispatchOperation}
        routeRequest={inspectorRouteRequest}
        onCollapse={() => { if (layout.inspectorOpen) void dispatchOperation({ action: "layout.inspector.toggle", payload: {} }); setActiveSheet(null); }}
        onOpenAccountUsage={() => { void dispatchOperation({ action: "usage.account.open", payload: {} }); }}
      />}
      editorContent={<EditorPane
        onClose={() => { void dispatchOperation({ action: "layout.editor.close", payload: {} }); }}
        artifact={editorArtifact}
        draftContent={editorArtifact ? artifactDrafts[artifactDraftKey(editorArtifact)] : undefined}
        onDraftChange={editorArtifact ? (content) => {
          const key = artifactDraftKey(editorArtifact);
          setArtifactDrafts((current) => Object.freeze({ ...current, [key]: content }));
        } : undefined}
        onArtifactSave={rpc.saveEditorArtifact}
        onArtifactReload={(document) => rpc.reloadEditorArtifact(document.ref)}
        onArtifactSaveCopy={rpc.saveEditorArtifactCopy}
        onArtifactReloaded={(document) => {
          const key = artifactDraftKey(document);
          setEditorArtifact(document);
          setArtifactDrafts((current) => {
            const next = { ...current };
            delete next[key];
            return Object.freeze(next);
          });
        }}
        onArtifactSaved={(document) => {
          const key = artifactDraftKey(document);
          setEditorArtifact(document);
          setArtifactDrafts((current) => {
            const next = { ...current };
            delete next[key];
            return Object.freeze(next);
          });
        }}
        unsupportedReason="Open an identity-bound candidate from Harness Outputs, Sources, Activity, or a subagent file list."
        canvas={canvas?.chatId === navigation.selectedChatId ? canvas : null}
        onCanvasApply={canvas ? (content) => {
          const revision = canvas.displayRevision + 1;
          setDisplayRevisions((current) => Object.freeze({ ...current, [canvas.chatId]: Object.freeze({ ...(current[canvas.chatId] ?? {}), [canvas.messageId]: Object.freeze({ revision, content }) }) }));
          setCanvas({ ...canvas, displayRevision: revision, content });
        } : undefined}
      />}
    />
    <RuntimeStatusBar
      session={selectedSession}
      model={composerProjection?.selectedModel ?? undefined}
      thinking={composerProjection?.selectedThinking ?? undefined}
    />
    {paletteOpen && <CommandPalette admissionConnected={admissionConnected} onRun={runCommand} onClose={() => { void dispatchOperation({ action: "palette.close", payload: {} }); }} restoreFocusTo={paletteOpener} chats={paletteChats} messages={paletteMessages} onOpenChat={openCatalogChat} onOpenMessage={(chatId) => openCatalogChat(chatId)} />}
    {createProjectOpen && <CreateProjectDialog restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}
  </div>;
}

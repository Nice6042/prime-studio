import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import * as rpc from "../rpc";
import type { Account, AppSettings, LayoutPreferencesV1 } from "../types";
import { projectSubscriptionQuota } from "../quotaProjection";
import { rateLimitsSnapshot, subscribeRateLimits } from "../rateLimits";
import { reconcileCodexQuotaRefresh, type CodexQuotaState } from "../quotaRefresh";
import { RuntimeStatusBar } from "../features/shell/RuntimeStatusBar";
import { TitleBar } from "../features/shell/TitleBar";
import { WorkspaceShell } from "../features/shell/WorkspaceShell";
import { solveLayout } from "../features/shell/layoutSolver";
import { CollapsedSidebar } from "../features/navigation/CollapsedSidebar";
import { CreateProjectDialog, NavigationIcon, ProjectSidebar } from "../features/navigation/ProjectSidebar";
import { selectNavigationProjects } from "../features/navigation/navigationSelectors";
import { applyProjectCatalogCommand, branchResidentCatalogChat, createResidentForCatalogChat, loadProjectCatalog } from "../features/navigation/projectCatalogClient";
import { residentCreationDisabledReason } from "../features/navigation/residentCreationPolicy";
import { deriveWorkspaceIdentity } from "../features/navigation/workspaceIdentity";
import { ResidentBindingRecovery } from "../features/navigation/ResidentBindingRecovery";
import { ParentConversation } from "../features/conversation/ParentConversation";
import { controlBinding } from "../features/conversation/controlBinding";
import { Composer } from "../features/conversation/Composer";
import { WorkspaceHeader } from "../features/conversation/WorkspaceHeader";
import type { WorkspaceOperationState } from "../features/conversation/workspacePresentation";
import { composerSubmitAvailability, deriveComposerState, deriveSlashCommands, type SlashCommand } from "../features/conversation/composerModel";
import { projectConversationPresentations } from "../features/conversation/conversationDisplay";
import { routeSlashCommand } from "../features/conversation/conversationRouting";
import { HarnessInspector } from "../features/harness/HarnessInspector";
import { unavailableHarnessInspectorAdapter, type HarnessComposerProjection, type HarnessInspectorAdapter, type HarnessRuntimeStatusProjection } from "../features/harness/adapter";
import { SettingsShell } from "../features/settings/SettingsShell";
import { ArchivedCatalogSettings } from "../features/settings/ArchivedCatalogSettings";
import { CommandPalette } from "../features/command-palette/CommandPalette";
import type { PaletteChat, PaletteMessage } from "../features/command-palette/searchIndex";
import { commandPlacements, createStudioCommandExecutor, shortcutStudioCommand, studioCommand, type StudioCommandId } from "../entities/commands/commandRegistry";
import { EditorPane, type EditorMode } from "../features/editor/EditorPane";
import { artifactEditorDocumentId, canvasEditorDocumentId, createEditorBufferState, readEditorBuffer, removeEditorBuffer, writeEditorBuffer } from "../features/editor/editorBufferStore";
import { applyChatDisplayRevision, loadChatDisplayRevisions } from "../features/editor/chatDisplayClient";
import type { ArtifactDocument } from "../entities/editor/types";
import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { createStudioOperationDispatcher } from "../contracts/dispatcher/studioOperationDispatcher";
import { useStudioSelector, useStudioStore } from "./AppProviders";
import { installWorkspacePreferences } from "./workspacePreferences";
import { hasOpenStudioOverlay } from "../surfaceEscape";
import { chatAttentionEvidence, deriveUnreadChatIds } from "../attention/attentionLedger";
import { loadAttentionSnapshot, markAttentionSeen } from "../attention/attentionClient";
import { LayoutPersistenceCoordinator } from "./layoutPersistence";
import type { RootSessionProjection } from "../entities/harness/types";
import { Toasts } from "../components/Toasts";
import { ToastOperationCoordinator } from "../components/toastOperationCoordinator";
import type { StudioToast, ToastInput } from "../components/toastQueue";

let bootstrapPromise: ReturnType<typeof rpc.bootstrapHarness> | null = null;
let catalogPromise: ReturnType<typeof loadProjectCatalog> | null = null;

function titleActionPresentation(commandId: StudioCommandId) {
  const placement = commandPlacements("title-action").find((candidate) => candidate.commandId === commandId);
  if (!placement) throw new Error(`Missing title action placement for ${commandId}.`);
  const command = studioCommand(commandId);
  return { id: placement.id, label: placement.label ?? command.label, action: command.action };
}

const titleActions = {
  projects: titleActionPresentation("sidebar.toggle"),
  harness: titleActionPresentation("inspector.toggle"),
  editorOpen: titleActionPresentation("editor.open"),
  editorClose: titleActionPresentation("editor.close"),
  palette: titleActionPresentation("palette.open"),
};

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

function ownsArtifactRevision(
  document: ArtifactDocument | null,
  documentId: string,
  ref: ArtifactDocument["ref"],
  expectedRevision: number,
  expectedIdentity: string,
): document is ArtifactDocument {
  return Boolean(
    document
    && artifactEditorDocumentId(document) === documentId
    && ref.revision === expectedRevision
    && document.ref.brokerId === ref.brokerId
    && document.ref.rootSessionId === ref.rootSessionId
    && document.ref.artifactId === ref.artifactId
    && document.ref.revision === expectedRevision
    && document.identity === expectedIdentity,
  );
}

export function StudioApp({ harnessAdapter = unavailableHarnessInspectorAdapter }: { readonly harnessAdapter?: HarnessInspectorAdapter } = {}) {
  const store = useStudioStore();
  const navigation = useStudioSelector((state) => state.navigation);
  const projectCatalog = useStudioSelector((state) => state.projectCatalog);
  const catalogRevision = useStudioSelector((state) => state.catalogRevision);
  const selectedChat = useStudioSelector((state) => navigation.selectedChatId ? state.chats[navigation.selectedChatId] : null);
  const sessions = useStudioSelector((state) => state.sessions);
  const selectedCatalogChat = navigation.selectedChatId
    ? projectCatalog.projects.flatMap((project) => project.chats).find((chat) => chat.id === navigation.selectedChatId && !chat.archived) ?? null
    : null;
  const selectedSession = selectedCatalogChat?.binding ? sessions[selectedCatalogChat.binding.sessionId] ?? null : null;
  const selectedChatEvidence = selectedSession ? chatAttentionEvidence(selectedSession) : null;
  const compatibility = useStudioSelector((state) => state.compatibility);
  const runtime = useStudioSelector((state) => state.runtime);
  const drafts = useStudioSelector((state) => state.drafts);
  const attachments = useStudioSelector((state) => state.attachments);
  const conversationDisplay = useStudioSelector((state) => state.conversationDisplay);
  const displayRevisions = useStudioSelector((state) => state.canvasRevisions);
  const conversationHistory = useStudioSelector((state) => state.conversationHistory);
  const attention = useStudioSelector((state) => state.attention);
  const viewport = useViewportWidth();
  const initialExpandedProjectIds = projectCatalog.projects.filter((project) => !project.archived).map((project) => project.id);
  const [layout, setLayout] = useState<LayoutPreferencesV1>({
    schemaVersion: 1,
    sidebarOpen: true,
    sidebarWidth: 264,
    inspectorOpen: true,
    inspectorWidth: 384,
    editorOpen: false,
    editorWidth: 400,
    expandedProjectIds: initialExpandedProjectIds,
  });
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<AppSettings>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [codexQuota, setCodexQuota] = useState<CodexQuotaState>({ status: "loading", snapshot: null });
  const codexQuotaRef = useRef(codexQuota);
  codexQuotaRef.current = codexQuota;
  const quotaRefreshGeneration = useRef(0);
  const [, setRateLimitRevision] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceMenuHost, setWorkspaceMenuHost] = useState<"pane" | "rail" | "sheet" | null>(null);
  const workspaceMenuHostRef = useRef(workspaceMenuHost);
  workspaceMenuHostRef.current = workspaceMenuHost;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectOpener, setCreateProjectOpener] = useState<HTMLElement | null>(null);
  const [paletteOpener, setPaletteOpener] = useState<HTMLElement | null>(null);
  const [activeSheet, setActiveSheet] = useState<"sidebar" | "inspector" | "editor" | null>(null);
  const sheetOpener = useRef<HTMLElement | null>(null);
  const suppressSheetOpenerRestore = useRef(false);
  const sidebarReplacementFocus = useRef<"rail.sidebar.toggle" | "sidebar.collapse" | null>(null);
  const sidebarHadFocus = useRef(false);
  const previousSidebarHost = useRef<"pane" | "rail" | "sheet" | null>(null);
  const [canvas, setCanvas] = useState<Readonly<{ sessionId: string; chatId: string; messageId: string; sourceVersion: number; displayRevision: number; authorityRevision: number; sourceContent: string; content: string }> | null>(null);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const [editorArtifact, setEditorArtifact] = useState<ArtifactDocument | null>(null);
  const [editorAdmissionRevision, setEditorAdmissionRevision] = useState(0);
  const editorArtifactRef = useRef(editorArtifact);
  editorArtifactRef.current = editorArtifact;
  const artifactOpenGeneration = useRef(0);
  const editorOpenAdmission = useRef(0);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [editorBuffers, setEditorBuffers] = useState(createEditorBufferState);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const [inspectorRouteRequest, setInspectorRouteRequest] = useState<Readonly<{ id: number; route: "overview" | "usage" | "activity" }> | undefined>();
  const [admissionPhase, setAdmissionPhase] = useState<"idle" | "submitting" | "aborting">("idle");
  const [admissionMessage, setAdmissionMessage] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(initialExpandedProjectIds),
  );
  const layoutCoordinator = useRef<LayoutPersistenceCoordinator | null>(null);
  if (layoutCoordinator.current === null) {
    layoutCoordinator.current = new LayoutPersistenceCoordinator(layout, rpc.setLayoutPreferences, (next) => {
      setLayout(next);
      setExpandedProjectIds(new Set(next.expandedProjectIds));
    });
  }
  const [catalogOperation, setCatalogOperation] = useState<WorkspaceOperationState>({ phase: "idle" });
  const [toasts, setToasts] = useState<readonly StudioToast[]>([]);
  const toastCoordinator = useRef<ToastOperationCoordinator | null>(null);
  const [loadedComposer, setLoadedComposer] = useState<Readonly<{ sessionId: string; cursor: RootSessionProjection["cursor"]; projection: HarnessComposerProjection }> | null>(null);
  const [composerUnavailableReason, setComposerUnavailableReason] = useState<string | null>(null);
  const [runtimeInspector, setRuntimeInspector] = useState<HarnessRuntimeStatusProjection | null>(null);
  const [residentBindingFailure, setResidentBindingFailure] = useState<Readonly<{ projectId: string; chatId: string; reason: string }> | null>(null);
  const workerRecoveryAttempts = useRef<Set<string>>(new Set());
  const draftRevisions = useRef<Map<string, number>>(new Map());
  const sessionAdmissions = useRef<WeakMap<object, Readonly<{ chatId: string; draftRevision: number }>>>(new WeakMap());

  const adapterConnected = harnessAdapter.availability.status === "available";
  const hasCapability = (capability: string) => compatibility.status !== "unavailable" && compatibility.status !== "read_only" && compatibility.capabilities.includes(capability as typeof compatibility.capabilities[number]);

  const projects = useMemo(() => selectNavigationProjects(projectCatalog, {
    expandedProjectIds,
    activityMs: {},
    unreadChatIds: deriveUnreadChatIds(projectCatalog, sessions, navigation.selectedChatId, attention),
    sessions,
    query,
  }), [attention, expandedProjectIds, navigation.selectedChatId, projectCatalog, query, sessions]);
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
    const rememberSidebarFocus = (event: FocusEvent) => {
      const target = event.target;
      sidebarHadFocus.current = target instanceof HTMLElement
        && Boolean(target.closest('.studio-sidebar, [data-studio-sheet="sidebar"]'));
    };
    document.addEventListener("focusin", rememberSidebarFocus, true);
    return () => document.removeEventListener("focusin", rememberSidebarFocus, true);
  }, []);

  useEffect(() => {
    let active = true;
    void rpc.getLayoutPreferences().then((preferences) => {
      if (active) {
        layoutCoordinator.current?.adoptInitial(preferences);
      }
    }).catch(() => {
      if (!active) return;
      layoutCoordinator.current?.failInitial();
      toastCoordinator.current?.notify({
        owner: "studio_durable",
        scope: "loading.layout-preferences",
        severity: "error",
        title: "Studio loading failed",
        message: "Layout preferences could not be loaded. Layout changes will stay local until the app is restarted.",
      });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const notify = (input: ToastInput) => toastCoordinator.current?.notify(input);
    const offStderr = rpc.onStderr((message) => notify({
      owner: "runtime",
      scope: `runtime.stderr:${message.slice(0, 120)}`,
      severity: "warning",
      title: "Prime runtime notice",
      message: message.slice(0, 300),
    }));
    return offStderr;
  }, []);

  useEffect(() => {
    let active = true;
    const quotaGeneration = ++quotaRefreshGeneration.current;
    const previousQuota = codexQuotaRef.current;
    void rpc.getAppSettings().then((next) => { if (active) { setSettings(next); setSettingsLoaded(true); setSettingsLoadFailed(false); } }).catch(() => { if (active) setSettingsLoadFailed(true); });
    void rpc.listAccounts().then((next) => { if (active) setAccounts(next); });
    void rpc.codexSubscriptionUsageStrict()
      .then((snapshot) => {
        if (!active) return;
        const settlement = reconcileCodexQuotaRefresh(quotaGeneration, quotaRefreshGeneration.current, previousQuota, { status: "success", snapshot });
        if (settlement) { codexQuotaRef.current = settlement.state; setCodexQuota(settlement.state); }
      })
      .catch(() => {
        if (!active) return;
        const settlement = reconcileCodexQuotaRefresh(quotaGeneration, quotaRefreshGeneration.current, previousQuota, { status: "failure" });
        if (settlement) { codexQuotaRef.current = settlement.state; setCodexQuota(settlement.state); }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => subscribeRateLimits(() => setRateLimitRevision((revision) => revision + 1)), []);

  const quotaProjection = projectSubscriptionQuota(
    accounts,
    codexQuota.snapshot,
    rateLimitsSnapshot(),
    codexQuota.status === "unavailable" ? "codex_refresh_failed" : "codex_snapshot_missing",
  );

  const refreshQuota = async () => {
    const generation = ++quotaRefreshGeneration.current;
    const previous = codexQuotaRef.current;
    try {
      const snapshot = await rpc.codexSubscriptionUsageStrict();
      const settlement = reconcileCodexQuotaRefresh(generation, quotaRefreshGeneration.current, previous, { status: "success", snapshot });
      if (!settlement) return { status: "preserved" as const };
      codexQuotaRef.current = settlement.state;
      setCodexQuota(settlement.state);
      return settlement.response;
    } catch {
      const settlement = reconcileCodexQuotaRefresh(generation, quotaRefreshGeneration.current, previous, { status: "failure" });
      if (!settlement) return { status: "preserved" as const };
      codexQuotaRef.current = settlement.state;
      setCodexQuota(settlement.state);
      return settlement.response;
    }
  };

  useEffect(
    () => installWorkspacePreferences(settings),
    [settings.theme, settings.density, settings.reducedMotion, settings.accent, settings.fontSize, settings.bubbles],
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
    const recovery = harnessAdapter.workerRecovery;
    if (!settingsLoaded || settings.retrySilentWorkers === "disabled" || recovery?.status !== "available") return;
    for (const session of Object.values(sessions)) {
      const observationId = session.workerRecovery.observationId;
      if (
        session.freshness !== "live"
        || session.state !== "failed"
        || session.workerRecovery.status !== "retryable_failure"
        || session.workerRecovery.automaticRetryCount !== 0
        || !observationId
        || workerRecoveryAttempts.current.has(observationId)
      ) continue;
      workerRecoveryAttempts.current.add(observationId);
      void recovery.retry(session.sessionId, observationId).catch(() => {
        // The observation remains latched. An IPC failure is an uncertain
        // outcome and must never be converted into another mutation attempt.
      });
    }
  }, [harnessAdapter, sessions, settings.retrySilentWorkers, settingsLoaded]);

  useEffect(() => {
    let active = true;
    if (!selectedSession || !adapterConnected || !hasCapability("model_catalog")) {
      setLoadedComposer(null);
      setComposerUnavailableReason(null);
      return () => { active = false; };
    }
    if (!harnessAdapter.loadComposer) {
      setLoadedComposer(null);
      setComposerUnavailableReason(harnessAdapter.composer ? null : "The verified Harness adapter does not expose session composer configuration.");
      return () => { active = false; };
    }
    setComposerUnavailableReason(null);
    const requestedSession = selectedSession;
    void harnessAdapter.loadComposer(requestedSession.sessionId).then((projection) => {
      if (active) setLoadedComposer({ sessionId: requestedSession.sessionId, cursor: requestedSession.cursor, projection });
    }).catch((error) => {
      if (!active) return;
      setLoadedComposer(null);
      setComposerUnavailableReason(error instanceof Error ? error.message : "Verified composer configuration is unavailable.");
    });
    return () => { active = false; };
  }, [adapterConnected, compatibility, harnessAdapter, selectedSession?.cursor.runtimeGeneration, selectedSession?.cursor.sequence, selectedSession?.sessionId]);

  useEffect(() => {
    setRuntimeInspector(null);
  }, [adapterConnected, compatibility.status, selectedSession?.sessionId, selectedSession?.cursor.runtimeGeneration, selectedSession?.cursor.sequence]);

  useEffect(() => {
    setAdmissionPhase("idle");
    setAdmissionMessage("");
    artifactOpenGeneration.current += 1;
    editorArtifactRef.current = null;
    setEditorArtifact(null);
    setEditorMode("edit");
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
      window.requestAnimationFrame(() => {
        if (suppressSheetOpenerRestore.current) {
          suppressSheetOpenerRestore.current = false;
          return;
        }
        opener?.focus();
      });
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
    if (catalogRevision === null) return () => { active = false; };
    void loadChatDisplayRevisions().then((snapshot) => {
      if (active) store.dispatch({ type: "conversation/canvas-loaded", records: snapshot.records });
    }).catch(() => {
      // Native display authority is fail-closed. The transcript remains the
      // visible source until a bounded, catalog-validated snapshot can load.
    });
    return () => { active = false; };
  }, [catalogRevision, store]);

  useEffect(() => {
    let active = true;
    void loadAttentionSnapshot().then((snapshot) => {
      if (active) store.dispatch({ type: "attention/loaded", snapshot });
    }).catch((error) => {
      if (active) store.dispatch({ type: "attention/unavailable", reason: error instanceof Error ? error.message : "Attention ledger unavailable." });
    });
    return () => { active = false; };
  }, [store]);

  const changeLayout = async (change: Partial<LayoutPreferencesV1> | ((current: LayoutPreferencesV1) => LayoutPreferencesV1)): Promise<StudioOperationOutcome> => {
    const result = await layoutCoordinator.current!.update((current) => typeof change === "function" ? change(current) : { ...current, ...change });
    return result.status === "updated"
      ? { status: "updated", revision: JSON.stringify(result.value) }
      : { status: "rejected", reason: result.reason, retryable: true };
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
    setCatalogOperation({ phase: "pending", label: "Creating chat" });
    let created;
    try {
      created = await applyProjectCatalogCommand(revision, { type: "chat.create", projectId, chatId, title: "New chat" });
      store.dispatch({ type: "project-catalog/loaded", snapshot: created });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The chat could not be created.";
      setCatalogOperation({ phase: "error", message: reason });
      return { status: "rejected", reason, retryable: true };
    }
    setCatalogOperation({ phase: "pending", label: "Binding verified resident session" });
    try {
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
      setResidentBindingFailure(null);
      setCatalogOperation({ phase: "success", message: "Resident chat ready." });
      return { status: "updated", revision: bound.catalog.revision };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The verified Harness session is unavailable.";
      const reason = `The chat was preserved, but resident binding failed: ${detail}`;
      setResidentBindingFailure({ projectId, chatId, reason });
      setCatalogOperation({ phase: "error", message: reason });
      return { status: "rejected", reason, retryable: true };
    }
  };

  const retryResidentBinding = async () => {
    if (!residentBindingFailure) return;
    const revision = store.getSnapshot().catalogRevision;
    if (revision === null) return;
    setCatalogOperation({ phase: "pending", label: "Retrying resident binding" });
    try {
      const bound = await createResidentForCatalogChat(revision, residentBindingFailure.projectId, residentBindingFailure.chatId);
      store.dispatch({ type: "project-catalog/loaded", snapshot: bound.catalog });
      store.dispatch({ type: "harness/session-projected", session: bound.session });
      setResidentBindingFailure(null);
      setCatalogOperation({ phase: "success", message: "Resident chat ready." });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The verified Harness session is unavailable.";
      const reason = `Resident binding retry failed: ${detail}`;
      setResidentBindingFailure({ ...residentBindingFailure, reason });
      setCatalogOperation({ phase: "error", message: reason });
    }
  };

  const rollbackUnboundChat = async () => {
    if (!residentBindingFailure) return;
    const outcome = await applyCatalog({ type: "chat.delete", projectId: residentBindingFailure.projectId, chatId: residentBindingFailure.chatId }, "Removing unbound chat");
    if (operationAccepted(outcome.status)) setResidentBindingFailure(null);
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
      case "editor.canvas.apply": {
        const { documentId, chatId, messageId, expectedRevision, content } = operation.payload;
        const activeCanvas = canvasRef.current;
        const activeVersionState = store.getSnapshot().conversationDisplay[chatId]?.messages[messageId];
        const activeSourceVersion = activeVersionState?.kind === "assistant" ? activeVersionState.selected : 0;
        const requestedIdentityOwned = Boolean(
          activeCanvas
          && activeCanvas.chatId === chatId
          && activeCanvas.messageId === messageId
          && activeCanvas.sourceVersion === activeSourceVersion
          && documentId === canvasEditorDocumentId({ ...activeCanvas, displayRevision: expectedRevision })
        );
        const current = store.getSnapshot().canvasRevisions[chatId]?.[messageId];
        const activeCurrent = current?.sourceContent === activeCanvas?.sourceContent ? current : undefined;
        const currentRevision = activeCurrent?.revision ?? (activeCanvas?.chatId === chatId && activeCanvas.messageId === messageId ? activeCanvas.displayRevision : 1);
        const currentContent = activeCurrent?.content ?? (activeCanvas?.chatId === chatId && activeCanvas.messageId === messageId ? activeCanvas.content : null);
        if (currentRevision === expectedRevision + 1 && currentContent === content) {
          if (!requestedIdentityOwned) return { status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false };
          setEditorBuffers((currentBuffers) => removeEditorBuffer(currentBuffers, documentId));
          return { status: "updated", revision: currentRevision };
        }
        if (
          !requestedIdentityOwned
          || navigationRef.current.selectedChatId !== chatId
          || !activeCanvas
          || activeCanvas.chatId !== chatId
          || activeCanvas.messageId !== messageId
          || activeCanvas.displayRevision !== expectedRevision
          || currentRevision !== expectedRevision
        ) return { status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false };
        let nativeRecord;
        try {
          nativeRecord = await applyChatDisplayRevision({ chatId, messageId, expectedRevision: activeCanvas.authorityRevision, sourceContent: activeCanvas.sourceContent, content });
        } catch {
          return { status: "rejected", reason: "The Canvas display revision could not be durably confirmed.", retryable: false };
        }
        const beforeAdopt = store.getSnapshot().canvasRevisions[chatId]?.[messageId];
        if ((beforeAdopt?.revision ?? 1) !== activeCanvas.authorityRevision) {
          return { status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false };
        }
        store.dispatch({ type: "conversation/canvas-applied", chatId: nativeRecord.chatId, messageId: nativeRecord.messageId, expectedRevision: activeCanvas.authorityRevision, sourceContent: nativeRecord.sourceContent, content: nativeRecord.content });
        const committed = store.getSnapshot().canvasRevisions[chatId]?.[messageId];
        if (!committed || committed.revision !== nativeRecord.revision || committed.content !== nativeRecord.content) {
          return { status: "rejected", reason: "The Canvas display revision changed before Apply completed.", retryable: false };
        }
        const revision = committed.revision;
        const currentCanvas = canvasRef.current;
        if (navigationRef.current.selectedChatId === chatId && currentCanvas?.chatId === chatId && currentCanvas.messageId === messageId && currentCanvas.displayRevision === expectedRevision) {
          const nextCanvas = Object.freeze({ ...currentCanvas, displayRevision: revision, authorityRevision: revision, content: nativeRecord.content });
          canvasRef.current = nextCanvas;
          setCanvas(nextCanvas);
        }
        setEditorBuffers((currentBuffers) => removeEditorBuffer(currentBuffers, documentId));
        return { status: "updated", revision };
      }
      case "workspace.switch":
        return { status: "unavailable", reason: "Workspace switching is unavailable because no workspace catalog authority is configured." };
      case "workspace.sign-out":
        return { status: "unavailable", reason: "Workspace sign-out is unavailable because configured folders do not own an authenticated session." };
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
      case "layout.sidebar.toggle": {
        if (activeSheet === "sidebar" && solvedSidebarMode === "rail") {
          setActiveSheet(null);
          break;
        }
        const expandedMode = solveLayout({
          viewport,
          sidebar: { open: true, preferred: layout.sidebarWidth },
          inspector: { open: layout.inspectorOpen, preferred: layout.inspectorWidth },
          editor: { open: layout.editorOpen, preferred: layout.editorWidth },
        }).sidebar.mode;
        if (expandedMode === "rail") {
          sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setActiveSheet("sidebar");
          return layout.sidebarOpen
            ? { status: "updated", revision: JSON.stringify(layout) }
            : changeLayout({ sidebarOpen: true });
        }
        sidebarReplacementFocus.current = layout.sidebarOpen ? "rail.sidebar.toggle" : "sidebar.collapse";
        return changeLayout({ sidebarOpen: !layout.sidebarOpen });
      }
      case "layout.sidebar.resize": return changeLayout({ sidebarWidth: operation.payload.width });
      case "layout.sidebar.reset": return changeLayout({ sidebarWidth: 264 });
      case "layout.inspector.toggle": {
        if (viewport < 760) {
          if (activeSheet === "inspector") setActiveSheet(null);
          else {
            sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setActiveSheet("inspector");
          }
          return layout.inspectorOpen
            ? { status: "updated", revision: JSON.stringify(layout) }
            : changeLayout({ inspectorOpen: true });
        }
        return changeLayout((current) => ({ ...current, inspectorOpen: !current.inspectorOpen }));
      }
      case "layout.inspector.resize": return changeLayout({ inspectorWidth: operation.payload.width });
      case "layout.inspector.reset": return changeLayout({ inspectorWidth: 384 });
      case "layout.editor.toggle": return changeLayout((current) => ({ ...current, editorOpen: !current.editorOpen }));
      case "layout.editor.resize": return changeLayout({ editorWidth: operation.payload.width });
      case "layout.editor.close": setActiveSheet(null); return changeLayout({ editorOpen: false });
      case "layout.panels.reset":
        setActiveSheet(null);
        return changeLayout((current) => ({ ...current, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400 }));
      case "route.settings.open": setWorkspaceMenuHost(null); store.dispatch({ type: "route/settings", section: operation.payload.section }); break;
      case "route.archived.open": store.dispatch({ type: "route/settings", section: "archived" }); break;
      case "route.settings.back":
      case "route.workspace.open": store.dispatch({ type: "route/workspace" }); break;
      case "usage.account.open": store.dispatch({ type: "route/settings", section: "usage" }); break;
      case "palette.open": openPalette(); break;
      case "palette.close": setPaletteOpen(false); break;
      case "surface.popover.toggle":
        if (operation.payload.popoverId === "create-project") { setWorkspaceMenuHost(null); openCreateProject(); }
        else if (operation.payload.popoverId === "workspace-footer-expanded" && (workspaceFooterHost === "pane" || workspaceFooterHost === "sheet")) { setCreateProjectOpen(false); setWorkspaceMenuHost(workspaceFooterHost); }
        else if (operation.payload.popoverId === "workspace-footer-rail" && workspaceFooterHost === "rail") { setCreateProjectOpen(false); setWorkspaceMenuHost("rail"); }
        else if (operation.payload.popoverId === null) { setCreateProjectOpen(false); setWorkspaceMenuHost(null); }
        else return { status: "unavailable", reason: `Popover ${operation.payload.popoverId} is unavailable.` };
        break;
      case "catalog.project.toggle": {
        return changeLayout((current) => {
          const next = new Set(current.expandedProjectIds);
          if (next.has(operation.payload.projectId)) next.delete(operation.payload.projectId); else next.add(operation.payload.projectId);
          return { ...current, expandedProjectIds: [...next].sort() };
        });
      }
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
      case "editor.content.change":
      case "settings.search.change":
      case "settings.section.select":
      case "usage.account.range-select":
      case "usage.account.series-toggle":
      case "surface.accordion.toggle":
      case "overlay.topmost.close":
      case "toast.dismiss": break;
      case "conversation.canvas.open": {
        const { chatId, messageId, expectedRevision, content } = operation.payload;
        const admittedSessionId = selectedSessionRef.current?.sessionId;
        const admittedVersionState = store.getSnapshot().conversationDisplay[chatId]?.messages[messageId];
        const admittedSourceVersion = admittedVersionState?.kind === "assistant" ? admittedVersionState.selected : 0;
        if (!admittedSessionId) return { status: "rejected", reason: "The selected response has no authoritative root session.", retryable: false };
        const stillExact = () => {
          if (navigationRef.current.selectedChatId !== chatId || selectedSessionRef.current?.sessionId !== admittedSessionId) return false;
          const message = selectedSessionRef.current?.parentMessages.find((candidate) => candidate.kind === "assistant" && candidate.id === messageId);
          if (!message || message.kind !== "assistant" || message.streaming) return false;
          const snapshot = store.getSnapshot();
          const displayed = snapshot.canvasRevisions[chatId]?.[messageId];
          const source = message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n");
          const versionState = snapshot.conversationDisplay[chatId]?.messages[messageId];
          if ((versionState?.kind === "assistant" ? versionState.selected : 0) !== admittedSourceVersion) return false;
          const selectedVersion = versionState?.kind === "assistant" ? versionState.versions[versionState.selected]?.text : null;
          const selectedContent = selectedVersion ?? source;
          const activeDisplay = displayed?.sourceContent === selectedContent ? displayed : undefined;
          return (activeDisplay?.revision ?? 1) === expectedRevision && (activeDisplay?.content ?? selectedContent) === content;
        };
        if (!stillExact()) return { status: "rejected", reason: "The selected response changed before Canvas could open.", retryable: false };
        const admittedOpen = ++editorOpenAdmission.current;
        const editorWasOpen = layoutCoordinator.current!.snapshot().editorOpen;
        if (!editorWasOpen) {
          const opened = await changeLayout({ editorOpen: true });
          if (opened.status !== "updated") return opened;
        }
        if (editorOpenAdmission.current !== admittedOpen || !stillExact()) {
          if (!editorWasOpen && editorOpenAdmission.current === admittedOpen) await changeLayout({ editorOpen: false });
          return { status: "rejected", reason: "The selected response changed before Canvas could open.", retryable: false };
        }
        editorArtifactRef.current = null;
        setEditorArtifact(null);
        setEditorMode("edit");
        const snapshot = store.getSnapshot();
        const displayed = snapshot.canvasRevisions[chatId]?.[messageId];
        const message = selectedSessionRef.current?.parentMessages.find((candidate) => candidate.kind === "assistant" && candidate.id === messageId);
        const source = message?.kind === "assistant" ? message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n") : content;
        const versionState = snapshot.conversationDisplay[chatId]?.messages[messageId];
        const selectedVersion = versionState?.kind === "assistant" ? versionState.versions[versionState.selected]?.text : null;
        const selectedContent = selectedVersion ?? source;
        const activeDisplay = displayed?.sourceContent === selectedContent ? displayed : undefined;
        const nextCanvas = Object.freeze({ sessionId: admittedSessionId, chatId, messageId, sourceVersion: admittedSourceVersion, displayRevision: expectedRevision, authorityRevision: displayed?.revision ?? 1, sourceContent: activeDisplay?.sourceContent ?? selectedContent, content });
        canvasRef.current = nextCanvas;
        setCanvas(nextCanvas);
        setActiveSheet("editor");
        return { status: "updated", revision: expectedRevision };
      }
      case "editor.mode.select": {
        const visibleArtifact = editorArtifact?.ref.rootSessionId === selectedSession?.sessionId ? editorArtifact : null;
        const canvasVersionState = canvas ? conversationDisplay[canvas.chatId]?.messages[canvas.messageId] : undefined;
        const selectedCanvasSourceVersion = canvasVersionState?.kind === "assistant" ? canvasVersionState.selected : 0;
        const visibleCanvas = canvas?.chatId === navigation.selectedChatId
          && canvas.sessionId === selectedSession?.sessionId
          && canvas.sourceVersion === selectedCanvasSourceVersion
          ? canvas
          : null;
        const activeDocumentId = visibleArtifact
          ? artifactEditorDocumentId(visibleArtifact)
          : visibleCanvas ? canvasEditorDocumentId(visibleCanvas) : null;
        if (activeDocumentId === null) return { status: "unavailable", reason: "No identity-bound editor document is selected." };
        if (operation.payload.documentId !== activeDocumentId) {
          return { status: "rejected", reason: "The editor document changed before its mode could be selected.", retryable: false };
        }
        if (operation.payload.mode === "diff" && !visibleArtifact) {
          return { status: "rejected", reason: "Diff mode requires an admitted artifact revision.", retryable: false };
        }
        setEditorMode(operation.payload.mode);
        return { status: "updated", revision: activeDocumentId };
      }
      case "conversation.suggestion.fill":
      case "composer.draft.change": {
        const current = store.getSnapshot().drafts[operation.payload.chatId] ?? "";
        if (current !== operation.payload.text) {
          draftRevisions.current.set(operation.payload.chatId, (draftRevisions.current.get(operation.payload.chatId) ?? 0) + 1);
        }
        store.dispatch({ type: "draft/change", chatId: operation.payload.chatId, draft: operation.payload.text });
        break;
      }
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
      case "route.external-docs.open": {
        if (operation.payload.document === "licenses") {
          await rpc.openPackagedLicenseNotices();
        } else {
          const documents = {
            "prime-agent": "https://www.npmjs.com/package/prime-agent",
            support: "https://github.com/Nice6042/prime-studio/blob/main/SUPPORT.md",
          } as const;
          await rpc.openExternalStrict(documents[operation.payload.document]);
        }
        break;
      }
      case "settings.default-workspace.pick": {
        const directory = await rpc.pickDirectory();
        if (!directory) return { status: "cancelled", commandId: null };
        return { status: "updated", revision: directory };
      }
      case "conversation.response.copy": await navigator.clipboard.writeText(operation.payload.text); break;
      case "activity.command.copy": await navigator.clipboard.writeText(operation.payload.command); break;
      case "editor.file.save": {
        const { documentId, ref, expectedRevision, expectedIdentity, content } = operation.payload;
        const active = editorArtifactRef.current;
        if (!ownsArtifactRevision(active, documentId, ref, expectedRevision, expectedIdentity)) return { status: "rejected", reason: "The artifact identity changed before Save started.", retryable: false };
        const result = await rpc.saveEditorArtifact({ ref, expectedRevision, expectedIdentity, content });
        const latest = editorArtifactRef.current;
        if (!ownsArtifactRevision(latest, documentId, ref, expectedRevision, expectedIdentity)) return { status: "rejected", reason: "The artifact identity changed before Save completed.", retryable: false };
        if (result.kind !== "saved") return result.kind === "unsupported"
          ? { status: "unavailable", reason: result.message }
          : { status: "rejected", reason: result.message, retryable: result.kind === "conflict" || result.kind === "error" };
        const savedDocument = Object.freeze({ ...latest, ref: Object.freeze({ ...latest.ref, revision: result.revision }), identity: result.identity, content });
        editorArtifactRef.current = savedDocument;
        setEditorArtifact(savedDocument);
        setEditorAdmissionRevision((revision) => revision + 1);
        setEditorBuffers((current) => removeEditorBuffer(current, artifactEditorDocumentId(latest)));
        return { status: "updated", revision: result.revision, identity: result.identity };
      }
      case "editor.conflict.reload": {
        const { documentId, ref, expectedRevision, expectedIdentity } = operation.payload;
        const active = editorArtifactRef.current;
        if (!ownsArtifactRevision(active, documentId, ref, expectedRevision, expectedIdentity)) {
          return { status: "rejected", reason: "The artifact identity changed before Reload started.", retryable: false };
        }
        const result = await rpc.reloadEditorArtifact(ref);
        if (result.kind === "unsupported") return { status: "unavailable", reason: result.reason };
        const latest = editorArtifactRef.current;
        if (!ownsArtifactRevision(latest, documentId, ref, expectedRevision, expectedIdentity)) return { status: "rejected", reason: "The artifact identity changed before Reload completed.", retryable: false };
        if (result.document.ref.brokerId !== ref.brokerId || result.document.ref.rootSessionId !== ref.rootSessionId || result.document.ref.artifactId !== ref.artifactId) {
          return { status: "rejected", reason: "Native Reload returned a different artifact identity.", retryable: false };
        }
        editorArtifactRef.current = result.document;
        setEditorArtifact(result.document);
        setEditorAdmissionRevision((revision) => revision + 1);
        setEditorBuffers((current) => removeEditorBuffer(current, artifactEditorDocumentId(latest)));
        return { status: "updated", revision: result.document.ref.revision, identity: result.document.identity };
      }
      case "editor.conflict.save-copy": {
        const { documentId, ref, expectedRevision, expectedIdentity, content } = operation.payload;
        const active = editorArtifactRef.current;
        if (!ownsArtifactRevision(active, documentId, ref, expectedRevision, expectedIdentity)) {
          return { status: "rejected", reason: "The artifact identity changed before Save-copy started.", retryable: false };
        }
        let result: Awaited<ReturnType<typeof rpc.saveEditorArtifactCopy>>;
        try {
          result = await rpc.saveEditorArtifactCopy({ ref, content });
        } catch {
          return { status: "rejected", reason: "The Save-copy outcome could not be verified, so it will not be retried automatically.", retryable: false };
        }
        if (!ownsArtifactRevision(editorArtifactRef.current, documentId, ref, expectedRevision, expectedIdentity)) {
          return { status: "rejected", reason: "The artifact identity changed before Save-copy completed.", retryable: false };
        }
        if (result.kind === "saved_copy") return { status: "updated", revision: result.label };
        if (result.kind === "cancelled") return { status: "cancelled", commandId: null };
        return result.kind === "unsupported" ? { status: "unavailable", reason: result.message } : { status: "rejected", reason: result.message, retryable: true };
      }
      case "history.undo": if (!document.execCommand("undo")) return { status: "rejected", reason: "Undo is unavailable in the active surface.", retryable: false }; break;
      case "history.redo": if (!document.execCommand("redo")) return { status: "rejected", reason: "Redo is unavailable in the active surface.", retryable: false }; break;
      default: return { status: "unavailable", reason: `${operation.action} has no registered native implementation.` };
    }
    return { status: "updated", revision: Date.now() };
  };

  const branchResidentChat = async (
    sessionId: string,
    messageId: string,
    sourceChatId: string | null = null,
    allowArchivedSource = false,
  ): Promise<StudioOperationOutcome> => {
    const current = store.getSnapshot();
    const revision = current.catalogRevision;
    if (revision === null) return { status: "unavailable", reason: "Branching failed because the project catalog is unavailable." };
    const sourceSession = current.sessions[sessionId];
    const requestedChatId = sourceChatId ?? current.navigation.selectedChatId;
    const matches = current.projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({ project, chat }))).filter(({ chat }) => (
      chat.archived === allowArchivedSource
      && chat.binding?.sessionId === sessionId
      && chat.id === requestedChatId
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

  const forkArchivedChat = async (chatId: string): Promise<void> => {
    const current = store.getSnapshot();
    const matches = current.projectCatalog.projects
      .filter((project) => !project.archived)
      .flatMap((project) => project.chats.map((chat) => ({ project, chat })))
      .filter(({ chat }) => chat.id === chatId && chat.archived);
    const source = matches.length === 1 ? matches[0] : null;
    const binding = source?.chat.binding ?? null;
    const session = binding ? current.sessions[binding.sessionId] ?? null : null;
    const message = session?.parentMessages[session.parentMessages.length - 1] ?? null;
    if (
      !source
      || !binding
      || !session
      || binding.accountId !== session.accountId
      || (binding.agentId !== null && binding.agentId !== session.chatId)
      || !message
    ) {
      setCatalogOperation({ phase: "error", message: "The archived chat has no authoritative resident message to branch." });
      return;
    }
    const outcome = await branchResidentChat(session.sessionId, message.id, chatId, true);
    if (operationAccepted(outcome.status)) store.dispatch({ type: "route/workspace" });
  };

  const harnessExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {
    if (operation.action === "conversation.branch.create") return branchResidentChat(operation.payload.sessionId, operation.payload.messageId);
    if (operation.action === "editor.artifact.open" || operation.action === "activity.file.open" || operation.action === "harness.context-source.open") {
      if (harnessAdapter.availability.status !== "available") return { status: "unavailable", reason: harnessAdapter.availability.reason };
      if (!harnessAdapter.openArtifact) return { status: "unavailable", reason: "The native identity-bound artifact resolver is unavailable." };
      const sessionId = operation.payload.sessionId;
      const candidateId = operation.action === "editor.artifact.open" ? operation.payload.artifactId : operation.action === "activity.file.open" ? operation.payload.fileId : operation.payload.sourceId;
      const admittedChatId = navigationRef.current.selectedChatId;
      const admittedGeneration = ++artifactOpenGeneration.current;
      const admittedOpen = ++editorOpenAdmission.current;
      if (!admittedChatId || selectedSessionRef.current?.sessionId !== sessionId) return { status: "rejected", reason: "The artifact owner changed before Open started.", retryable: false };
      const result = await harnessAdapter.openArtifact(sessionId, candidateId);
      if (result.kind === "unsupported") return { status: "unavailable", reason: result.reason };
      const stillOwnsOpen = () => artifactOpenGeneration.current === admittedGeneration
        && editorOpenAdmission.current === admittedOpen
        && navigationRef.current.selectedChatId === admittedChatId
        && selectedSessionRef.current?.sessionId === sessionId;
      if (!stillOwnsOpen()) {
        return { status: "rejected", reason: "The artifact owner changed before Open completed.", retryable: false };
      }
      const editorWasOpen = layoutCoordinator.current!.snapshot().editorOpen;
      if (!editorWasOpen) {
        const opened = await changeLayout({ editorOpen: true });
        if (opened.status !== "updated") return opened;
      }
      if (!stillOwnsOpen()) {
        if (!editorWasOpen && editorOpenAdmission.current === admittedOpen) await changeLayout({ editorOpen: false });
        return { status: "rejected", reason: "The artifact owner changed before Open completed.", retryable: false };
      }
      editorArtifactRef.current = result.document;
      setEditorArtifact(result.document);
      setEditorAdmissionRevision((revision) => revision + 1);
      setEditorMode("diff");
      canvasRef.current = null;
      setCanvas(null);
      if (viewport <= 900) setActiveSheet("editor");
      return { status: "updated", revision: result.document.ref.revision };
    }
    if (harnessAdapter.availability.status !== "available") {
      return { status: "unavailable", reason: harnessAdapter.availability.reason };
    }
    const sessionMutation = operation.action === "harness.session.prompt" || operation.action === "harness.session.follow-up" || operation.action === "harness.session.steer";
    let admission = sessionMutation ? sessionAdmissions.current.get(operation) : undefined;
    if (sessionMutation && !admission) {
      const state = store.getSnapshot();
      const owners = state.projectCatalog.projects.flatMap((project) => project.chats)
        .filter((chat) => !chat.archived && chat.binding?.sessionId === operation.payload.sessionId);
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (owner) {
        admission = Object.freeze({ chatId: owner.id, draftRevision: draftRevisions.current.get(owner.id) ?? 0 });
        sessionAdmissions.current.set(operation, admission);
      }
    }
    const outcome = await harnessAdapter.execute(operation);
    if (
      sessionMutation
      && (outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "updated")
      && admission
    ) {
      const state = store.getSnapshot();
      const owner = state.projectCatalog.projects.flatMap((project) => project.chats).find((chat) =>
        chat.id === admission.chatId && !chat.archived && chat.binding?.sessionId === operation.payload.sessionId,
      );
      if (
        owner
        && (draftRevisions.current.get(admission.chatId) ?? 0) === admission.draftRevision
        && state.drafts[admission.chatId] === operation.payload.text
      ) {
        store.dispatch({ type: "draft/change", chatId: admission.chatId, draft: "" });
      }
    }
    return outcome;
  };

  const rawDispatchOperation = createStudioOperationDispatcher({
    harness: harnessExecutor,
    studioDurable: durableExecutor,
    renderer: rendererExecutor,
    native: nativeExecutor,
  });
  if (toastCoordinator.current === null) {
    toastCoordinator.current = new ToastOperationCoordinator({
      dispatch: rawDispatchOperation,
      onQueueChange: setToasts,
    });
  } else {
    toastCoordinator.current.setDispatch(rawDispatchOperation);
  }
  const dispatchOperation = (operation: StudioOperation) => toastCoordinator.current!.execute(operation);

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

  const createProject = (name: string, folderPath: string) => {
    void dispatchOperation({ action: "catalog.project.create", payload: { title: name, folderPath } });
  };

  const newChatDisabledReason = catalogOperation.phase === "pending" ? catalogOperation.label : residentCreationDisabledReason(settings) ?? undefined;
  const admissionConnected = Boolean(
    selectedSession
    && selectedSession.freshness === "live"
    && (compatibility.status === "ready" || compatibility.status === "degraded")
    && compatibility.capabilities.includes("session_input_admission"),
  );
  const commandAvailability = {
    admissionConnected,
    disabledActions: newChatDisabledReason ? { "catalog.chat.create": newChatDisabledReason } : undefined,
  } as const;

  const executeCommand = createStudioCommandExecutor(
    () => ({ projectId: store.getSnapshot().projectCatalog.selectedProjectId, availability: commandAvailability }),
    dispatchOperation,
  );
  const runCommand = (id: StudioCommandId) => {
    void executeCommand(id).then((outcome) => {
      if (outcome.status === "unavailable" || outcome.status === "rejected" || outcome.status === "unknown_outcome") setAdmissionMessage(outcome.reason);
    });
  };

  const createChat = () => runCommand("chat.new");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || hasOpenStudioOverlay() || !event.ctrlKey || event.altKey || event.shiftKey) return;
      const command = shortcutStudioCommand(event);
      if (!command) return;
      event.preventDefault();
      runCommand(command.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const workspaceIdentity = deriveWorkspaceIdentity(settingsLoaded
    ? { status: "ready", defaultCwd: settings.defaultCwd }
    : settingsLoadFailed
      ? { status: "unavailable", reason: "Workspace settings could not be loaded." }
      : { status: "loading" });
  const solvedSidebarMode = solveLayout({
    viewport,
    sidebar: { open: layout.sidebarOpen, preferred: layout.sidebarWidth },
    inspector: { open: layout.inspectorOpen, preferred: layout.inspectorWidth },
    editor: { open: layout.editorOpen, preferred: layout.editorWidth },
  }).sidebar.mode;
  const workspaceFooterHost: "pane" | "rail" | "sheet" | null = solvedSidebarMode === "rail" && activeSheet === "sidebar"
    ? "sheet"
    : solvedSidebarMode === "pane"
      ? "pane"
      : solvedSidebarMode === "rail"
      ? "rail"
      : null;
  useLayoutEffect(() => {
    if (solvedSidebarMode !== "rail" && activeSheet === "sidebar") {
      suppressSheetOpenerRestore.current = true;
      setActiveSheet(null);
    }
  }, [activeSheet, solvedSidebarMode]);
  useLayoutEffect(() => {
    if (workspaceMenuHost === null || workspaceMenuHost === workspaceFooterHost) return;
    setWorkspaceMenuHost(null);
    const replacementControlId = workspaceFooterHost === "rail"
      ? "rail-workspace-menu"
      : workspaceFooterHost === "pane" || workspaceFooterHost === "sheet"
        ? "sidebar-workspace-menu"
        : null;
    if (replacementControlId) {
      document.querySelector<HTMLButtonElement>(`[data-control-id="${replacementControlId}"]`)?.focus();
    }
  }, [workspaceFooterHost, workspaceMenuHost]);
  useLayoutEffect(() => {
    const hostChanged = previousSidebarHost.current !== workspaceFooterHost;
    previousSidebarHost.current = workspaceFooterHost;
    if (workspaceMenuHostRef.current !== null) return;

    const controlId = sidebarReplacementFocus.current ?? (hostChanged && sidebarHadFocus.current
      ? workspaceFooterHost === "rail" ? "rail.sidebar.toggle" : workspaceFooterHost === "pane" || workspaceFooterHost === "sheet" ? "sidebar.collapse" : null
      : null);
    if (!controlId) return;

    let cancelled = false;
    const focusReplacement = () => {
      if (cancelled) return false;
      const target = document.querySelector<HTMLButtonElement>(`[data-control-id="${controlId}"]`);
      if (!target?.isConnected) return false;
      target.focus();
      if (sidebarReplacementFocus.current === controlId) sidebarReplacementFocus.current = null;
      return true;
    };
    if (focusReplacement()) return;
    const frame = window.requestAnimationFrame(() => { focusReplacement(); });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [activeSheet, layout.sidebarOpen, workspaceFooterHost]);
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
  const exactLoadedComposer = loadedComposer && selectedSession
    && loadedComposer.sessionId === selectedSession.sessionId
    && loadedComposer.cursor.runtimeGeneration === selectedSession.cursor.runtimeGeneration
    && loadedComposer.cursor.sequence === selectedSession.cursor.sequence
    ? loadedComposer
    : null;
  const composerProjection = adapterConnected && hasCapability("model_catalog")
    ? exactLoadedComposer?.projection ?? harnessAdapter.composer
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
        defaultProjectFolder={settings.defaultCwd ?? ""}
        newChatDisabledReason={newChatDisabledReason}
        onOpenSearch={() => runCommand("palette.open")}
        onOpenArchived={() => runCommand("archived.open")}
        onCollapse={() => { if (layout.sidebarOpen) runCommand("sidebar.toggle"); }}
        onOpenSettings={() => runCommand("settings.open")}
        workspace={workspaceIdentity}
        workspaceMenuOpen={workspaceMenuHost === workspaceFooterHost && (workspaceFooterHost === "pane" || workspaceFooterHost === "sheet")}
        onExecuteWorkspaceOperation={dispatchOperation}
      />
    : <CollapsedSidebar
        newChatDisabledReason={newChatDisabledReason}
        workspace={workspaceIdentity}
        workspaceMenuOpen={workspaceMenuHost === "rail" && workspaceFooterHost === "rail"}
        onCommand={runCommand}
        onExecuteWorkspaceOperation={dispatchOperation}
      />;
  const sidebarRailContent = <CollapsedSidebar
    newChatDisabledReason={newChatDisabledReason}
    workspace={workspaceIdentity}
    workspaceMenuOpen={workspaceMenuHost === "rail" && workspaceFooterHost === "rail"}
    onCommand={runCommand}
    onExecuteWorkspaceOperation={dispatchOperation}
  />;
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

  if (navigation.route === "settings") {
    if (navigation.settingsSection === "archived") {
      return <><Toasts toasts={toasts} execute={dispatchOperation} retry={(operationId) => toastCoordinator.current!.retry(operationId)} /><main className="studio-settings" aria-label="Archived chats">
        <section className="studio-settings-content"><div className="studio-settings-page"><header><button type="button" className="studio-settings-back" aria-label="Back to chat" onClick={() => store.dispatch({ type: "route/workspace" })}>Back to chat</button><h1>Archived chats</h1><span>Restore archived projects and conversations.</span></header>
          <ArchivedCatalogSettings catalog={projectCatalog} operation={catalogOperation} onRestoreProject={(projectId) => { void dispatchOperation({ action: "catalog.project.restore", payload: { projectId } }); }} onRestoreChat={(_projectId, chatId) => { void dispatchOperation({ action: "catalog.chat.restore", payload: { chatId } }); }} onForkChat={(chatId) => { void forkArchivedChat(chatId); }} />
        </div></section>
      </main></>;
    }
    return <><Toasts toasts={toasts} execute={dispatchOperation} retry={(operationId) => toastCoordinator.current!.retry(operationId)} /><SettingsShell
      section={navigation.settingsSection}
      onSection={(section) => { void dispatchOperation({ action: "route.settings.open", payload: { section } }); }}
      onBack={() => { void dispatchOperation({ action: "route.settings.back", payload: {} }); }}
      compatibility={compatibility}
      runtime={runtime}
      onExecute={dispatchOperation}
      commandAvailability={commandAvailability}
      composerShortcutAvailability={composerSubmitAvailability(composerState, draft)}
      settings={settings}
      layout={layout}
      accounts={accounts}
      onAccountsChanged={(next) => {
        if (next) setAccounts(next);
        else void rpc.listAccounts().then(setAccounts).catch(() => toastCoordinator.current?.notify({ owner: "studio_durable", scope: "loading.accounts", severity: "error", title: "Studio loading failed", message: "Account status could not be refreshed." }));
      }}
      onSetting={(key, value) => { void dispatchOperation(value === null ? { action: "settings.preference.reset", payload: { key } } : { action: "settings.preference.set", payload: { key, value } }); }}
      onHarnessSetting={writeHarnessSetting}
      onToolSetting={writeToolSetting}
      onExportUsageCsv={rpc.exportAccountUsageCsv}
      composer={composerProjection}
      quota={quotaProjection}
      quotaStatus={codexQuota.status}
      onRefreshQuota={refreshQuota}
    />{paletteOpen && <CommandPalette admissionConnected={admissionConnected} disabledActions={commandAvailability.disabledActions} onRun={runCommand} onClose={() => { void dispatchOperation({ action: "palette.close", payload: {} }); }} restoreFocusTo={paletteOpener} chats={paletteChats} messages={paletteMessages} onOpenChat={openCatalogChat} onOpenMessage={(chatId) => openCatalogChat(chatId)} />}
    {createProjectOpen && <CreateProjectDialog initialFolderPath={settings.defaultCwd ?? ""} restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}</>;
  }

  const title = selectedChat?.title ?? "Prime Studio";
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
  const loadOlderHistory = async () => {
    const chatId = navigation.selectedChatId;
    const session = selectedSession;
    if (!chatId || !session) return;
    const current = conversationHistory[chatId];
    const before = current?.status === "available" ? current.olderCursor ?? null : null;
    store.dispatch({ type: "conversation/history-requested", chatId, sessionId: session.sessionId, expectedCursor: session.cursor, before });
    if (store.getSnapshot().conversationHistory[chatId]?.status !== "loading") return;
    try {
      const page = await rpc.pageHarnessConversationHistory(session.sessionId, session.cursor, before);
      store.dispatch({ type: "conversation/history-page-loaded", chatId, before, page });
    } catch {
      store.dispatch({
        type: "conversation/history-unavailable", chatId, sessionId: session.sessionId, expectedCursor: session.cursor, before,
        reason: "The verified Harness could not prove an atomic older-history page for this snapshot.",
      });
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

  const visibleArtifact = editorArtifact?.ref.rootSessionId === selectedSession?.sessionId ? editorArtifact : null;
  const canvasVersionState = canvas ? conversationDisplay[canvas.chatId]?.messages[canvas.messageId] : undefined;
  const selectedCanvasSourceVersion = canvasVersionState?.kind === "assistant" ? canvasVersionState.selected : 0;
  const visibleCanvas = canvas?.chatId === navigation.selectedChatId
    && canvas.sessionId === selectedSession?.sessionId
    && canvas.sourceVersion === selectedCanvasSourceVersion
    ? canvas
    : null;
  const activeEditorDocumentId = visibleArtifact
    ? artifactEditorDocumentId(visibleArtifact)
    : visibleCanvas ? canvasEditorDocumentId(visibleCanvas) : null;
  const activeEditorBaseline = visibleArtifact?.content ?? visibleCanvas?.content;
  const activeEditorDraftContent = activeEditorDocumentId ? readEditorBuffer(editorBuffers, activeEditorDocumentId) : undefined;
  const onActiveEditorDraftChange = activeEditorDocumentId && activeEditorBaseline !== undefined ? (content: string) => {
    setEditorBuffers((current) => content === activeEditorBaseline
      ? removeEditorBuffer(current, activeEditorDocumentId)
      : writeEditorBuffer(current, activeEditorDocumentId, content));
  } : undefined;

  return <div className="studio-application">
    <Toasts toasts={toasts} execute={dispatchOperation} retry={(operationId) => toastCoordinator.current!.retry(operationId)} />
    <TitleBar title={title} availability={commandAvailability} onCommand={runCommand} actions={<>
      <button type="button" {...controlBinding(titleActions.projects.id, titleActions.projects.action)} className="studio-command-trigger" aria-label={titleActions.projects.label} aria-pressed={solvedSidebarMode === "rail" ? activeSheet === "sidebar" : layout.sidebarOpen} onClick={(event) => { sheetOpener.current = event.currentTarget; runCommand("sidebar.toggle"); }}><NavigationIcon kind="menu" /></button>
      <button type="button" {...controlBinding(titleActions.harness.id, titleActions.harness.action)} className="studio-command-trigger" aria-label={titleActions.harness.label} aria-pressed={viewport < 760 ? activeSheet === "inspector" : layout.inspectorOpen} onClick={(event) => { sheetOpener.current = event.currentTarget; runCommand("inspector.toggle"); }}><NavigationIcon kind="harness" /></button>
      <button type="button" {...controlBinding(layout.editorOpen ? titleActions.editorClose.id : titleActions.editorOpen.id, layout.editorOpen ? titleActions.editorClose.action : titleActions.editorOpen.action)} className="studio-command-trigger" aria-label={layout.editorOpen ? titleActions.editorClose.label : titleActions.editorOpen.label} onClick={(event) => { if (!layout.editorOpen) sheetOpener.current = event.currentTarget; runCommand(layout.editorOpen ? "editor.close" : "editor.open"); setActiveSheet(layout.editorOpen ? null : "editor"); }}><NavigationIcon kind="editor" /></button>
      <button type="button" {...controlBinding(titleActions.palette.id, titleActions.palette.action)} className="studio-command-trigger" aria-label={titleActions.palette.label} onClick={() => runCommand("palette.open")}><NavigationIcon kind="command" /></button>
    </>} />
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
        {residentBindingFailure?.chatId === navigation.selectedChatId && <ResidentBindingRecovery
          reason={residentBindingFailure.reason}
          pending={catalogOperation.phase === "pending"}
          onRetry={() => { void retryResidentBinding(); }}
          onRollback={() => { void rollbackUnboundChat(); }}
        />}
        <ParentConversation
          title={title}
          session={selectedSession}
          archived={archived}
          canvasChatId={navigation.selectedChatId ?? undefined}
          displayRevisions={navigation.selectedChatId ? displayRevisions[navigation.selectedChatId] : undefined}
          presentations={navigation.selectedChatId && conversationDisplay[navigation.selectedChatId] ? projectConversationPresentations(conversationDisplay[navigation.selectedChatId]!) : undefined}
          history={selectedSession ? conversationHistory[navigation.selectedChatId ?? ""] ?? {
            status: "idle", sessionId: selectedSession.sessionId, snapshotCursor: selectedSession.cursor, messages: [],
          } : undefined}
          onLoadOlder={selectedSession ? () => { void loadOlderHistory(); } : undefined}
          onExecuteOperation={dispatchOperation}
          onSuggestionFill={navigation.selectedChatId ? (text) => { void dispatchOperation({ action: "conversation.suggestion.fill", payload: { chatId: navigation.selectedChatId!, text } }); } : undefined}
          onSelectUserVersion={navigation.selectedChatId ? (messageId, version) => { void dispatchOperation({ action: "conversation.user-version.select", payload: { chatId: navigation.selectedChatId!, messageId, version } }); } : undefined}
          onSelectAssistantVersion={navigation.selectedChatId ? (messageId, version) => { void dispatchOperation({ action: "conversation.assistant-version.select", payload: { chatId: navigation.selectedChatId!, messageId, version } }); } : undefined}
          showSuggestions={settings.promptSuggestions !== "disabled"}
          showTimestamps={settings.timestamps !== "disabled"}
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
          showVoiceControl={settings.voice !== "disabled"}
          spellCheck={settings.spell !== "disabled"}
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
        onRuntimeStatus={setRuntimeInspector}
      />}
      editorContent={<EditorPane
        onClose={() => { void dispatchOperation({ action: "layout.editor.close", payload: {} }); }}
        documentId={activeEditorDocumentId}
        mode={visibleArtifact || visibleCanvas ? editorMode : "edit"}
        onExecute={dispatchOperation}
        artifact={visibleArtifact}
        admissionRevision={editorAdmissionRevision}
        draftContent={activeEditorDraftContent}
        onDraftChange={onActiveEditorDraftChange}
        unsupportedReason="Open an identity-bound candidate from Harness Outputs, Sources, Activity, or a subagent file list."
        canvas={visibleCanvas}
      />}
    />
    <RuntimeStatusBar
      session={selectedSession}
      composer={exactLoadedComposer ? {
        sessionId: exactLoadedComposer.sessionId,
        cursor: exactLoadedComposer.cursor,
        model: exactLoadedComposer.projection.selectedModel,
        thinking: exactLoadedComposer.projection.selectedThinking,
      } : null}
      inspector={adapterConnected && (compatibility.status === "ready" || compatibility.status === "degraded") ? runtimeInspector : null}
    />
    {paletteOpen && <CommandPalette admissionConnected={admissionConnected} disabledActions={commandAvailability.disabledActions} onRun={runCommand} onClose={() => { void dispatchOperation({ action: "palette.close", payload: {} }); }} restoreFocusTo={paletteOpener} chats={paletteChats} messages={paletteMessages} onOpenChat={openCatalogChat} onOpenMessage={(chatId) => openCatalogChat(chatId)} />}
    {createProjectOpen && <CreateProjectDialog initialFolderPath={settings.defaultCwd ?? ""} restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}
  </div>;
}

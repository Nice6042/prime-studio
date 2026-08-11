import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as rpc from "./rpc";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { isSection } from "./components/settingsSections";
import { Toasts } from "./components/Toasts";
import { PRIME_AGENT_URL } from "./components/primeAgent";
import { accountLabel, accountProvider } from "./accounts";
import { SurfaceFallback } from "./lazyBoundaries";
import type { SettingsSection } from "./components/settingsSections";
import type { SessionDefaults } from "./useSession";
import type {
  Account,
  AppSettings,
  CliStatus,
  DiskSession,
  FleetAgent,
  ModelInfo,
  SchedulerProjection,
  ThinkingLevel,
} from "./types";
import { AppProviders } from "./app/AppProviders";
import { StudioApp } from "./app/StudioApp";
import { createStudioStore, initialStudioState } from "./shared/state/store";

type Theme = "dark" | "light";

const SCHEDULER_UNAVAILABLE: SchedulerProjection = {
  schemaVersion: 1,
  revision: null,
  status: "unavailable",
  dispatchAvailable: false,
};

const Settings = lazy(() =>
  import("./components/Settings").then(({ Settings: Surface }) => ({ default: Surface })),
);
const Usage = lazy(() =>
  import("./components/Usage").then(({ Usage: Surface }) => ({ default: Surface })),
);
const Fleet = lazy(() =>
  import("./components/Fleet").then(({ Fleet: Surface }) => ({ default: Surface })),
);

/** Whether the OS is asking for dark, kept live so "system" actually follows it. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

/** One open session (or one archived transcript). Its account is fixed at spawn. */
interface Tab {
  id: string;
  accountId: string | null;
  /** Set for a read-only history tab. */
  diskId?: string;
  /**
   * Set to reattach to a daemon agent that is already running: the tab restores
   * that agent's transcript instead of starting a fresh session.
   */
  agentId?: string;
  title: string;
}

let tabSeq = 0;
const newTabId = () => `tab-${++tabSeq}`;
const sessionTabId = (id: string) => `session-tab-${id}`;
const sessionPanelId = (id: string) => `session-panel-${id}`;

export function LegacyApp() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<DiskSession[]>([]);
  const [cli, setCli] = useState<CliStatus | null>(null);
  // Empty until the registry and the settings file have loaded: a tab's account
  // and its session defaults are both fixed the moment it mounts, so opening one
  // early would bind it to the wrong things.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [focusedTab, setFocusedTab] = useState<string>("");
  const [booted, setBooted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("accounts");
  const [usageOpen, setUsageOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [scheduler, setScheduler] = useState<SchedulerProjection>(SCHEDULER_UNAVAILABLE);
  /** Which tabs are mid-turn, so the tab strip can show what is still working. */
  const [busyTabs, setBusyTabs] = useState<Record<string, boolean>>({});
  /** Agents that were still running when this window opened. Dismissable. */
  const [waiting, setWaiting] = useState<FleetAgent[]>([]);
  /** Every agent the daemon knows, so the sidebar can mark live sessions. */
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  /** Rust's settings file is the only persistence and authority boundary. */
  const [settings, setSettings] = useState<AppSettings>({});
  const systemDark = useSystemDark();
  const searchRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingTabFocus = useRef<string | null>(null);

  const current = tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const activeAccountId = current?.accountId ?? null;
  const hasBoundTab = current !== undefined;

  // Unset means dark, matching what the app has always defaulted to — and what
  // the Appearance pane highlights. Only an explicit "system" follows the OS.
  const pref = settings.theme ?? "dark";
  const theme: Theme =
    pref === "light" || pref === "dark" ? pref : systemDark ? "dark" : "light";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /** Commit local state only after Rust has admitted and persisted the write. */
  const setSetting = useCallback((key: keyof AppSettings, value: string | null) => {
    void rpc.setAppSetting(key, value).then(setSettings).catch(() => undefined);
  }, []);

  const openSettings = useCallback((to?: SettingsSection) => {
    if (to) {
      setSection(to);
    }
    setSettingsOpen(true);
  }, []);

  const chooseSection = useCallback((to: SettingsSection) => {
    setSection(to);
  }, []);

  const reloadAccounts = useCallback(async () => setAccounts(await rpc.listAccounts()), []);

  const loadSessions = useCallback(async () => {
    setSessions(await rpc.listDiskSessions(activeAccountId));
  }, [activeAccountId]);

  const refreshSessions = useCallback(async () => {
    await loadSessions();
    // Refreshed alongside the list it annotates, so a row cannot claim "running"
    // for an agent that ended two turns ago.
    if (cli?.daemon) void rpc.fleetList().then((f) => setAgents(f.agents));
  }, [cli?.daemon, loadSessions]);

  useEffect(() => {
    void rpc.connect();
    // Resolve prime-agent first: the model list comes from that same CLI, so
    // without it there is nothing to ask and the banner below explains why.
    void rpc.resolvePrimeCli().then(setCli);
    void rpc
      .schedulerProjection()
      .then(setScheduler)
      .catch(() => setScheduler(SCHEDULER_UNAVAILABLE));
    void Promise.all([
      reloadAccounts(),
      rpc.getAppSettings().then((s) => {
        setSettings(s);
        if (isSection(s.lastSection)) setSection(s.lastSection);
      }),
      // Both resolve even when the backend is missing (safeInvoke falls back), so
      // this cannot leave the app tabless.
    ]).then(() => setBooted(true));
  }, [reloadAccounts]);

  useEffect(() => {
    if (cli?.path) void rpc.listModels().then(setModels);
  }, [cli?.path]);

  /**
   * Agents outlive the window now, so a fresh launch has to say so. Only rows
   * nothing is driving are offered — a session another window or a terminal
   * already has is not this window's to claim.
   */
  useEffect(() => {
    if (!cli?.daemon) return;
    void rpc.fleetList().then((f) => {
      setAgents(f.agents);
      setWaiting(f.agents.filter((a) => a.depth === 0 && a.clients === 0));
    });
  }, [cli?.daemon]);

  useEffect(() => {
    if (!hasBoundTab) return;
    void loadSessions();
  }, [hasBoundTab, loadSessions]);

  /** The default account, ignoring a stale id left behind by a removed account. */
  const defaultAccountId =
    accounts.find((a) => a.id === settings.defaultAccount)?.id ?? accounts[0]?.id ?? null;

  // The opening tab, once there is something to bind it to. A fresh install with
  // no accounts still gets one (accountId null = prime's original agent home).
  useEffect(() => {
    if (!booted) return;
    setTabs((ts) =>
      ts.length ? ts : [{ id: newTabId(), accountId: defaultAccountId, title: "New chat" }],
    );
  }, [booted, defaultAccountId]);

  /**
   * Defaults for a tab's first session. The model is dropped when it belongs to
   * another provider — a ChatGPT profile holds no Claude credential, so spawning
   * it with `--provider anthropic` would just fail.
   */
  const defaultsFor = useCallback(
    (accountId: string | null): SessionDefaults => {
      const provider = accountProvider(accounts, accountId);
      const usable =
        !!settings.defaultProvider &&
        !!settings.defaultModel &&
        (!provider || provider === settings.defaultProvider);
      return {
        provider: usable ? settings.defaultProvider : null,
        model: usable ? settings.defaultModel : null,
        thinking: (settings.defaultThinking as ThinkingLevel | null) ?? null,
        cwd: settings.defaultCwd ?? null,
        // Decides what closing this tab means: detach, or end the session.
        daemon: !!cli?.daemon,
      };
    },
    [
      accounts,
      cli?.daemon,
      settings.defaultProvider,
      settings.defaultModel,
      settings.defaultThinking,
      settings.defaultCwd,
    ],
  );

  const openTab = useCallback((tab: Omit<Tab, "id">) => {
    const id = newTabId();
    setTabs((ts) => [...ts, { ...tab, id }]);
    setActiveTab(id);
    setFocusedTab(id);
  }, []);

  /** Open a tab driving an agent that is already running in the daemon. */
  const attachAgent = useCallback(
    (a: FleetAgent) => {
      setFleetOpen(false);
      setWaiting((w) => w.filter((x) => x.id !== a.id));
      openTab({
        accountId: a.accountId ?? null,
        agentId: a.id,
        title: a.name?.trim() || a.firstMessage?.trim() || a.id,
      });
    },
    [openTab],
  );

  const closeTab = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;

      // Unmounting this pane stops only its prime child; surviving tabs retain
      // their keys, mounted panes, and account ownership.
      const remaining = tabs.filter((tab) => tab.id !== id);
      const nextTabs = remaining.length
        ? remaining
        : [{ id: newTabId(), accountId: tabs[index].accountId, title: "New chat" }];
      const destination = nextTabs[Math.min(index, nextTabs.length - 1)];

      setTabs(nextTabs);
      if (id === current?.id) setActiveTab(destination.id);
      setFocusedTab(destination.id);
      pendingTabFocus.current = destination.id;
    },
    [current?.id, tabs],
  );

  // activeTab must always name a live tab, or every pane ends up hidden.
  useEffect(() => {
    if (tabs.length && !tabs.some((t) => t.id === activeTab)) setActiveTab(tabs[tabs.length - 1].id);
  }, [tabs, activeTab]);

  // Keep one tab in the page's Tab order. Arrow navigation may leave focus on
  // an unselected tab until Enter or Space activates it (manual activation).
  useEffect(() => {
    if (!tabs.length) return;
    setFocusedTab((id) => (tabs.some((tab) => tab.id === id) ? id : (current?.id ?? tabs[0].id)));
  }, [current?.id, tabs]);

  // The close button disappears with its tab. Restore focus after React has
  // committed the surviving (or replacement) destination.
  useEffect(() => {
    const id = pendingTabFocus.current;
    if (!id) return;
    tabRefs.current.get(id)?.focus();
    pendingTabFocus.current = null;
  }, [tabs]);

  const moveTabFocus = useCallback(
    (fromId: string, key: ReactKeyboardEvent<HTMLButtonElement>["key"]) => {
      const index = tabs.findIndex((tab) => tab.id === fromId);
      if (index < 0 || !tabs.length) return;
      const destinationIndex =
        key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : key === "ArrowRight"
              ? (index + 1) % tabs.length
              : (index - 1 + tabs.length) % tabs.length;
      const id = tabs[destinationIndex].id;
      setFocusedTab(id);
      tabRefs.current.get(id)?.focus();
    },
    [tabs],
  );

  /** Identity-preserving: returning the same array lets React bail out. */
  const setTitle = useCallback((id: string, title: string) => {
    setTabs((ts) =>
      ts.some((t) => t.id === id && t.title !== title)
        ? ts.map((t) => (t.id === id ? { ...t, title } : t))
        : ts,
    );
  }, []);

  const newChat = useCallback(
    () => openTab({ accountId: activeAccountId ?? defaultAccountId, title: "New chat" }),
    [openTab, activeAccountId, defaultAccountId],
  );

  /**
   * Open an archived transcript in its own read-only tab. `id` is a session id,
   * or a subagent's session directory — those are not in the session list, so
   * they are titled from the directory name (`sub-ce91ee5c`).
   */
  const openSession = useCallback(
    (id: string) =>
      openTab({
        accountId: activeAccountId,
        diskId: id,
        title:
          sessions.find((x) => x.id === id)?.title?.trim() ||
          (/[\\/]/.test(id) ? (id.split(/[\\/]/).filter(Boolean).pop() ?? id) : "Untitled session"),
      }),
    [openTab, activeAccountId, sessions],
  );

  // Ctrl+K belongs to the command palette (owned by the active ChatPane, which is
  // where the live session it acts on lives); sidebar search moved to Ctrl+F.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChat();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  return (
    <div
      className={`app ${artifactsOpen ? "with-artifacts" : ""} ${
        cli && !cli.path ? "with-banner" : ""
      } ${waiting.length ? "with-reattach" : ""}`}
    >
      {cli && !cli.path && (
        <div className="cli-banner">
          <strong>prime-agent not found.</strong> Prime Studio is a client for it — chat cannot
          start until it is installed or its path is set.
          <pre className="cli-error">{cli.error}</pre>
          <div className="acct-actions">
            <button className="btn btn-send" onClick={() => openSettings("agent")}>
              Set the CLI path
            </button>
            <button className="btn" onClick={() => void rpc.openExternal(PRIME_AGENT_URL)}>
              Install instructions
            </button>
            <button className="btn" onClick={() => void rpc.resolvePrimeCli().then(setCli)}>
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="tabbar">
        <div className="tab-items">
          <div className="tablist" role="tablist" aria-label="Open sessions">
            {tabs.map((t) => {
              const selected = t.id === current?.id;
              const rovingId = tabs.some((tab) => tab.id === focusedTab)
                ? focusedTab
                : current?.id;
              const sessionName = `${t.diskId ? "history: " : ""}${t.title}`;
              const accessibleName = `${accountLabel(accounts, t.accountId)} — ${sessionName}`;
              return (
                <button
                  key={t.id}
                  ref={(element) => {
                    if (element) tabRefs.current.set(t.id, element);
                    else tabRefs.current.delete(t.id);
                  }}
                  type="button"
                  role="tab"
                  id={sessionTabId(t.id)}
                  className={`tab ${selected ? "active" : ""}`}
                  aria-label={accessibleName}
                  aria-controls={sessionPanelId(t.id)}
                  aria-selected={selected}
                  tabIndex={t.id === rovingId ? 0 : -1}
                  onClick={() => {
                    setFocusedTab(t.id);
                    setActiveTab(t.id);
                  }}
                  onKeyDown={(event) => {
                    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      moveTabFocus(t.id, event.key);
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setFocusedTab(t.id);
                      setActiveTab(t.id);
                    }
                  }}
                  title={accessibleName}
                >
                  {/* The dot is the session's state, not decoration: running sessions
                      are the ones you switch back to. Account lives in the titlebar. */}
                  <span
                    aria-hidden="true"
                    className={`dot p-${accountProvider(accounts, t.accountId) || "none"} ${
                      busyTabs[t.id] ? "live" : ""
                    }`}
                  />
                  <span className="tab-title">{sessionName}</span>
                </button>
              );
            })}
          </div>
          <div className="tab-close-list" role="group" aria-label="Close sessions">
            {tabs.map((t) => {
              const sessionName = `${t.diskId ? "history: " : ""}${t.title}`;
              const accessibleName = `${accountLabel(accounts, t.accountId)} — ${sessionName}`;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`tab-x ${t.id === current?.id ? "active" : ""}`}
                  aria-label={`Close ${accessibleName}`}
                  title={
                    cli?.daemon
                      ? "Close tab — the agent keeps running, find it in Fleet"
                      : "Close session — this build has no daemon, so the session ends"
                  }
                  onClick={() => closeTab(t.id)}
                >
                  ✕
                </button>
              );
            })}
          </div>
        </div>
        <button className="btn btn-icon" onClick={newChat} title="New tab (Ctrl+N)">
          +
        </button>
        <span style={{ flex: 1 }} />
        <span
          className={`scheduler-status scheduler-status-${scheduler.status}`}
          role="status"
          aria-label="Scheduler status"
        >
          Scheduler: {scheduler.status}
        </span>
        {cli?.daemon && (
          <button
            className="btn"
            onClick={() => setFleetOpen(true)}
            title="Every agent the daemon is running, this window's and everyone else's"
          >
            Fleet
          </button>
        )}
      </div>

      {waiting.length > 0 && (
        <div className="reattach-strip">
          <strong>
            {waiting.length} agent{waiting.length === 1 ? "" : "s"} still running
          </strong>
          <span className="fleet-note">
            {waiting.length === 1 ? "It kept" : "They kept"} going after the last window closed.
            Reattaching restores the transcript and carries on.
          </span>
          {waiting.slice(0, 3).map((a) => (
            <button key={a.id} className="btn btn-send" onClick={() => attachAgent(a)}>
              Reattach {a.name?.trim() || a.id}
            </button>
          ))}
          {waiting.length > 3 && (
            <button className="btn" onClick={() => setFleetOpen(true)}>
              Show all in Fleet
            </button>
          )}
          <button className="btn" onClick={() => setWaiting([])} title="Leave them running">
            Dismiss
          </button>
        </div>
      )}

      <Sidebar
        sessions={sessions}
        activeId={current?.diskId ?? null}
        accountName={accountLabel(accounts, activeAccountId)}
        onSelect={openSession}
        onNew={newChat}
        onRefresh={() => void refreshSessions()}
        agents={agents}
        searchRef={searchRef}
      />

      {tabs.map((t) => (
        <ChatPane
          key={t.id}
          active={t.id === current?.id}
          panelId={sessionPanelId(t.id)}
          tabId={sessionTabId(t.id)}
          accountId={t.accountId}
          accounts={accounts}
          diskId={t.diskId}
          models={models}
          sessions={sessions}
          theme={theme}
          onTheme={() => setSetting("theme", theme === "dark" ? "light" : "dark")}
          artifactsOpen={artifactsOpen}
          onToggleArtifacts={() => setArtifactsOpen((v) => !v)}
          onAccount={(id) => openTab({ accountId: id, title: "New chat" })}
          onOpenSettings={openSettings}
          onOpenUsage={() => setUsageOpen(true)}
          onOpenSession={openSession}
          onNewTab={newChat}
          onIdle={() => void refreshSessions()}
          onBusy={(b) => setBusyTabs((m) => (m[t.id] === b ? m : { ...m, [t.id]: b }))}
          onTitle={(title) => setTitle(t.id, title)}
          defaults={{ ...defaultsFor(t.accountId), agent: t.agentId }}
        />
      ))}

      {settingsOpen && (
        <Suspense
          fallback={
            <SurfaceFallback
              surface="modal"
              className="modal-wide settings"
              label="Loading settings"
              onClose={() => setSettingsOpen(false)}
            />
          }
        >
          <Settings
            section={section}
            onSection={chooseSection}
            onClose={() => setSettingsOpen(false)}
            accounts={accounts}
            onAccountsChanged={(refreshed) => {
              if (refreshed !== undefined) setAccounts(refreshed);
              else void reloadAccounts();
            }}
            onUse={(id) => {
              setSettingsOpen(false);
              openTab({ accountId: id, title: "New chat" });
            }}
            cli={cli}
            onCli={setCli}
            models={models}
            settings={settings}
            onSetting={setSetting}
          />
        </Suspense>
      )}
      {usageOpen && (
        <Suspense
          fallback={
            <SurfaceFallback
              surface="modal"
              className="modal-wide"
              label="Loading usage"
              onClose={() => setUsageOpen(false)}
            />
          }
        >
          <Usage accounts={accounts} onClose={() => setUsageOpen(false)} />
        </Suspense>
      )}
      {fleetOpen && (
        <Suspense
          fallback={
            <SurfaceFallback
              surface="modal"
              className="modal-fleet"
              label="Loading fleet"
              onClose={() => setFleetOpen(false)}
            />
          }
        >
          <Fleet
            accounts={accounts}
            onAttach={attachAgent}
            onRead={(stem, accountId) => {
              setFleetOpen(false);
              openTab({ accountId, diskId: stem, title: stem });
            }}
            onClose={() => setFleetOpen(false)}
          />
        </Suspense>
      )}
      <Toasts />
    </div>
  );
}

const studioStore = createStudioStore(initialStudioState());

export default function App() {
  if (import.meta.env.VITE_PRIME_STUDIO_WORKSPACE === "1" || (import.meta.env.VITE_PRIME_STUDIO_WORKSPACE !== "0" && import.meta.env.PROD)) {
    return (
      <AppProviders store={studioStore}>
        <StudioApp />
      </AppProviders>
    );
  }
  return <LegacyApp />;
}

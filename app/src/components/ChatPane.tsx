import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import * as rpc from "../rpc";
import { useSession } from "../useSession";
import { PROVIDER_NAME, accountLabel, accountProvider } from "../accounts";
import { TopBar } from "./TopBar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { RightRail, kernelLine, useKernel } from "./RightRail";
import { StatusLine } from "./StatusLine";
import { isQuiet } from "../transcript";
import { SurfaceFallback } from "../lazyBoundaries";
import { preloadMarkdown } from "../markdownLoader";
import type { ChildActions } from "./ToolCard";
import type { Cmd } from "./Palette";
import type { SettingsSection } from "./settingsSections";
import type { SessionDefaults } from "../useSession";
import type { Account, DiskSession, ModelInfo } from "../types";

const Artifacts = lazy(() =>
  import("./Artifacts").then(({ Artifacts: Surface }) => ({ default: Surface })),
);
const Palette = lazy(() =>
  import("./Palette").then(({ Palette: Surface }) => ({ default: Surface })),
);

/**
 * One tab: one prime child, one account, one transcript.
 *
 * Every open tab stays mounted — inactive ones are only hidden — because
 * unmounting would tear down the child process. That is what makes several
 * accounts run at the same time.
 */
export function ChatPane({
  active,
  panelId,
  tabId,
  accountId,
  accounts,
  diskId,
  models,
  sessions,
  theme,
  onTheme,
  artifactsOpen,
  onToggleArtifacts,
  onAccount,
  onOpenSettings,
  onOpenUsage,
  onOpenSession,
  onNewTab,
  onIdle,
  onBusy,
  onTitle,
  defaults,
}: {
  active: boolean;
  /** Stable accessibility relationship to this session's owning tab. */
  panelId: string;
  tabId: string;
  accountId: string | null;
  accounts: Account[];
  /** Set for a history tab: render that archived transcript read-only. */
  diskId?: string;
  models: ModelInfo[];
  /** On-disk sessions for this account — the palette's session list. */
  sessions: DiskSession[];
  theme: "dark" | "light";
  onTheme: () => void;
  artifactsOpen: boolean;
  onToggleArtifacts: () => void;
  onAccount: (id: string) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenUsage: () => void;
  onOpenSession: (id: string) => void;
  onNewTab: () => void;
  onIdle: () => void;
  /** Mid-turn state, so the tab strip can mark this session live. */
  onBusy: (busy: boolean) => void;
  onTitle: (title: string) => void;
  /** Settings-window defaults for this tab's first session. */
  defaults?: SessionDefaults;
}) {
  const s = useSession(accountId, defaults);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The one-line session summary is the rail's collapsed form: one state, so the
  // header can never disagree with the meters it summarises.
  const [railOpen, setRailOpen] = useState(true);
  const kernel = useKernel();

  useEffect(() => {
    if (diskId) void s.openDiskSession(diskId);
    // s changes every render; the disk id is the only trigger that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diskId]);

  // Only the visible tab reacts to these — otherwise one keypress hits every tab.
  // The palette lives here rather than in App because its commands (set_model,
  // abort, compact, export) need this tab's live session.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape" && s.chat.busy) {
        e.preventDefault();
        s.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, s]);

  // Finished turns write session files; let the sidebar catch up.
  useEffect(() => {
    onBusy(s.chat.busy);
    if (!s.chat.busy) onIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.chat.busy]);

  const title = s.chat.retention.firstUserText;
  useEffect(() => {
    if (title) onTitle(title.slice(0, 32));
  }, [title, onTitle]);

  const pickCwd = useCallback(async () => {
    const dir = await rpc.pickDirectory();
    if (dir) await s.setCwd(dir);
  }, [s]);

  const label = accountLabel(accounts, accountId);
  const provider = accountProvider(accounts, accountId);

  /** Sent straight to the child: no SessionApi wrapper earns its keep for one line. */
  const rawSend = (command: Parameters<typeof rpc.send>[1]) => {
    if (s.sessionKey) void rpc.send(s.sessionKey, command);
  };

  // Rebuilt each render — a few dozen closures over live session state, which is
  // cheaper than keeping them in sync.
  const cmds: Cmd[] = [
    { id: "a-new-chat", group: "Actions", label: "New chat (reset this tab)", run: () => void s.newChat() },
    { id: "a-new-tab", group: "Actions", label: "New tab", hint: "Ctrl+N", run: onNewTab },
    { id: "a-usage", group: "Actions", label: "Open usage page", run: onOpenUsage },
    {
      id: "a-settings",
      group: "Actions",
      label: "Open settings",
      hint: "Ctrl+,",
      run: () => onOpenSettings(),
    },
    {
      id: "a-accounts",
      group: "Actions",
      label: "Manage accounts",
      hint: "Settings → Accounts",
      run: () => onOpenSettings("accounts"),
    },
    { id: "a-artifacts", group: "Actions", label: "Toggle artifact pane", run: onToggleArtifacts },
    {
      id: "a-theme",
      group: "Actions",
      label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
      run: onTheme,
    },
    { id: "a-abort", group: "Actions", label: "Abort current turn", hint: "Esc", run: s.abort },
    // Closing the tab only detaches when the session is daemon-backed. Ending
    // the agent is a separate, deliberate act — never a side effect of a click
    // on the tab's ✕.
    ...(s.daemon
      ? [
          {
            id: "a-stop-agent",
            group: "Actions",
            label: "Stop this agent (ends its work)",
            hint: s.agentId ? `agent ${s.agentId}` : "no agent yet",
            run: () => {
              if (window.confirm("Stop this agent? Its kernel and any running work end now.")) {
                void s.endAgent();
              }
            },
          },
        ]
      : []),
    { id: "a-compact", group: "Actions", label: "Compact context", run: s.compact },
    {
      id: "a-export",
      group: "Actions",
      label: "Export transcript (HTML)",
      run: () => rawSend({ type: "export_html" }),
    },
    { id: "a-cwd", group: "Actions", label: "Pick working directory", run: () => void pickCwd() },
    ...sessions.map((x) => ({
      id: `s-${x.id}`,
      group: "Sessions",
      label: x.title?.trim() || x.id,
      hint: x.cwd?.split(/[\\/]/).filter(Boolean).pop(),
      run: () => onOpenSession(x.id),
    })),
    ...models.map((m) => ({
      id: `m-${m.provider}/${m.model}`,
      group: "Models",
      label: m.name ?? m.model,
      hint: m.provider,
      // Verified against the CLI bundle: set_model takes provider + modelId.
      run: () => s.chooseModel(m.provider, m.model),
    })),
    ...accounts.map((a) => ({
      id: `acct-${a.id}`,
      group: "Accounts",
      label: a.label,
      hint: `${PROVIDER_NAME[a.provider] ?? a.provider} — new tab`,
      run: () => onAccount(a.id),
    })),
  ];

  const children = Object.values(s.chat.children);
  // A session with no tools or children needs no secondary activity panels.
  const quiet = isQuiet(s.chat);
  // Keep workspace selection and the composer together until the transcript begins.
  const firstRun = s.chat.timeline.length === 0 && !s.readOnly;
  const showRail = !quiet && !firstRun && railOpen;
  const turns = s.chat.retention.totalTurns;
  const ctx = s.stats?.contextUsage;

  const childActions: ChildActions = {
    // Prime has no RPC for agent messaging — it is a kernel skill — so this asks
    // the running session to make the call, which is the only honest wiring.
    onMessageChild: (name, text) => {
      const ask =
        `Use the agent-message skill to relay this to your child "${name}": ${text}\n` +
        `(agent_message.send(receiver_role="child", receiver_name="${name}", ...))`;
      (s.chat.busy ? s.steer : s.prompt)(ask);
    },
    onOpenChild: (child) => child.sessionDir && onOpenSession(child.sessionDir),
  };

  return (
    <>
      <div
        className="session-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        hidden={!active}
      >
        <main className="main">
        <TopBar
          kernel={kernel}
          starting={s.starting}
          daemon={s.daemon}
          account={label}
          onOpenSettings={onOpenSettings}
        />

        <div className="body">
          <div className="column">
            {/* Before the first turn, keep the composer with the workspace choices;
                after a turn begins, it anchors the transcript's continuation. */}
            {firstRun ? (
              <div className="first-run">
                <h1>Ready. Pick a folder and say what you want done.</h1>
                <p className="lede">
                  Prime works inside one folder and runs everything as Python in a live
                  kernel. Nothing is gated — every cell executes the moment the model writes
                  it — so use a repo you can restore.
                </p>
                <div className="first-run-actions">
                  <button className="chip" onClick={() => void pickCwd()}>
                    {s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : "Choose folder…"}
                  </button>
                  <span className="chip chip-ro">{s.model?.model ?? "default model"}</span>
                  <span className="chip chip-ro">think: {s.thinking}</span>
                </div>
                <Composer
                  busy={s.chat.busy}
                  readOnly={false}
                  onSend={s.prompt}
                  onSteer={s.steer}
                  onQueue={s.followUp}
                  onPreloadMarkdown={preloadMarkdown}
                />
                <div className="first-run-foot">
                  <span>Ctrl+K palette</span>
                  <span>Ctrl+N new tab</span>
                  <span>
                    {label}
                    {provider ? ` · ${PROVIDER_NAME[provider] ?? provider}` : ""}
                  </span>
                </div>
              </div>
            ) : (
              <>
            {/* The collapsed form of the rail. Absent on a quiet turn, where there
                is no goal, no plan and no gate for it to summarise. */}
            {!quiet && (
              <button
                className="sessionstrip"
                aria-expanded={railOpen}
                onClick={() => setRailOpen((v) => !v)}
              >
                <span className="strip-label">SESSION</span>
                <span className="strip-spacer" />
                <span className="strip-v">${(s.stats?.cost ?? 0).toFixed(2)}</span>
                {ctx && <span className="strip-v">ctx {Math.round(ctx.percent)}%</span>}
                <span className="strip-v">
                  {turns} turn{turns === 1 ? "" : "s"}
                </span>
                {children.length > 0 && (
                  <span className="strip-v">{children.length} children</span>
                )}
                <span className="strip-chev">{railOpen ? "▾" : "▸"}</span>
              </button>
            )}

            <MessageList
              timeline={s.chat.timeline}
              tools={s.chat.tools}
              children={children}
              busy={s.chat.busy}
              actions={childActions}
              omittedItems={s.chat.retention.omittedItems}
              totalItems={s.chat.retention.totalItems}
              payloadTruncated={s.chat.retention.payloadTruncated}
              windowStart={s.chat.retention.windowStart}
              windowEnd={s.chat.retention.windowEnd}
              hasOlder={!s.chat.busy && s.chat.retention.windowStart > 0}
              hasNewer={
                !s.chat.busy &&
                s.chat.retention.windowEnd < s.chat.retention.totalItems
              }
              onOlder={() => void s.showOlderMessages()}
              onLatest={() => void s.showLatestMessages()}
              // Only reachable for an archived transcript that holds nothing;
              // a live empty session renders the first-run screen instead.
              empty={<p className="rail-empty">This archived session has no messages.</p>}
            />

            <StatusLine chat={s.chat} onStop={s.abort} />

            {/* Quiet turn: the kernel and the session get one hairline row between
                them rather than a panel each. */}
            {quiet && s.chat.timeline.length > 0 && (
              <div className="quietline">
                <span>{kernelLine(kernel)}</span>
                <span className="hair" />
                <span>
                  {s.model?.model ?? "default model"} · think {s.thinking} · $
                  {(s.stats?.cost ?? 0).toFixed(2)}
                </span>
              </div>
            )}

            <Composer
              busy={s.chat.busy}
              readOnly={s.readOnly}
              onSend={s.prompt}
              onSteer={s.steer}
              onQueue={s.followUp}
              onPreloadMarkdown={preloadMarkdown}
            />
              </>
            )}
          </div>

          {showRail && (
            <RightRail
              stats={s.stats}
              children={children}
              turns={turns}
              models={models}
              model={s.model}
              onModel={s.chooseModel}
              thinking={s.thinking}
              onThinking={s.chooseThinking}
              cwd={s.cwd}
              busy={s.chat.busy}
            />
          )}
        </div>
        </main>
      </div>

      {active && artifactsOpen && (
        <Suspense fallback={<SurfaceFallback surface="artifacts" label="Loading artifacts" />}>
          <Artifacts cwd={s.cwd} />
        </Suspense>
      )}
      {active && paletteOpen && (
        <Suspense
          fallback={
            <SurfaceFallback
              surface="palette"
              label="Loading command palette"
              onClose={() => setPaletteOpen(false)}
            />
          }
        >
          <Palette cmds={cmds} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

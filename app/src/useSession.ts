import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as rpc from "./rpc";
import { note as noteRateLimits } from "./rateLimits";
import { empty, reduce } from "./reducer";
import type { ChatState } from "./reducer";
import type { PrimeMessage, SessionStats, ThinkingLevel } from "./types";

/**
 * Settings-window defaults for a *new* session. Read once, at mount: prime binds
 * provider/model/cwd at spawn, so changing them later is a new session anyway.
 */
export interface SessionDefaults {
  provider?: string | null;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  cwd?: string | null;
  /**
   * Whether the resolved prime supports daemon-backed sessions. Decides what a
   * closed tab means: detach (agent keeps running) or end.
   */
  daemon?: boolean;
  /** Reattach to this live daemon agent instead of starting a fresh session. */
  agent?: string | null;
}

/** What `get_state` gives back on reattach. */
interface AgentState {
  model?: { id?: string; provider?: string };
  thinkingLevel?: ThinkingLevel;
  sessionFile?: string;
  isStreaming?: boolean;
}

type HistorySource =
  | { kind: "live"; key: string }
  | { kind: "disk"; id: string; accountId?: string | null };

/**
 * A stable, human-findable name for a new agent, so `prime-agent list` shows
 * something other than a hex id. Renamed to the first prompt once there is one.
 */
let nameSeq = Number(localStorage.getItem("prime-name-seq") ?? 0) || 0;
function nextAgentName(): string {
  nameSeq += 1;
  localStorage.setItem("prime-name-seq", String(nameSeq));
  return `studio-${nameSeq}`;
}

/** Event types already printed once by the dev-only sampler below. */
const SEEN = new Set<string>();

export interface SessionApi {
  sessionKey: string | null;
  chat: ChatState;
  stats: SessionStats | null;
  starting: boolean;
  /** True when showing an archived transcript (no live process attached). */
  readOnly: boolean;
  /** The daemon agent behind this tab, once known. Null on a stock prime. */
  agentId: string | null;
  /** True when this session is daemon-backed, i.e. it survives the window. */
  daemon: boolean;
  /** End the agent for good — the deliberate counterpart to closing the tab. */
  endAgent: () => Promise<void>;
  cwd: string | null;
  model: { provider: string; model: string } | null;
  thinking: ThinkingLevel;
  newChat: (opts?: { cwd?: string; provider?: string; model?: string }) => Promise<void>;
  prompt: (text: string) => void;
  steer: (text: string) => void;
  /** Queue a turn to run after the current one — prime's `follow_up`, not `steer`. */
  followUp: (text: string) => void;
  abort: () => void;
  compact: () => void;
  chooseModel: (provider: string, model: string) => void;
  chooseThinking: (level: ThinkingLevel) => void;
  setCwd: (dir: string) => Promise<void>;
  openDiskSession: (id: string) => Promise<void>;
  showOlderMessages: () => Promise<void>;
  showLatestMessages: () => Promise<void>;
}

/**
 * One live prime child per hook instance. Several instances coexist (one per open
 * tab), so anything keyed by session must filter on `keyRef` — a sibling's exit
 * must not touch this one.
 *
 * `accountId` is the login the child is spawned under and is fixed for the life of
 * that child; changing accounts means a new session, not a switch.
 */
export function useSession(accountId?: string | null, defaults?: SessionDefaults): SessionApi {
  const [chat, dispatch] = useReducer(reduce, empty);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [starting, setStarting] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [cwd, setCwdState] = useState<string | null>(defaults?.cwd ?? null);
  const [model, setModel] = useState<{ provider: string; model: string } | null>(() =>
    defaults?.provider && defaults?.model
      ? { provider: defaults.provider, model: defaults.model }
      : null,
  );
  const [thinking, setThinking] = useState<ThinkingLevel>(defaults?.thinking ?? "high");

  const [agentId, setAgentId] = useState<string | null>(defaults?.agent ?? null);

  const keyRef = useRef<string | null>(null);
  keyRef.current = sessionKey;
  const historySourceRef = useRef<HistorySource | null>(null);
  const agentRef = useRef<string | null>(agentId);
  agentRef.current = agentId;
  // Capability and reattach target are fixed for the tab; refs keep them out of
  // every callback's dependency list without going stale.
  const daemon = !!defaults?.daemon;
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;
  // A fresh child runs prime's own thinking level until told otherwise, so the
  // picker would be lying about a default nobody sent.
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  const refreshStats = useCallback(async (key: string) => {
    const data = await rpc.request<SessionStats>(key, { type: "get_session_stats" });
    if (data && keyRef.current === key) setStats(data);
  }, []);

  useEffect(() => {
    void rpc.connect();
    return rpc.onEvent((key, event) => {
      if (key !== keyRef.current) return;
      if ((event as { type?: string }).type === "response") return;
      const t = (event as { type?: string }).type;
      // Patched-prime only. This hook is the only place that knows which account
      // a session runs under, which is what the figure has to be attributed to.
      if (t === "rate_limits") {
        noteRateLimits(accountId ?? null, event as Record<string, unknown>);
        return;
      }
      // Dev only: prime emits event types this client has never seen a sample of
      // (child_usage_attributed among them). Printing the first of each is how
      // their shape gets verified instead of guessed.
      if (import.meta.env.DEV && t && !SEEN.has(t)) {
        SEEN.add(t);
        console.debug("[prime event]", t, JSON.stringify(event).slice(0, 900));
      }
      if (chatRef.current.retention.windowEnd < chatRef.current.retention.totalItems) {
        if (t === "agent_end") dispatch({ t: "busy", on: false });
        return;
      }
      dispatch({ t: "event", e: event });
      if (t === "turn_end" || t === "agent_end") void refreshStats(key);
    });
  }, [refreshStats, accountId]);

  useEffect(() => {
    return rpc.onExited((key) => {
      // Non-zero exits are normal for prime — mark idle, don't shout. Only ours:
      // another tab's child dying must not stop this tab's spinner.
      if (key === keyRef.current) dispatch({ t: "busy", on: false });
    });
  }, []);

  /**
   * Closing a tab lets go of the client. Daemon-backed, that is a **detach**:
   * the agent stays resident and reappears in Fleet, because silently killing
   * someone's running work is exactly what daemon sessions exist to prevent.
   * On a stock prime there is no daemon to hold it, so the child ends here.
   */
  useEffect(
    () => () => {
      const key = keyRef.current;
      if (!key) return;
      if (daemonRef.current) void rpc.detachSession(key);
      else void rpc.stopSession(key);
    },
    [],
  );

  /**
   * Work out which daemon agent a freshly started client landed on. The client
   * is never told its own agent id, and `sessionFile` is the only thing both it
   * and the listing report — so that is the join. Without this, "stop this
   * agent" would have nothing to stop and would quietly detach instead.
   *
   * Matched on the file, not the name: names are renamed to the first prompt
   * later on and can collide.
   */
  const identify = useCallback(async (key: string): Promise<string | null> => {
    const state = await rpc.request<AgentState>(key, { type: "get_state" });
    if (!state?.sessionFile || keyRef.current !== key) return null;
    void rpc.noteAgent(key, undefined, state.sessionFile);
    const fleet = await rpc.fleetList();
    const row = fleet.agents.find((a) => a.sessionFile === state.sessionFile);
    if (!row || keyRef.current !== key) return null;
    // The ref, not just the state: a caller awaiting this needs the answer now,
    // and React has not re-rendered yet.
    agentRef.current = row.id;
    setAgentId(row.id);
    void rpc.noteAgent(key, row.id, state.sessionFile);
    return row.id;
  }, []);

  /** Let go of the current client without ending the agent behind it. */
  const release = useCallback((key: string) => {
    if (daemonRef.current) void rpc.detachSession(key);
    else void rpc.stopSession(key);
  }, []);

  /**
   * Reattach to a running agent: `attach <id> --mode rpc`, then restore the
   * transcript from `get_messages` and the live pickers from `get_state`.
   */
  const attach = useCallback(
    async (agent: string) => {
      setStarting(true);
      const key = await rpc.attachSession(agent, accountId ?? undefined);
      setStarting(false);
      if (!key) return;
      keyRef.current = key;
      setSessionKey(key);
      setReadOnly(false);
      setAgentId(agent);
      historySourceRef.current = { kind: "live", key };
      const history = await rpc.request<{ messages: PrimeMessage[] }>(key, { type: "get_messages" });
      if (keyRef.current !== key) return;
      dispatch({ t: "load", messages: history?.messages ?? [] });
      const state = await rpc.request<AgentState>(key, { type: "get_state" });
      if (!state || keyRef.current !== key) return;
      if (state.model?.provider && state.model?.id) {
        setModel({ provider: state.model.provider, model: state.model.id });
      }
      if (state.thinkingLevel) setThinking(state.thinkingLevel);
      // A turn can be in flight on the agent while no client was attached.
      if (state.isStreaming) dispatch({ t: "busy", on: true });
      void rpc.noteAgent(key, agent, state.sessionFile);
      void refreshStats(key);
    },
    [accountId, refreshStats],
  );

  // Reattach once, on mount. StrictMode double-invokes effects, and a second
  // `attach` would spawn a second client onto the same agent.
  const attachedRef = useRef(false);
  useEffect(() => {
    const agent = defaults?.agent;
    if (!agent || attachedRef.current) return;
    attachedRef.current = true;
    void attach(agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults?.agent]);

  const ensure = useCallback(
    async (opts?: { cwd?: string; provider?: string; model?: string }): Promise<string | null> => {
      if (keyRef.current && !readOnly) return keyRef.current;
      setStarting(true);
      const key = await rpc.startSession({
        cwd: opts?.cwd ?? cwd ?? undefined,
        provider: opts?.provider ?? model?.provider,
        model: opts?.model ?? model?.model,
        accountId: accountId ?? undefined,
      });
      setStarting(false);
      if (key) {
        keyRef.current = key;
        setSessionKey(key);
        setReadOnly(false);
        historySourceRef.current = { kind: "live", key };
        // provider/model/cwd are spawn flags; the thinking level is not, so it
        // has to be sent or the picker and the child disagree.
        void rpc.send(key, { type: "set_thinking_level", level: thinkingRef.current });
        // A daemon agent outlives this window, so it needs a name someone can
        // find it by in `prime-agent list`, and the backend needs to know which
        // row is ours. Neither matters on a stock prime.
        if (daemonRef.current) {
          void rpc.send(key, { type: "set_session_name", name: nextAgentName() });
          void identify(key);
        }
      }
      return key;
    },
    [cwd, model, readOnly, accountId, identify],
  );

  /**
   * End the agent itself — `prime-agent stop`, not a client disconnect. The
   * client is only released *after* the stop lands: detaching first and finding
   * no agent id would leave the agent running while the UI claimed it had
   * stopped, which is the one outcome this whole distinction exists to prevent.
   */
  const endAgent = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return;
    // A session started here learns its id asynchronously; if the answer has not
    // arrived yet, ask now rather than failing quietly.
    if (!agentRef.current) await identify(key);
    const agent = agentRef.current;
    if (!agent) {
      dispatch({
        t: "notice",
        text: "Could not work out which daemon agent this is, so nothing was stopped. Stop it from Fleet.",
      });
      return;
    }
    await rpc.stopAgent(agent);
    release(key);
    keyRef.current = null;
    setSessionKey(null);
    setAgentId(null);
    historySourceRef.current = null;
  }, [release, identify]);

  const newChat = useCallback(
    async (opts?: { cwd?: string; provider?: string; model?: string }) => {
      const old = keyRef.current;
      // Reset means a NEW session, not the end of the old agent: daemon-backed it
      // stays in Fleet rather than vanishing because a tab was reused.
      if (old) release(old);
      keyRef.current = null;
      setSessionKey(null);
      setStats(null);
      setReadOnly(false);
      historySourceRef.current = null;
      dispatch({ t: "reset" });
      if (opts?.cwd) setCwdState(opts.cwd);
      if (opts?.provider && opts.model) setModel({ provider: opts.provider, model: opts.model });
      await ensure(opts);
    },
    [ensure],
  );

  const loadHistoryWindow = useCallback(async (endAt?: number) => {
    const source = historySourceRef.current;
    if (!source) return;
    const messages =
      source.kind === "live"
        ? (
            await rpc.request<{ messages: PrimeMessage[] }>(source.key, {
              type: "get_messages",
            })
          )?.messages ?? []
        : (/[\\/]/.test(source.id)
            ? await rpc.readChildSession(source.id)
            : await rpc.readDiskSession(source.id, source.accountId)
          )?.messages ?? [];
    if (source !== historySourceRef.current) return;
    dispatch({
      t: "load",
      messages,
      endAt,
      preserveChildren: source.kind === "live",
    });
  }, []);

  const showOlderMessages = useCallback(async () => {
    const endAt = chatRef.current.retention.windowStart;
    if (endAt <= 0) return;
    await loadHistoryWindow(endAt);
  }, [loadHistoryWindow]);

  const showLatestMessages = useCallback(async () => {
    await loadHistoryWindow();
  }, [loadHistoryWindow]);

  const prompt = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      void (async () => {
        if (chatRef.current.retention.windowEnd < chatRef.current.retention.totalItems) {
          await loadHistoryWindow();
        }
        dispatch({ t: "user", text });
        dispatch({ t: "busy", on: true });
        const key = await ensure();
        if (!key) {
          dispatch({ t: "busy", on: false });
          dispatch({ t: "notice", text: "No prime session — is the backend running?" });
          return;
        }
        await rpc.send(key, { type: "prompt", message: text });
      })();
    },
    [ensure, loadHistoryWindow],
  );

  const steer = useCallback((text: string) => {
    const key = keyRef.current;
    if (!key || !text.trim()) return;
    dispatch({ t: "user", text });
    void rpc.send(key, { type: "steer", message: text });
  }, []);

  const followUp = useCallback((text: string) => {
    const key = keyRef.current;
    if (!key || !text.trim()) return;
    // Queued, so it belongs in the transcript now but must not look like a steer.
    dispatch({ t: "user", text });
    dispatch({ t: "notice", text: "Queued — runs after this turn." });
    void rpc.send(key, { type: "follow_up", message: text });
  }, []);

  const abort = useCallback(() => {
    const key = keyRef.current;
    if (!key) return;
    void rpc.send(key, { type: "abort" });
    dispatch({ t: "busy", on: false });
  }, []);

  const compact = useCallback(() => {
    const key = keyRef.current;
    if (key) void rpc.send(key, { type: "compact" });
  }, []);

  const chooseModel = useCallback((provider: string, modelId: string) => {
    setModel({ provider, model: modelId });
    const key = keyRef.current;
    if (key) void rpc.send(key, { type: "set_model", provider, modelId });
  }, []);

  const chooseThinking = useCallback((level: ThinkingLevel) => {
    setThinking(level);
    const key = keyRef.current;
    if (key) void rpc.send(key, { type: "set_thinking_level", level });
  }, []);

  const setCwd = useCallback(
    async (dir: string) => {
      setCwdState(dir);
      // prime binds cwd at spawn, so switching directories restarts the session.
      await newChat({ cwd: dir });
    },
    [newChat],
  );

  const openDiskSession = useCallback(async (id: string) => {
    const old = keyRef.current;
    if (old) release(old);
    keyRef.current = null;
    setSessionKey(null);
    setStats(null);
    historySourceRef.current = { kind: "disk", id, accountId };
    // A subagent's transcript is addressed by directory, not by id — prime keeps
    // child sessions under session-artifacts/, outside the account's session
    // list. One entry point either way: both end up read-only.
    const content = /[\\/]/.test(id)
      ? await rpc.readChildSession(id)
      : await rpc.readDiskSession(id, accountId);
    dispatch({ t: "load", messages: content?.messages ?? [] });
    setReadOnly(true);
    const total = content?.usage_total;
    setStats(
      typeof total === "number"
        ? { cost: total }
        : total
          ? { cost: total.cost, tokens: undefined }
          : null,
    );
  }, [accountId]);

  // Rename the agent to what the session is actually about, so a Fleet row
  // reads like the work rather than like a counter. Same call prime's own
  // `rename` makes, so `prime-agent list` agrees with the window.
  const title = chat.retention.firstUserText;
  const namedRef = useRef("");
  useEffect(() => {
    const key = keyRef.current;
    if (!daemonRef.current || !key || !title || namedRef.current === title) return;
    namedRef.current = title;
    void rpc.send(key, { type: "set_session_name", name: title });
  }, [title]);

  return {
    sessionKey,
    chat,
    stats,
    starting,
    readOnly,
    agentId,
    daemon,
    endAgent,
    cwd,
    model,
    thinking,
    newChat,
    prompt,
    steer,
    followUp,
    abort,
    compact,
    chooseModel,
    chooseThinking,
    setCwd,
    openDiskSession,
    showOlderMessages,
    showLatestMessages,
  };
}

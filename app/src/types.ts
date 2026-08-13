// Prime-agent RPC types. Derived from PROTOCOL.md + rpc-shapes.json + the shipped
// CLI bundle (dist/bundle/chunk-PNKBOUZJ.js RPC handler, anthropic block builder).

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: CostBreakdown;
}

export interface TextBlock {
  type: "text";
  text: string;
  index?: number;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  signature?: string;
  redacted?: boolean;
  index?: number;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  partialJson?: string;
  index?: number;
}

export interface UnknownBlock {
  type: string;
  index?: number;
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | UnknownBlock;

export type MessageRole = "user" | "assistant" | "toolResult" | "system";

/** Result payload carried by tool_execution_end / toolResult messages. */
export interface ToolResult {
  content?: TextBlock[];
  details?: Record<string, unknown> & {
    status?: string;
    durationMs?: number;
    stdout?: string;
    stderr?: string;
  };
  isError?: boolean;
}

export interface PrimeMessage {
  role: MessageRole;
  content?: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  timestamp?: number;
  responseId?: string;
  // toolResult messages
  toolCallId?: string;
  toolName?: string;
  details?: ToolResult["details"];
  isError?: boolean;
}

export interface AssistantMessageEvent {
  type: string; // text_start | text_delta | thinking_start | toolcall_start | ...
  contentIndex?: number;
  delta?: string;
  toolCall?: ToolCallBlock;
}

// ---- Events (stdout, `type` at top level) -------------------------------

export type PrimeEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: PrimeMessage }
  | { type: "message_update"; message: PrimeMessage; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "message_end"; message: PrimeMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult?: ToolResult;
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError?: boolean }
  | { type: "turn_end"; message?: PrimeMessage; toolResults?: PrimeMessage[] }
  | { type: "agent_end"; messages?: PrimeMessage[] }
  | { type: "error"; message?: string; error?: string }
  | RpcResponse
  | { type: string; [k: string]: unknown };

export interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

// ---- Commands (stdin) ---------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: string[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "compact" }
  | { id?: string; type: string; [k: string]: unknown };

// ---- Response payloads --------------------------------------------------

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
}

export interface PrimeState {
  model?: { id: string; name: string; provider: string; contextWindow?: number };
  thinkingLevel?: ThinkingLevel;
  isStreaming?: boolean;
  sessionId?: string;
  sessionFile?: string;
}

// ---- Tauri invoke payloads ---------------------------------------------

/** Flattened model row from `list_models`. */
export interface ModelInfo {
  provider: string;
  model: string;
  context?: number;
  max_out?: number;
  thinking?: boolean;
  images?: boolean;
  name?: string;
}

/** Registry row from `~/.prime/profiles/accounts.json` — never holds a secret. */
export interface Account {
  id: string;
  label: string;
  provider: string;
  agentDir: string;
  createdAt: number;
}

export interface AccountRemovalEstimate {
  items: number;
  bytes: number;
  truncated: boolean;
}

export interface AccountRemovalChecks {
  activeSession: boolean;
  sharedProfile: boolean;
  defaultOrMigrated: boolean;
  storedPathMatches: boolean;
  directChild: boolean;
  reparsePoint: boolean;
  dataDeletionAllowed: boolean;
}

export type AccountRemovalBlocker =
  | "activeSession"
  | "sharedProfile"
  | "defaultOrMigrated"
  | "storedPathMismatch"
  | "unsafeTarget"
  | "reparsePoint"
  | "unsupportedPlatform";

/** Public, credential-free authority returned by `prepare_remove_account`. */
export interface AccountRemovalPlan {
  planId: string;
  accountLabel: string;
  targetPath: string;
  deleteData: boolean;
  expiresAtMs: number;
  registryGeneration: string;
  targetIdentity: { volume: number; file: number } | null;
  estimate: AccountRemovalEstimate;
  checks: AccountRemovalChecks;
  blockers: AccountRemovalBlocker[];
}

export type AccountDeletionErrorCode =
  | "accountNotFound"
  | "invalidAccountId"
  | "planNotFound"
  | "planExpired"
  | "planReplayed"
  | "planBlocked"
  | "planRequired"
  | "registryChanged"
  | "targetChanged"
  | "labelMismatch"
  | "quarantineConflict"
  | "recoveryRequired"
  | "outcomeUnknown"
  | "cleanupPending"
  | "registryInvalid"
  | "unsafeTarget"
  | "io";

/**
 * Auth health, derived in Rust (`auth_health`) so no two surfaces disagree.
 * `expiringSoon` means under three days of runway.
 */
export type AuthHealth = "signedIn" | "expiringSoon" | "expired" | "signedOut";

/** Presence + expiry only; token values never cross the bridge. */
export interface AccountStatus {
  authed: boolean;
  /** Epoch millis as a string, as stored in auth.json. */
  expires?: string | null;
  provider: string;
  health?: AuthHealth;
  /** Runway in millis; negative once expired. */
  expiresInMs?: number | null;
}

/** One row in the bounded native status poll. Unavailable never means signed out. */
export type AccountStatusSnapshot =
  | { accountId: string; available: true; status: AccountStatus }
  | { accountId: string; available: false; status: null };

/** The whole settings file. Paths, ids and preferences — never a credential. */
export interface AppSettings {
  cliPath?: string | null;
  /** "dark" | "light" | "system" */
  theme?: string | null;
  defaultAccount?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: string | null;
  defaultCwd?: string | null;
  lastSection?: string | null;
  fileOpenDestination?: string | null;
  language?: string | null;
  bottomPanel?: string | null;
  density?: string | null;
  reducedMotion?: string | null;
  sendShortcut?: string | null;
  promptSuggestions?: string | null;
  tokenEstimate?: string | null;
  drafts?: string | null;
  maxConcurrentAgents?: string | null;
  autonomousMaxTurns?: string | null;
  retrySilentWorkers?: string | null;
  contextDiscovery?: string | null;
  toolsEnabled?: string | null;
  gitAutoRefresh?: string | null;
  environmentMode?: string | null;
  telemetry?: string | null;
  crashReports?: string | null;
  localOnly?: string | null;
}

export interface LayoutPreferencesV1 {
  readonly schemaVersion: 1;
  readonly sidebarOpen: boolean;
  readonly sidebarWidth: number;
  readonly inspectorOpen: boolean;
  readonly inspectorWidth: number;
  readonly editorOpen: boolean;
  readonly editorWidth: number;
  /** Durable disclosure state, bounded and owned by the local Studio shell. */
  readonly expandedProjectIds: readonly string[];
}

/** Read-only scheduler availability projected by the native authority. */
export interface SchedulerProjection {
  schemaVersion: 1;
  revision: number | null;
  status: "planned" | "unavailable";
  dispatchAvailable: false;
}

/**
 * The interpreter behind prime's IPython tool. `ipykernel === null` means prime
 * cannot execute a single tool call — that is the state worth shouting about.
 */
export interface KernelStatus {
  python: string;
  source: string;
  exists: boolean;
  version?: string | null;
  ipykernel?: string | null;
  error?: string | null;
}

/**
 * Real Anthropic subscription utilization, from the `rate_limits` RPC event that
 * only a PATCHED prime-agent emits (verified payload: `utilization 0.84`,
 * `representativeWindow "seven_day"`). Stock prime never sends this, and there is
 * no other source — absence must render as "not reported", never as 0%.
 *
 * `utilization` is a 0..1 fraction here, unlike Codex's 0..100 `usedPercent`.
 */
export interface RateLimits {
  utilization?: number;
  representativeWindow?: string;
  /** Keyed by window name ("5h", "7d"); shapes beyond this are unverified. */
  windows?: Record<string, { utilization?: number; resetsAt?: number | string }>;
  /** When this client saw the event. */
  seenAt: number;
}

export interface UsageBucket {
  cost: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
  sessions: number;
}

export interface UsageReport {
  today: UsageBucket;
  week: UsageBucket;
  all: UsageBucket;
}

/**
 * One usage event from `account_usage_series`. `ts` is epoch millis — the UI
 * buckets it into local days, because the Rust side has no timezone.
 */
export interface UsageRow {
  ts: number;
  /** "anthropic" | "openai-codex" | "" when the log didn't say. */
  provider: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

/**
 * Real ChatGPT/Codex subscription quota, read out of the Codex CLI's own session
 * logs. `staleAsOf` is the log's mtime: the snapshot only moves when the Codex
 * CLI runs, so it MUST be rendered as "as of <time>", never as live.
 */
export interface CodexSubscription extends RateWindow {
  planType?: string | null;
  secondary?: RateWindow | null;
  staleAsOf: number;
}

/**
 * Where the backend found prime-agent's CLI. `path === null` with an `error` is a
 * state to render (prime-agent is not installed / not configured), not a crash:
 * `error` already lists every location that was tried.
 */
export interface CliStatus {
  path: string | null;
  source: string | null;
  /** Whether the Windows console shim was found next to cli.js. */
  shim: boolean;
  /** The saved setting, for prefilling the settings input. */
  configured: string | null;
  /**
   * Feature-detected from the resolved binary's own `--help`: this build takes
   * `-d`/`--background` and a headless `attach`, so sessions survive the window.
   * False on a stock prime — every daemon-shaped affordance degrades on it.
   */
  daemon: boolean;
  /** The `--daemon-socket` in force, when one is set. */
  daemonSocket: string | null;
  error: string | null;
}

/**
 * One row of `prime-agent list --json`. Every field here is reported by prime
 * itself — the view adds nothing it cannot source.
 */
export interface FleetAgent {
  id: string;
  name: string | null;
  /** prime's own status word. Printed verbatim, never re-mapped. */
  activity: string;
  lifecycle: string;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  contextWindow: number | null;
  messages: number;
  /** Attached clients right now — two are possible, so this is not "us or nobody". */
  clients: number;
  created: string | null;
  modified: string | null;
  lastActivity: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  firstMessage: string | null;
  summary: string | null;
  streaming: boolean;
  runningTools: boolean;
  runningChildren: boolean;
  queued: number;
  /** > 0 means a subagent: its spend is attributed to its parent. */
  depth: number;
  accountId: string | null;
  /** null when the transcript could not be read — unknown is not zero. */
  cost: number | null;
  tokens: number | null;
  attachedHere: boolean;
}

export interface FleetReport {
  agents: FleetAgent[];
  /** False on a stock prime: no daemon, so the only agents are this window's. */
  daemon: boolean;
  error: string | null;
}

export interface DiskSession {
  id: string;
  cwd?: string;
  timestamp?: number;
  title?: string;
  size?: number;
  mtime?: number;
}

export interface DiskSessionContent {
  messages: PrimeMessage[];
  usage_total?: number | { cost?: number; tokens?: number };
}

export interface WorkspaceFile {
  name: string;
  path: string;
  is_dir?: boolean;
  size?: number;
}

// ---- UI view model ------------------------------------------------------

export type ToolStatus = "running" | "ok" | "error";

export interface ToolState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** Latest output text, from partialResult while running or result at the end. */
  output: string;
  details?: ToolResult["details"];
  /**
   * 1-based position of this cell in the session, assigned by the reducer.
   * NOT IPython's own execution count — the protocol never sends that — so it is
   * rendered as "CELL 3" meaning "the third cell of this session".
   */
  cellNo: number;
}

/**
 * A subagent.
 *
 * Verified live (prime-agent 0.7.1) — spawning one emits:
 * ```
 * {"type":"rlm_child_update","child":{"id":"sub-ce91ee5c","label":"…",
 *  "model":"anthropic/claude-opus-5","sessionDir":"…\\sub-ce91ee5c",
 *  "sessionName":"probe-child","status":"queued"}}
 * ```
 * `status` is prime's own word for the child's phase, so the UI reports it
 * rather than guessing. Cost arrives separately on `child_usage_attributed`,
 * whose field names are still unverified and are therefore read defensively.
 */
export interface ChildState {
  id: string;
  name: string;
  model?: string;
  /** Prime's own status string: queued · running · returned · … */
  status: string;
  /** Dollars, attributed to the parent — never added to a session total twice. */
  cost: number;
  /** Directory holding the child's transcript; enables the read-only view. */
  sessionDir?: string;
  /** Cell that was in flight when prime first announced it — i.e. its spawner. */
  cell: number;
}

export type TimelineItem =
  | { kind: "user"; key: string; text: string }
  | {
      kind: "assistant";
      key: string;
      blocks: ContentBlock[];
      model?: string;
      provider?: string;
      cost?: number;
      streaming: boolean;
    }
  | { kind: "notice"; key: string; text: string };

/**
 * A file prime already edited, read from git rather than from the protocol —
 * prime emits no "files changed" event, and every edit is applied the moment it
 * runs. Never render this as an approval queue; the work is already done.
 */
export interface TouchedFile {
  path: string;
  added: number;
  removed: number;
  untracked: boolean;
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  decodeProviderProductSnapshot,
  projectProviderProductSnapshot,
  type ProviderProductProjection,
} from "./providerProduct";
import type {
  TouchedFile,
  Account,
  AccountDeletionErrorCode,
  AccountRemovalPlan,
  AccountStatus,
  AccountStatusSnapshot,
  AppSettings,
  CliStatus,
  CodexSubscription,
  DiskSession,
  DiskSessionContent,
  FleetReport,
  KernelStatus,
  ModelInfo,
  PrimeEvent,
  RpcCommand,
  RpcResponse,
  SchedulerProjection,
  UsageReport,
  UsageRow,
  WorkspaceFile,
} from "./types";

// The versioned Harness projection is the only new integration surface.
// Legacy session methods below remain isolated until verified activation.
export { bootstrapHarness, subscribeHarnessEvents } from "./shared/ipc/client";

type EventHandler = (sessionKey: string, event: PrimeEvent) => void;
type ExitHandler = (sessionKey: string, text: string) => void;
type TextHandler = (text: string) => void;

const eventHandlers = new Set<EventHandler>();
const stderrHandlers = new Set<TextHandler>();
const exitHandlers = new Set<ExitHandler>();
const errorHandlers = new Set<TextHandler>();

/** In-flight `send_rpc` commands awaiting a `type:"response"` on the event stream. */
const pending = new Map<string, (r: RpcResponse) => void>();

let seq = 0;
const nextId = () => `ui-${++seq}`;

function sub<T>(set: Set<T>, fn: T): () => void {
  set.add(fn);
  return () => set.delete(fn);
}

export const onEvent = (fn: EventHandler) => sub(eventHandlers, fn);
export const onStderr = (fn: TextHandler) => sub(stderrHandlers, fn);
export const onExited = (fn: ExitHandler) => sub(exitHandlers, fn);
export const onError = (fn: TextHandler) => sub(errorHandlers, fn);

function reportError(where: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  for (const fn of errorHandlers) fn(`${where}: ${msg}`);
}

/**
 * Every backend call goes through here: the Rust side is built in parallel, so a
 * missing command must degrade to `fallback` + a toast rather than crash the UI.
 */
async function safeInvoke<T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    reportError(cmd, e);
    return fallback;
  }
}

/** Report a backend failure to the UI without converting denial into success. */
async function strictInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    reportError(cmd, e);
    throw e;
  }
}

let wired: Promise<void> | null = null;

/** Idempotently attach the three Tauri event listeners. */
export function connect(): Promise<void> {
  if (wired) return wired;
  wired = (async () => {
    try {
      await listen<{ sessionKey: string; event: PrimeEvent }>("prime://event", (e) => {
        const { sessionKey, event } = e.payload;
        if (event && (event as RpcResponse).type === "response") {
          const res = event as RpcResponse;
          const resolve = res.id ? pending.get(res.id) : undefined;
          if (resolve && res.id) {
            pending.delete(res.id);
            resolve(res);
          }
        }
        for (const fn of eventHandlers) fn(sessionKey, event);
      });
      await listen<{ sessionKey?: string; line?: string } | string>("prime://stderr", (e) => {
        const p = e.payload;
        const text = typeof p === "string" ? p : (p?.line ?? "");
        if (text.trim()) for (const fn of stderrHandlers) fn(text);
      });
      // The key matters: several sessions run at once, so a handler must be able
      // to ignore exits that aren't its own.
      await listen<{ sessionKey?: string; code?: number } | string>("prime://exited", (e) => {
        const p = e.payload;
        const key = typeof p === "string" ? "" : (p?.sessionKey ?? "");
        const text = typeof p === "string" ? p : `prime exited (code ${p?.code ?? "?"})`;
        for (const fn of exitHandlers) fn(key, text);
      });
    } catch (e) {
      // Running outside Tauri (plain `vite dev`) — the UI still renders, just inert.
      reportError("event bridge", e);
    }
  })();
  return wired;
}

// ---- Session lifecycle --------------------------------------------------

export function startSession(opts: {
  provider?: string;
  model?: string;
  cwd?: string;
  /** Which login the child runs under. Fixed for the life of the session. */
  accountId?: string;
}): Promise<string | null> {
  return safeInvoke<string | null>("start_session", opts, null);
}

/** Reattach to an agent already running in the daemon. Needs `cli.daemon`. */
export function attachSession(agent: string, accountId?: string | null): Promise<string | null> {
  return safeInvoke<string | null>("attach_session", { agent, accountId }, null);
}

/**
 * Let go of a live agent: the client exits, the agent keeps running. This is
 * what closing a tab does. On a stock prime there is no daemon to hold it, so
 * the session ends here — which is why the UI only promises survival when
 * `cli.daemon` is true.
 */
export function detachSession(sessionKey: string): Promise<null> {
  return safeInvoke<null>("detach_session", { sessionKey }, null);
}

/** Kill this client. The agent behind it survives when daemon-backed. */
export function stopSession(sessionKey: string): Promise<null> {
  return safeInvoke<null>("stop_session", { sessionKey }, null);
}

/** Tell the backend which daemon agent a live client is driving. */
export const noteAgent = (sessionKey: string, agent?: string, sessionFile?: string) =>
  safeInvoke<null>("note_agent", { sessionKey, agent, sessionFile }, null);

// ---- Fleet --------------------------------------------------------------

const NO_FLEET: FleetReport = { agents: [], daemon: false, error: "backend unavailable" };

/** Everything the daemon is running, ours and everyone else's. */
export const fleetList = () => safeInvoke<FleetReport>("fleet_list", {}, NO_FLEET);

/** End an agent's work. Deliberate and confirmed — never what a closed tab does. */
export const stopAgent = (agent: string): Promise<string> =>
  invoke<string>("stop_agent", { agent });

export const renameAgent = (agent: string, name: string): Promise<string> =>
  invoke<string>("rename_agent", { agent, name });

/** Fire-and-forget: send a command without waiting for its response event. */
export function send(sessionKey: string, command: RpcCommand): Promise<null> {
  const withId = command.id ? command : { ...command, id: nextId() };
  return safeInvoke<null>("send_rpc", { sessionKey, command: withId }, null);
}

/**
 * Send a command and resolve with its `type:"response"` event, matched by id.
 * Resolves `null` on timeout so callers never hang.
 */
export function request<T>(sessionKey: string, command: RpcCommand, timeoutMs = 20000): Promise<T | null> {
  const id = command.id ?? nextId();
  const withId = { ...command, id } as RpcCommand;
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (res) => {
      clearTimeout(timer);
      if (!res.success) reportError(res.command, res.error ?? "command failed");
      resolve((res.data as T) ?? null);
    });
    void safeInvoke("send_rpc", { sessionKey, command: withId }, null);
  });
}

// ---- Plain invokes ------------------------------------------------------

export const listDiskSessions = (accountId?: string | null) =>
  safeInvoke<DiskSession[]>("list_disk_sessions", { accountId }, []);

export const readDiskSession = (id: string, accountId?: string | null) =>
  safeInvoke<DiskSessionContent | null>("read_disk_session", { id, accountId }, null);

/**
 * A subagent's transcript, read from the `sessionDir` its `rlm_child_update`
 * event reported. Child sessions live under `session-artifacts/`, so they have
 * no id the normal session list can resolve.
 */
export const readChildSession = (dir: string) =>
  safeInvoke<DiskSessionContent | null>("read_child_session", { dir }, null);

// ---- Accounts -----------------------------------------------------------

/** Native-owned provider/account admission truth; bridge/schema failures stay failures. */
export async function getProviderProductSnapshot(): Promise<ProviderProductProjection> {
  const snapshot = await strictInvoke<unknown>("get_provider_product_snapshot", {});
  return projectProviderProductSnapshot(decodeProviderProductSnapshot(snapshot));
}

export const listAccounts = () => safeInvoke<Account[]>("list_accounts", {}, []);

/** Mutations use this variant so an IPC failure cannot look like an empty registry. */
export const listAccountsStrict = () => invoke<Account[]>("list_accounts", {});

export const addAccount = (label: string, provider: string) =>
  safeInvoke<Account | null>("add_account", { label, provider }, null);

const ACCOUNT_DELETION_ERROR_CODES: ReadonlySet<AccountDeletionErrorCode> = new Set([
  "accountNotFound",
  "invalidAccountId",
  "planNotFound",
  "planExpired",
  "planReplayed",
  "planBlocked",
  "planRequired",
  "registryChanged",
  "targetChanged",
  "labelMismatch",
  "quarantineConflict",
  "recoveryRequired",
  "outcomeUnknown",
  "cleanupPending",
  "registryInvalid",
  "unsafeTarget",
  "io",
]);

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionErrorCode | "unknown";

  constructor(code: AccountDeletionErrorCode | "unknown") {
    super("Account removal failed.");
    this.name = "AccountDeletionError";
    this.code = code;
  }
}

function accountDeletionError(error: unknown): AccountDeletionError {
  if (error instanceof AccountDeletionError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && ACCOUNT_DELETION_ERROR_CODES.has(code as AccountDeletionErrorCode)) {
      return new AccountDeletionError(code as AccountDeletionErrorCode);
    }
  }
  return new AccountDeletionError("unknown");
}

/** Account deletion never uses `safeInvoke`: failure must stay a failure. */
export async function prepareRemoveAccount(
  id: string,
  deleteData: boolean,
): Promise<AccountRemovalPlan> {
  try {
    return await invoke<AccountRemovalPlan>("prepare_remove_account", { id, deleteData });
  } catch (error: unknown) {
    throw accountDeletionError(error);
  }
}

/** Commits only the opaque authority and the user's exact confirmation label. */
export async function commitRemoveAccount(planId: string, typedLabel: string): Promise<void> {
  try {
    await invoke<null>("commit_remove_account", { planId, typedLabel });
  } catch (error: unknown) {
    throw accountDeletionError(error);
  }
}

export const renameAccount = (id: string, label: string) =>
  safeInvoke<null>("rename_account", { id, label }, null);

const MAX_ACCOUNT_STATUS_IDS = 256;
const ACCOUNT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;
const RESERVED_ACCOUNT_IDS = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const STATUS_ROW_KEYS = ["accountId", "available", "status"] as const;
const STATUS_KEYS = ["authed", "expires", "provider", "health", "expiresInMs"] as const;
const AUTH_HEALTH = new Set(["signedIn", "expiringSoon", "expired", "signedOut"]);
const EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1_000;

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return null;
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function exactDataArray(value: unknown, expectedLength: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedLength + 1 ||
    !ownKeys.includes("length") ||
    ownKeys.some((key) =>
      typeof key !== "string" ||
      (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))
    )
  ) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== expectedLength) {
    return null;
  }
  const result: unknown[] = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function validAccountStatusRequest(ids: readonly string[]): boolean {
  return Array.isArray(ids) && ids.length <= MAX_ACCOUNT_STATUS_IDS && ids.every((id, index) =>
    typeof id === "string" &&
    ACCOUNT_ID.test(id) &&
    !RESERVED_ACCOUNT_IDS.has(id) &&
    ids.indexOf(id) === index
  );
}

function decodeAccountStatus(value: unknown): AccountStatus | null {
  const status = exactDataRecord(value, STATUS_KEYS);
  if (!status) return null;
  if (
    typeof status.authed !== "boolean" ||
    typeof status.provider !== "string" ||
    !PROVIDER_ID.test(status.provider) ||
    typeof status.health !== "string" ||
    !AUTH_HEALTH.has(status.health)
  ) return null;

  const expires = status.expires;
  const expiresInMs = status.expiresInMs;
  const canonicalExpiry = typeof expires === "string" && /^[1-9][0-9]{0,15}$/.test(expires);
  if (expires !== null && !canonicalExpiry) return null;
  if (expiresInMs !== null && (!Number.isSafeInteger(expiresInMs) || typeof expiresInMs !== "number")) {
    return null;
  }
  if ((expires === null) !== (expiresInMs === null)) return null;
  if (!status.authed) {
    if (status.health !== "signedOut" || expires !== null) return null;
  } else {
    if (status.health === "signedOut") return null;
    if (expires !== null && expiresInMs !== null) {
      const expiryMs = Number(expires);
      const observedAtMs = expiryMs - expiresInMs;
      if (
        !Number.isSafeInteger(expiryMs) ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0
      ) return null;
    }
    switch (status.health) {
      case "signedIn":
        if (expiresInMs !== null && expiresInMs <= EXPIRY_WARN_MS) return null;
        break;
      case "expiringSoon":
        if (expiresInMs === null || expiresInMs <= 0 || expiresInMs > EXPIRY_WARN_MS) return null;
        break;
      case "expired":
        if (expiresInMs === null || expiresInMs > 0) return null;
        break;
    }
  }

  return {
    authed: status.authed,
    expires: expires as string | null,
    provider: status.provider,
    health: status.health as AccountStatus["health"],
    expiresInMs: expiresInMs as number | null,
  };
}

function readAccountStatusSnapshot(
  value: unknown,
  ids: readonly string[],
): AccountStatusSnapshot[] {
  const snapshot = exactDataArray(value, ids.length);
  if (!snapshot) throw new Error();
  const requested = new Set(ids);
  const seen = new Set<string>();
  const rows: AccountStatusSnapshot[] = [];
  for (const valueRow of snapshot) {
    const row = exactDataRecord(valueRow, STATUS_ROW_KEYS);
    if (
      !row ||
      typeof row.accountId !== "string" ||
      !requested.has(row.accountId) ||
      seen.has(row.accountId) ||
      typeof row.available !== "boolean"
    ) throw new Error();
    seen.add(row.accountId);
    if (!row.available) {
      if (row.status !== null) throw new Error();
      rows.push({ accountId: row.accountId, available: false, status: null });
      continue;
    }
    const status = decodeAccountStatus(row.status);
    if (!status) throw new Error();
    rows.push({ accountId: row.accountId, available: true, status });
  }
  return rows;
}

function decodeAccountStatusSnapshot(value: unknown, ids: readonly string[]): AccountStatusSnapshot[] {
  try {
    // First prove that the entire bounded graph consists only of data properties.
    // Structured cloning can otherwise invoke getters on ordinary objects. The
    // second pass consumes a detached graph; structured clone rejects Proxy
    // exotic objects even when their non-throwing traps fabricate a valid view.
    readAccountStatusSnapshot(value, ids);
    const detached = structuredClone(value);
    return readAccountStatusSnapshot(detached, ids);
  } catch {
    throw new Error("account status snapshot is invalid");
  }
}

/** One strict bridge call for the complete bounded account-status poll. */
export async function accountStatuses(ids: string[]): Promise<AccountStatusSnapshot[]> {
  if (!validAccountStatusRequest(ids)) throw new Error("account status request is invalid");
  const snapshot = await strictInvoke<unknown>("account_statuses", { ids });
  return decodeAccountStatusSnapshot(snapshot, ids);
}

/**
 * Opens a visible console so the user can run `/login` and finish browser OAuth.
 * Off Windows the backend cannot drive a terminal, so it *errors* with the exact
 * command to run — the caller must show that text inline, not as a toast, since
 * the user has to copy it.
 */
export const beginAccountLogin = (id: string): Promise<null> =>
  invoke<null>("begin_account_login", { id });

/** `since` is the cutoff for the `today` bucket — pass local midnight. */
export const accountUsage = (id: string, since?: number) =>
  safeInvoke<UsageReport | null>("account_usage", { id, since }, null);

/** Per-event usage rows for the last `days` days — the usage page's chart source. */
export const accountUsageSeries = (id: string, days: number) =>
  safeInvoke<UsageRow[]>("account_usage_series", { id, days }, []);

/** Real ChatGPT quota snapshot from the Codex CLI's logs; null when it has never run. */
export const codexSubscriptionUsage = () =>
  safeInvoke<CodexSubscription | null>("codex_subscription_usage", {}, null);

export const listModels = () => safeInvoke<ModelInfo[]>("list_models", {}, []);

// ---- prime-agent CLI location -------------------------------------------

const CLI_UNAVAILABLE: CliStatus = {
  path: null,
  source: null,
  shim: false,
  configured: null,
  daemon: false,
  daemonSocket: null,
  error: "backend unavailable",
};

export const resolvePrimeCli = () =>
  safeInvoke<CliStatus>("resolve_prime_cli", {}, CLI_UNAVAILABLE);

/** Empty/null clears the setting, which is how "Detect" falls back to autodetection. */
export const setPrimeCli = (path: string | null) =>
  safeInvoke<CliStatus>("set_prime_cli", { path }, CLI_UNAVAILABLE);

/** `node <cli> --version`. Throws the backend's message so the UI can show it. */
export const checkPrimeCli = (path: string | null): Promise<string> =>
  invoke<string>("check_prime_cli", { path });

// ---- app settings -------------------------------------------------------

export const getAppSettings = () => safeInvoke<AppSettings>("get_app_settings", {}, {});

/** Native-owned status only. Failure remains failure so the UI cannot invent scheduler state. */
export const schedulerProjection = () =>
  strictInvoke<SchedulerProjection>("scheduler_projection", {});

/** `null`/empty clears the key. Returns the whole file back. */
export const setAppSetting = (key: keyof AppSettings, value: string | null) =>
  strictInvoke<AppSettings>("set_app_setting", { key, value });

// ---- Windows computer-use readiness ------------------------------------

export type ComputerUseReadinessStatus = "unavailable" | "admission_only";

export interface ComputerUseReadinessProjection {
  readonly effectClass: "windows_computer_use";
  readonly status: ComputerUseReadinessStatus;
  readonly policyVersion: 3;
  readonly authorityBound: boolean;
  readonly brokerInstanceId: string | null;
  readonly authorityDigest: string | null;
  readonly workerStatus: "unavailable";
  readonly effectDispatch: "unavailable";
  readonly canDispatch: false;
}

const COMPUTER_USE_READINESS_KEYS = [
  "effectClass",
  "status",
  "policyVersion",
  "authorityBound",
  "brokerInstanceId",
  "authorityDigest",
  "workerStatus",
  "effectDispatch",
  "canDispatch",
] as const;

const COMPUTER_USE_UNAVAILABLE: ComputerUseReadinessProjection = Object.freeze({
  effectClass: "windows_computer_use",
  status: "unavailable",
  policyVersion: 3,
  authorityBound: false,
  brokerInstanceId: null,
  authorityDigest: null,
  workerStatus: "unavailable",
  effectDispatch: "unavailable",
  canDispatch: false,
});

function decodeComputerUseReadiness(value: unknown): ComputerUseReadinessProjection | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== COMPUTER_USE_READINESS_KEYS.length ||
      keys.some((key) =>
        typeof key !== "string" ||
        !COMPUTER_USE_READINESS_KEYS.includes(key as (typeof COMPUTER_USE_READINESS_KEYS)[number]))
    ) return null;

    const record: Record<string, unknown> = {};
    for (const key of COMPUTER_USE_READINESS_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    if (
      record.effectClass !== "windows_computer_use" ||
      (record.status !== "unavailable" && record.status !== "admission_only") ||
      record.policyVersion !== 3 ||
      typeof record.authorityBound !== "boolean" ||
      record.workerStatus !== "unavailable" ||
      record.effectDispatch !== "unavailable" ||
      record.canDispatch !== false
    ) return null;

    const unavailable = record.status === "unavailable";
    if (unavailable) {
      if (
        record.authorityBound !== false ||
        record.brokerInstanceId !== null ||
        record.authorityDigest !== null
      ) return null;
    } else if (
      record.authorityBound !== true ||
      typeof record.brokerInstanceId !== "string" ||
      record.brokerInstanceId.length === 0 ||
      record.brokerInstanceId.length > 128 ||
      typeof record.authorityDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(record.authorityDigest)
    ) return null;

    return Object.freeze({
      effectClass: "windows_computer_use",
      status: record.status,
      policyVersion: 3,
      authorityBound: record.authorityBound,
      brokerInstanceId: record.brokerInstanceId as string | null,
      authorityDigest: record.authorityDigest as string | null,
      workerStatus: "unavailable",
      effectDispatch: "unavailable",
      canDispatch: false,
    });
  } catch {
    return null;
  }
}

/** Read-only projection. There is intentionally no computer-use effect RPC. */
export async function getComputerUseReadiness(): Promise<ComputerUseReadinessProjection> {
  const value = await safeInvoke<unknown>("computer_use_readiness", {}, null);
  return decodeComputerUseReadiness(value) ?? COMPUTER_USE_UNAVAILABLE;
}

const KERNEL_UNAVAILABLE: KernelStatus = {
  python: "",
  source: "",
  exists: false,
  error: "backend unavailable",
};

export const kernelStatus = () =>
  safeInvoke<KernelStatus>("kernel_status", {}, KERNEL_UNAVAILABLE);

export const pickDirectory = () => safeInvoke<string | null>("pick_directory", {}, null);

export const listWorkspaceFiles = (dir: string) =>
  safeInvoke<WorkspaceFile[] | string[]>("list_workspace_files", { dir }, []);

export const readWorkspaceFile = (path: string) =>
  safeInvoke<string | null>("read_workspace_file", { path }, null);

/** http/https only — the backend refuses anything else. */
export const openExternal = (url: string) => safeInvoke<null>("open_external", { url }, null);

/** Files prime already changed in the session's folder. Empty outside a git repo. */
export const filesTouched = (cwd: string) =>
  safeInvoke<TouchedFile[]>("files_touched", { cwd }, []);

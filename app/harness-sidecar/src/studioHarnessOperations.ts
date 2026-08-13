export const STUDIO_HARNESS_ACTIONS = Object.freeze([
  "conversation.user-version.create",
  "conversation.response.regenerate",
  "conversation.branch.create",
  "conversation.files.review",
  "conversation.archive-fork",
  "conversation.history.page",
  "composer.model.select",
  "composer.thinking.select",
  "composer.slash.execute",
  "harness.session.prompt",
  "harness.session.follow-up",
  "harness.session.steer",
  "harness.session.abort",
  "harness.session.export",
  "harness.session.compact",
  "harness.child.stop",
  "harness.child.transcript-page",
  "harness.queue.run-now",
  "harness.queue.remove",
  "harness.tool.set-enabled",
  "harness.context-source.open",
  "harness.overload.retry",
  "harness.extension.respond",
  "usage.current.refresh",
  "activity.file.open",
  "editor.artifact.open",
  "settings.harness-policy.set",
  "settings.tool.set-enabled",
] as const);

export type StudioHarnessAction = typeof STUDIO_HARNESS_ACTIONS[number];
export type StudioHarnessOperationOutcome =
  | Readonly<{ status: "accepted"; commandId: string }>
  | Readonly<{ status: "queued"; commandId: string; position: number | null }>
  | Readonly<{ status: "updated"; revision: string | number; data?: unknown }>
  | Readonly<{ status: "cancelled"; commandId: string | null }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "rejected"; reason: string; retryable: boolean }>
  | Readonly<{ status: "unknown_outcome"; operationId: string; reason: string }>;

export interface StudioHarnessOperation {
  readonly operationId: string;
  readonly action: StudioHarnessAction;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expectedCursor: Readonly<{ runtimeGeneration: string; sequence: number }> | null;
  readonly idempotencyKey: string | null;
}

// Deliberately bivariant at the adapter edge: the dispatcher validates each
// action payload before invoking the structurally supplied upstream method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncMethod = (...arguments_: any[]) => Promise<unknown>;
export interface StudioHarnessOperationPort {
  readonly connection: Readonly<Record<string, AsyncMethod | undefined>>;
  readonly currentCursor: Readonly<{ runtimeGeneration: string; sequence: number }>;
  /** Atomic mutation-barrier snapshot used to bind an identity-sensitive command. */
  readonly preOperationSnapshot?: unknown;
  /** Publishes a reconciled barrier snapshot without taking a second unrelated snapshot. */
  readonly publishPostconditionSnapshot?: (source: unknown) => Promise<unknown>;
  readonly respondToExtensionUiRequest?: (requestId: string, response: unknown) => Promise<unknown>;
}

const ACTIONS = new Set<string>(STUDIO_HARNESS_ACTIONS);
const PAYLOAD_KEYS: Readonly<Record<StudioHarnessAction, readonly string[]>> = Object.freeze({
  "conversation.user-version.create": ["chatId", "messageId", "text"],
  "conversation.response.regenerate": ["sessionId", "messageId"],
  "conversation.branch.create": ["sessionId", "messageId"],
  "conversation.files.review": ["sessionId", "activityId"],
  "conversation.archive-fork": ["chatId"],
  "conversation.history.page": ["chatId", "before"],
  "composer.model.select": ["chatId", "modelId"],
  "composer.thinking.select": ["chatId", "level"],
  "composer.slash.execute": ["chatId", "commandId", "argument"],
  "harness.session.prompt": ["sessionId", "text"],
  "harness.session.follow-up": ["sessionId", "text"],
  "harness.session.steer": ["sessionId", "text"],
  "harness.session.abort": ["sessionId"],
  "harness.session.export": ["sessionId", "format"],
  "harness.session.compact": ["sessionId"],
  "harness.child.stop": ["sessionId", "childId"],
  "harness.child.transcript-page": ["sessionId", "childId", "before"],
  "harness.queue.run-now": ["sessionId", "queueItemId"],
  "harness.queue.remove": ["sessionId", "queueItemId"],
  "harness.tool.set-enabled": ["sessionId", "toolId", "enabled"],
  "harness.context-source.open": ["sessionId", "sourceId"],
  "harness.overload.retry": ["sessionId", "errorId"],
  "harness.extension.respond": ["sessionId", "requestId", "response"],
  "usage.current.refresh": ["sessionId"],
  "activity.file.open": ["sessionId", "activityId", "fileId"],
  "editor.artifact.open": ["sessionId", "artifactId"],
  "settings.harness-policy.set": ["key", "value"],
  "settings.tool.set-enabled": ["toolId", "enabled"],
});
const MUTATING = new Set<StudioHarnessAction>([
  "conversation.user-version.create", "conversation.response.regenerate", "conversation.branch.create",
  "conversation.archive-fork", "composer.model.select", "composer.thinking.select", "composer.slash.execute",
  "harness.session.prompt", "harness.session.follow-up", "harness.session.steer", "harness.session.abort",
  "harness.session.export", "harness.session.compact", "harness.child.stop", "harness.queue.run-now",
  "harness.queue.remove", "harness.tool.set-enabled", "harness.overload.retry", "harness.extension.respond",
  "settings.harness-policy.set", "settings.tool.set-enabled",
]);
const EXPLICITLY_UNSUPPORTED = new Map<StudioHarnessAction, string>([
  ["conversation.user-version.create", "Prime Harness exposes fork-at-entry, not in-place user message version creation."],
  ["conversation.response.regenerate", "Prime Harness exposes fork-at-entry, but no atomic response-regeneration command."],
  ["conversation.archive-fork", "Prime Harness exposes fork and new-session independently, but no atomic archive-and-fork command."],
  ["harness.queue.run-now", "Prime Harness exposes queued input ordering but no verified run-now command."],
  ["harness.queue.remove", "Prime Harness exposes clear-all queue operations but no verified single-item removal command."],
  ["harness.tool.set-enabled", "Prime Harness exposes tool definitions but no per-session live enable mutation."],
  ["settings.tool.set-enabled", "Prime Harness exposes tool definitions but no global live enable mutation."],
  ["settings.harness-policy.set", "Harness policy persistence belongs to Studio settings, not the daemon connection."],
  ["harness.context-source.open", "Opening a context source requires Studio artifact authorization."],
  ["harness.overload.retry", "The installed Harness exposes retry cancellation and worker restart, but no verified retry-by-error operation."],
  ["activity.file.open", "Opening activity artifacts requires Studio artifact authorization."],
  ["editor.artifact.open", "Opening editor artifacts requires Studio artifact authorization."],
  ["composer.slash.execute", "Composer slash commands are routed by Studio to their exact reviewed operation; raw slash text is not admitted as a prompt."],
]);

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function id(value: unknown): value is string { return typeof value === "string" && /^[!-~]{1,128}$/u.test(value); }
function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("text is invalid");
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new TypeError("text is invalid");
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) throw new TypeError("text is invalid");
    if (++count > 131_072) throw new TypeError("text is invalid");
  }
  return value;
}
function field(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (!id(value)) throw new TypeError(`${key} is invalid`);
  return value;
}
function cursor(value: unknown): value is StudioHarnessOperation["expectedCursor"] {
  return plain(value) && exactKeys(value, ["runtimeGeneration", "sequence"]) && id(value.runtimeGeneration)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0;
}

function safeJsonValue(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 10_000 || depth > 64) return false;
    if (typeof value === "string") { try { text(value); } catch { return false; } continue; }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; }
    if (Array.isArray(value)) { for (const item of value) pending.push({ value: item, depth: depth + 1 }); continue; }
    if (!plain(value) || Object.keys(value).length > 1_024) return false;
    for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
  }
  return true;
}

function validPayload(action: StudioHarnessAction, payload: Record<string, unknown>): boolean {
  if (!exactKeys(payload, PAYLOAD_KEYS[action])) return false;
  for (const [key, value] of Object.entries(payload)) {
    if (key === "response") { if (!safeJsonValue(value)) return false; continue; }
    if (key === "enabled") { if (typeof value !== "boolean") return false; continue; }
    if (key === "value") { if (!(typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) return false; continue; }
    if (key === "activityId" || key === "before") { if (value !== null && !id(value)) return false; continue; }
    if (key === "text" || key === "argument") { try { text(value); } catch { return false; } continue; }
    if (key === "format") { if (value !== "html" && value !== "jsonl") return false; continue; }
    if (!id(value)) return false;
  }
  return true;
}

export function parseStudioHarnessOperation(value: unknown): StudioHarnessOperation | null {
  if (!plain(value) || !exactKeys(value, ["operationId", "action", "payload", "expectedCursor", "idempotencyKey"])) return null;
  if (!id(value.operationId) || typeof value.action !== "string" || !ACTIONS.has(value.action) || !plain(value.payload)) return null;
  if (Object.keys(value.payload).length > 32 || (value.expectedCursor !== null && !cursor(value.expectedCursor))) return null;
  if (value.idempotencyKey !== null && !id(value.idempotencyKey)) return null;
  const action = value.action as StudioHarnessAction;
  if (!validPayload(action, value.payload)) return null;
  if (MUTATING.has(action) && (!value.expectedCursor || value.idempotencyKey === null)) return null;
  return value as unknown as StudioHarnessOperation;
}

async function invoke(port: StudioHarnessOperationPort, method: string, ...arguments_: unknown[]): Promise<unknown> {
  const candidate = port.connection[method];
  if (typeof candidate !== "function") throw new ReferenceError(`upstream method ${method} is unavailable`);
  return candidate.apply(port.connection, arguments_);
}

async function selectModel(port: StudioHarnessOperationPort, selector: string): Promise<unknown> {
  const catalog = await invoke(port, "getModelCatalog");
  if (!plain(catalog) || !Array.isArray(catalog.models)) throw new ReferenceError("upstream model catalog is unavailable");
  const matches = catalog.models.filter((model) => plain(model)
    && typeof model.id === "string"
    && typeof model.provider === "string"
    && `${model.provider}/${model.id}` === selector);
  if (matches.length !== 1) throw new ReferenceError("The selected model is absent or ambiguous in the verified model catalog.");
  return invoke(port, "setModel", matches[0]!.provider, matches[0]!.id);
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

async function selectThinking(port: StudioHarnessOperationPort, level: string): Promise<unknown> {
  const state = await invoke(port, "getState");
  if (!plain(state) || !Array.isArray(state.availableThinkingLevels)) {
    throw new ReferenceError("upstream supported thinking levels are unavailable");
  }
  const available = new Set(state.availableThinkingLevels.filter((candidate): candidate is string =>
    typeof candidate === "string" && THINKING_LEVELS.has(candidate),
  ));
  if (!available.has(level)) throw new ReferenceError("The selected thinking level is not supported by the verified active model.");
  return invoke(port, "setThinkingLevel", level);
}

async function childTranscript(port: StudioHarnessOperationPort, childId: string): Promise<unknown> {
  const snapshot = await invoke(port, "getInitialSnapshot");
  if (!plain(snapshot) || !Array.isArray(snapshot.children)) throw new ReferenceError("upstream child catalog is unavailable");
  const child = snapshot.children.find((candidate) => plain(candidate) && candidate.id === childId);
  if (!plain(child) || typeof child.activeSessionId !== "string") throw new ReferenceError("child transcript attachment is unavailable");
  const watcher = await invoke(port, "watchSession", child.activeSessionId);
  if (!plain(watcher) || typeof watcher.getMessages !== "function" || typeof watcher.close !== "function") throw new ReferenceError("child transcript watcher is unavailable");
  try { return await (watcher.getMessages as () => Promise<unknown[]>).call(watcher); }
  finally { await (watcher.close as () => Promise<void>).call(watcher); }
}

interface ChildCancellationIdentity {
  readonly id: string;
  readonly activeSessionId: string;
}

function snapshotGeneration(value: Record<string, unknown>): string {
  if (!plain(value.lastEventCursor) || !id(value.lastEventCursor.generation)
    || !Number.isSafeInteger(value.lastEventCursor.sequence) || (value.lastEventCursor.sequence as number) < 0) {
    throw new TypeError("Authoritative child snapshot cursor is invalid.");
  }
  return value.lastEventCursor.generation;
}

function snapshotRootSessionId(value: Record<string, unknown>): string {
  if (!plain(value.state) || !id(value.state.activeSessionId)) throw new TypeError("Authoritative root session identity is invalid.");
  return value.state.activeSessionId;
}

function exactChild(value: Record<string, unknown>, childId: string): ChildCancellationIdentity & Readonly<Record<string, unknown>> {
  if (!Array.isArray(value.children)) throw new TypeError("Authoritative child catalog is invalid.");
  const matches = value.children.filter((candidate) => plain(candidate) && candidate.id === childId);
  if (matches.length !== 1 || !plain(matches[0]) || !id(matches[0].activeSessionId)) {
    throw new TypeError("The exact child identity is absent or ambiguous.");
  }
  return matches[0] as ChildCancellationIdentity & Readonly<Record<string, unknown>>;
}

async function cancelChildWithPostcondition(
  port: StudioHarnessOperationPort,
  operation: StudioHarnessOperation,
): Promise<StudioHarnessOperationOutcome> {
  if (!plain(port.preOperationSnapshot) || !port.publishPostconditionSnapshot) {
    return { status: "unavailable", reason: "Atomic child cancellation reconciliation is unavailable." };
  }
  const sessionId = field(operation.payload, "sessionId");
  const childId = field(operation.payload, "childId");
  let before: ChildCancellationIdentity & Readonly<Record<string, unknown>>;
  let generation: string;
  try {
    if (snapshotRootSessionId(port.preOperationSnapshot) !== sessionId) throw new TypeError("The child is not bound to the requested root session.");
    generation = snapshotGeneration(port.preOperationSnapshot);
    if (generation !== operation.expectedCursor!.runtimeGeneration) throw new TypeError("The child cancellation cursor changed before admission.");
    before = exactChild(port.preOperationSnapshot, childId);
    if (before.status !== "queued" && before.status !== "running") throw new TypeError("The exact child is not cancellable.");
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : "The exact child cancellation precondition is invalid.", retryable: false };
  }

  let after: Record<string, unknown>;
  try {
    await invoke(port, "cancelRlmChild", childId);
    const raw = await invoke(port, "getInitialSnapshot");
    if (!plain(raw)) throw new TypeError("Authoritative child postcondition snapshot is invalid.");
    after = raw;
    if (snapshotRootSessionId(after) !== sessionId || snapshotGeneration(after) !== generation) {
      return { status: "unknown_outcome", operationId: operation.operationId, reason: "Runtime generation or root session identity changed while cancelling the child." };
    }
    if (!Array.isArray(after.children)) throw new TypeError("Authoritative child postcondition catalog is invalid.");
    const matches = after.children.filter((candidate) => plain(candidate) && candidate.id === childId);
    if (matches.length > 1) return { status: "unknown_outcome", operationId: operation.operationId, reason: "The child cancellation postcondition is ambiguous." };
    if (matches.length === 1) {
      const candidate = matches[0]!;
      if (!plain(candidate) || candidate.activeSessionId !== before.activeSessionId) {
        return { status: "unknown_outcome", operationId: operation.operationId, reason: "The child identity changed while cancellation was being reconciled." };
      }
      if (candidate.status !== "done" && candidate.status !== "error" && candidate.status !== "cancelled") {
        return { status: "unknown_outcome", operationId: operation.operationId, reason: "Prime acknowledged child cancellation, but the exact child is still non-terminal." };
      }
    }
    const projection = await port.publishPostconditionSnapshot(after);
    return { status: "updated", revision: port.currentCursor.sequence + 1, data: projection };
  } catch {
    return { status: "unknown_outcome", operationId: operation.operationId, reason: "Prime child cancellation was admitted, but its authoritative postcondition could not be proven." };
  }
}

export async function dispatchStudioHarnessOperation(port: StudioHarnessOperationPort, raw: unknown): Promise<StudioHarnessOperationOutcome> {
  const operation = parseStudioHarnessOperation(raw);
  if (!operation) return { status: "rejected", reason: "Studio Harness operation envelope is invalid.", retryable: false };
  const unsupported = EXPLICITLY_UNSUPPORTED.get(operation.action);
  if (unsupported) return { status: "unavailable", reason: unsupported };
  if (operation.expectedCursor && (
    operation.expectedCursor.runtimeGeneration !== port.currentCursor.runtimeGeneration
    || operation.expectedCursor.sequence !== port.currentCursor.sequence
  )) return { status: "rejected", reason: "Session cursor changed.", retryable: true };

  const p = operation.payload;
  try {
    let data: unknown;
    switch (operation.action) {
      case "conversation.branch.create": data = await invoke(port, "fork", field(p, "messageId"), { position: "at" }); break;
      case "conversation.files.review": data = await invoke(port, "getResourceSnapshot"); break;
      case "conversation.history.page": data = await invoke(port, "getMessages"); break;
      case "composer.model.select": data = await selectModel(port, field(p, "modelId")); break;
      case "composer.thinking.select": data = await selectThinking(port, field(p, "level")); break;
      case "harness.session.prompt": data = await invoke(port, "prompt", text(p.text)); return { status: "accepted", commandId: operation.idempotencyKey! };
      case "harness.session.follow-up": data = await invoke(port, "followUp", text(p.text)); return { status: "queued", commandId: operation.idempotencyKey!, position: null };
      case "harness.session.steer": data = await invoke(port, "steer", text(p.text)); return { status: "accepted", commandId: operation.idempotencyKey! };
      case "harness.session.abort": data = await invoke(port, "abort"); return { status: "cancelled", commandId: operation.idempotencyKey };
      case "harness.session.export": data = p.format === "html" ? await invoke(port, "exportToHtml") : p.format === "jsonl" ? await invoke(port, "exportToJsonl") : (() => { throw new TypeError("format is invalid"); })(); break;
      case "harness.session.compact": data = await invoke(port, "compact"); break;
      case "harness.child.stop": return cancelChildWithPostcondition(port, operation);
      case "harness.child.transcript-page": data = await childTranscript(port, field(p, "childId")); break;
      case "harness.extension.respond": {
        if (!port.respondToExtensionUiRequest) throw new ReferenceError("verified extension UI response admission is unavailable");
        data = await port.respondToExtensionUiRequest(field(p, "requestId"), p.response);
        break;
      }
      case "usage.current.refresh": data = await invoke(port, "getSessionStats"); break;
      default: return { status: "unavailable", reason: "Action has no verified daemon implementation." };
    }
    return { status: "updated", revision: port.currentCursor.sequence + 1, ...(data === undefined ? {} : { data }) };
  } catch (error) {
    if (error instanceof ReferenceError) return { status: "unavailable", reason: error.message };
    if (error instanceof TypeError) return { status: "rejected", reason: error.message, retryable: false };
    return { status: "unknown_outcome", operationId: operation.operationId, reason: "Daemon operation outcome could not be proven." };
  }
}

interface PriorOperation {
  readonly fingerprint: string;
  readonly outcome: StudioHarnessOperationOutcome;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export class StudioHarnessOperationDispatcher {
  readonly #byOperationId = new Map<string, PriorOperation>();
  readonly #byIdempotencyKey = new Map<string, PriorOperation>();

  async dispatch(port: StudioHarnessOperationPort, raw: unknown): Promise<StudioHarnessOperationOutcome> {
    const operation = parseStudioHarnessOperation(raw);
    if (!operation) return { status: "rejected", reason: "Studio Harness operation envelope is invalid.", retryable: false };
    const fingerprint = JSON.stringify(canonical({ action: operation.action, payload: operation.payload, expectedCursor: operation.expectedCursor }));
    const prior = this.#byOperationId.get(operation.operationId)
      ?? (operation.idempotencyKey ? this.#byIdempotencyKey.get(operation.idempotencyKey) : undefined);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { status: "rejected", reason: "Operation identity was reused with different input.", retryable: false };
      return prior.outcome;
    }
    if (this.#byOperationId.size >= 4096 || (operation.idempotencyKey && this.#byIdempotencyKey.size >= 4096)) {
      return { status: "rejected", reason: "Operation replay ledger capacity is exhausted; reattach to reconcile the session.", retryable: true };
    }
    const outcome = await dispatchStudioHarnessOperation(port, operation);
    const record = Object.freeze({ fingerprint, outcome });
    this.#byOperationId.set(operation.operationId, record);
    if (operation.idempotencyKey) this.#byIdempotencyKey.set(operation.idempotencyKey, record);
    return outcome;
  }
}

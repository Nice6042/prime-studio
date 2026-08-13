import { invoke } from "@tauri-apps/api/core";

const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 4_096;

export interface ChatDisplayRecord {
  readonly chatId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly content: string;
}

export interface ChatDisplaySnapshot {
  readonly schemaVersion: 1;
  readonly records: readonly ChatDisplayRecord[];
}

export interface ChatDisplayApplyRequest {
  readonly chatId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly content: string;
}

function fail(): never { throw new Error("Chat display unavailable."); }

function preflight(value: unknown, depth = 0, budget = { nodes: 0 }, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (depth > 32 || ++budget.nodes > 10_000 || seen.has(value)) return fail();
  seen.add(value);
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return fail(); }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) return fail();
    preflight(descriptor.value, depth + 1, budget, seen);
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value.trim() === value && /^[\x20-\x7e]+$/.test(value);
}

function validContent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && new TextEncoder().encode(value).byteLength <= MAX_CONTENT_BYTES
    && !/[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function decodeRecord(value: unknown): ChatDisplayRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "chatId,content,messageId,revision"
    || !validId(source.chatId) || !validId(source.messageId) || !validContent(source.content)
    || !Number.isSafeInteger(source.revision) || (source.revision as number) < 2) return fail();
  return Object.freeze({ chatId: source.chatId, messageId: source.messageId, revision: source.revision as number, content: source.content });
}

export function decodeChatDisplaySnapshot(value: unknown): ChatDisplaySnapshot {
  try { preflight(value); value = structuredClone(value); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "records,schemaVersion" || source.schemaVersion !== 1 || !Array.isArray(source.records) || source.records.length > MAX_RECORDS) return fail();
  let serialized: string;
  try { serialized = JSON.stringify(source); } catch { return fail(); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TRANSPORT_BYTES) return fail();
  const records = source.records.map(decodeRecord);
  const keys = new Set(records.map((record) => `${record.chatId}\u0000${record.messageId}`));
  if (keys.size !== records.length) return fail();
  return Object.freeze({ schemaVersion: 1, records: Object.freeze(records) });
}

export async function loadChatDisplayRevisions(): Promise<ChatDisplaySnapshot> {
  return decodeChatDisplaySnapshot(await invoke("chat_display_load"));
}

export async function applyChatDisplayRevision(request: ChatDisplayApplyRequest): Promise<ChatDisplayRecord> {
  let detached: ChatDisplayApplyRequest;
  try { preflight(request); detached = structuredClone(request); } catch { return fail(); }
  if (!validId(detached.chatId) || !validId(detached.messageId) || !validContent(detached.content)
    || !Number.isSafeInteger(detached.expectedRevision) || detached.expectedRevision < 1 || detached.expectedRevision >= Number.MAX_SAFE_INTEGER) return fail();
  const record = decodeRecord(await invoke("chat_display_apply", { request: detached }));
  if (record.chatId !== detached.chatId || record.messageId !== detached.messageId || record.content !== detached.content || record.revision !== detached.expectedRevision + 1) return fail();
  return record;
}

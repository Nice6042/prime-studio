import { invoke } from "@tauri-apps/api/core";

import type { AttentionEvidence, AttentionRecord, AttentionSnapshot } from "./attentionLedger";

const MAX_RECORDS = 4_096;

function fail(): never { throw new Error("Attention ledger unavailable."); }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
}
function evidence(value: unknown): AttentionEvidence | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "marker,occurredAtMs,runtimeGeneration" || !validId(source.runtimeGeneration) || typeof source.marker !== "string" || source.marker.length === 0 || source.marker.length > 256 || !/^[\x21-\x7e]+$/.test(source.marker) || !Number.isSafeInteger(source.occurredAtMs) || (source.occurredAtMs as number) < 0) return fail();
  return Object.freeze({ runtimeGeneration: source.runtimeGeneration, marker: source.marker, occurredAtMs: source.occurredAtMs as number });
}

export function decodeAttentionSnapshot(value: unknown): AttentionSnapshot {
  let detached: unknown;
  try { detached = structuredClone(value); } catch { return fail(); }
  if (!detached || typeof detached !== "object" || Array.isArray(detached)) return fail();
  const source = detached as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "records,revision" || !Number.isSafeInteger(source.revision) || (source.revision as number) < 0 || !Array.isArray(source.records) || source.records.length > MAX_RECORDS) return fail();
  const ids = new Set<string>();
  const records: AttentionRecord[] = source.records.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "activitySeen,chatId,chatSeen" || !validId(row.chatId) || ids.has(row.chatId)) return fail();
    ids.add(row.chatId);
    return Object.freeze({ chatId: row.chatId, chatSeen: evidence(row.chatSeen), activitySeen: evidence(row.activitySeen) });
  });
  return Object.freeze({ revision: source.revision as number, records: Object.freeze(records) });
}

export async function loadAttentionSnapshot(): Promise<AttentionSnapshot> {
  return decodeAttentionSnapshot(await invoke("attention_load"));
}

export async function loadActivityAttentionEvidence(sessionId: string): Promise<AttentionEvidence | null> {
  if (!validId(sessionId)) return fail();
  return evidence(await invoke("attention_activity_evidence", { request: { sessionId } }));
}

export async function markAttentionSeen(expectedRevision: number, chatId: string, channel: "chat" | "activity", exactEvidence: AttentionEvidence): Promise<AttentionSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !validId(chatId) || evidence(exactEvidence) === null) return fail();
  return decodeAttentionSnapshot(await invoke("attention_mark_seen", { request: { expectedRevision, chatId, channel, evidence: exactEvidence } }));
}

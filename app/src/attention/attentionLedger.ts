import type { ProjectChatState } from "../domain/projectChats";
import type { RootSessionProjection } from "../entities/harness/types";

export interface AttentionEvidence {
  readonly runtimeGeneration: string;
  readonly marker: string;
  readonly occurredAtMs: number;
}

export interface AttentionRecord {
  readonly chatId: string;
  readonly chatSeen: AttentionEvidence | null;
  readonly activitySeen: AttentionEvidence | null;
}

export interface AttentionSnapshot {
  readonly revision: number;
  readonly records: readonly AttentionRecord[];
}

export type AttentionState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "available"; revision: number; records: Readonly<Record<string, AttentionRecord>> }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type ActivityAttention =
  | Readonly<{ status: "seen"; evidence: AttentionEvidence | null }>
  | Readonly<{ status: "unseen"; evidence: AttentionEvidence }>
  | Readonly<{ status: "unavailable"; reason: string }>;

function evidenceIsAfter(current: AttentionEvidence | null, seen: AttentionEvidence | null): boolean {
  if (!current) return false;
  if (!seen || current.runtimeGeneration !== seen.runtimeGeneration) return true;
  if (current.marker === seen.marker) return false;
  return current.occurredAtMs >= seen.occurredAtMs;
}

export function chatAttentionEvidence(session: RootSessionProjection): AttentionEvidence | null {
  const completion = [...session.parentMessages].reverse().find((message) => message.kind === "assistant" && !message.streaming);
  return completion
    ? Object.freeze({ runtimeGeneration: session.cursor.runtimeGeneration, marker: completion.id, occurredAtMs: completion.emittedAtMs })
    : null;
}

export function reconcileAttentionSnapshot(snapshot: AttentionSnapshot): AttentionState {
  return {
    status: "available",
    revision: snapshot.revision,
    records: Object.freeze(Object.fromEntries(snapshot.records.map((record) => [record.chatId, Object.freeze(record)]))),
  };
}

function boundSession(catalog: ProjectChatState, sessions: Readonly<Record<string, RootSessionProjection>>, chatId: string): RootSessionProjection | null {
  const chats = catalog.projects.flatMap((project) => project.chats).filter((chat) => chat.id === chatId && !chat.archived);
  if (chats.length !== 1 || !chats[0]!.binding) return null;
  const binding = chats[0]!.binding!;
  const session = sessions[binding.sessionId] ?? null;
  if (!session || binding.accountId !== session.accountId || (binding.agentId !== null && binding.agentId !== session.chatId)) return null;
  return session;
}

export function deriveUnreadChatIds(
  catalog: ProjectChatState,
  sessions: Readonly<Record<string, RootSessionProjection>>,
  selectedChatId: string | null,
  attention: AttentionState,
): ReadonlySet<string> {
  if (attention.status !== "available") return new Set();
  const unread = new Set<string>();
  for (const chat of catalog.projects.flatMap((project) => project.chats)) {
    if (chat.archived || chat.id === selectedChatId) continue;
    const session = boundSession(catalog, sessions, chat.id);
    if (session && evidenceIsAfter(chatAttentionEvidence(session), attention.records[chat.id]?.chatSeen ?? null)) unread.add(chat.id);
  }
  return unread;
}

export function activityAttentionForChat(chatId: string, evidence: AttentionEvidence | null | undefined, attention: AttentionState): ActivityAttention {
  if (attention.status === "unavailable") return { status: "unavailable", reason: attention.reason };
  if (attention.status !== "available" || evidence === undefined) return { status: "unavailable", reason: "Activity content evidence is unavailable for this chat." };
  if (evidence && evidenceIsAfter(evidence, attention.records[chatId]?.activitySeen ?? null)) return { status: "unseen", evidence };
  return { status: "seen", evidence };
}

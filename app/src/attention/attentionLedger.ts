import type { ProjectChatState } from "../domain/projectChats";
import type { RootSessionProjection } from "../entities/harness/types";
import type { HarnessCursor } from "../shared/ipc/harness.generated";

export interface AttentionRecord {
  readonly chatId: string;
  readonly chatSeen: HarnessCursor | null;
  readonly activitySeen: HarnessCursor | null;
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
  | Readonly<{ status: "seen"; throughSequence: number }>
  | Readonly<{ status: "unseen"; throughSequence: number }>
  | Readonly<{ status: "unavailable"; reason: string }>;

function cursorIsAfter(current: HarnessCursor, seen: HarnessCursor | null): boolean {
  if (!seen || current.runtimeGeneration !== seen.runtimeGeneration) return current.sequence > 0;
  return current.sequence > seen.sequence;
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
    if (session && cursorIsAfter(session.cursor, attention.records[chat.id]?.chatSeen ?? null)) unread.add(chat.id);
  }
  return unread;
}

export function activityAttentionForChat(chatId: string, session: RootSessionProjection | null, attention: AttentionState): ActivityAttention {
  if (attention.status === "unavailable") return { status: "unavailable", reason: attention.reason };
  if (attention.status !== "available" || !session) return { status: "unavailable", reason: "Activity cursor evidence is unavailable for this chat." };
  const throughSequence = session.cursor.sequence;
  return cursorIsAfter(session.cursor, attention.records[chatId]?.activitySeen ?? null)
    ? { status: "unseen", throughSequence }
    : { status: "seen", throughSequence };
}

export interface StudioChat {
  readonly id: string;
  readonly projectId: string;
  readonly accountId: string | null;
  readonly title: string;
}

export type ChatEntities = Readonly<Record<string, StudioChat>>;

export function normalizeChats(chats: readonly StudioChat[]): ChatEntities {
  const entities: Record<string, StudioChat> = {};
  for (const chat of chats) {
    if (entities[chat.id]) throw new Error("Duplicate chat identity.");
    entities[chat.id] = Object.freeze({ ...chat });
  }
  return Object.freeze(entities);
}

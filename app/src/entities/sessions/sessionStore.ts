import type { RootSessionProjection } from "../harness/types";

export type SessionEntities = Readonly<Record<string, RootSessionProjection>>;

export function normalizeSessions(sessions: readonly RootSessionProjection[]): SessionEntities {
  const entities: Record<string, RootSessionProjection> = {};
  for (const session of sessions) {
    if (entities[session.sessionId]) throw new Error("Duplicate session identity.");
    entities[session.sessionId] = session;
  }
  return Object.freeze(entities);
}

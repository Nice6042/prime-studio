import { STUDIO_ACTIONS, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import type { RootSessionProjection } from "../../entities/harness/types";
import {
  executeHarnessStudioOperation,
  loadHarnessInspector,
  type HarnessStudioOperation,
  type HarnessStudioOperationRequest,
} from "../../shared/ipc/client";
import type { StudioStore } from "../../shared/state/store";
import type { HarnessInspectorAdapter, HarnessPanelDetails } from "./adapter";

interface ProductionHarnessPorts {
  load(sessionId: string): Promise<HarnessPanelDetails>;
  execute(request: HarnessStudioOperationRequest): Promise<Readonly<{ outcome: StudioOperationOutcome; session: RootSessionProjection | null }>>;
}

const realPorts: ProductionHarnessPorts = {
  load: loadHarnessInspector,
  async execute(request) {
    let projected: RootSessionProjection | null = null;
    const outcome = await executeHarnessStudioOperation(request, (session) => { projected = session; });
    return { outcome, session: projected };
  },
};

function reject(reason: string): StudioOperationOutcome {
  return { status: "rejected", reason, retryable: false };
}

function findBoundSession(store: StudioStore, operation: StudioOperation): RootSessionProjection | null {
  const state = store.getSnapshot();
  const payload = operation.payload as Readonly<Record<string, unknown>>;
  const requestedSessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const requestedChatId = typeof payload.chatId === "string" ? payload.chatId : null;
  const direct = requestedSessionId ? state.sessions[requestedSessionId] ?? null : null;
  let fromChat: RootSessionProjection | null = null;
  if (requestedChatId) {
    const matches = state.projectCatalog.projects.flatMap((project) => project.chats)
      .filter((chat) => chat.id === requestedChatId && !chat.archived);
    if (matches.length !== 1) return null;
    const binding = matches[0]!.binding;
    if (!binding) return null;
    fromChat = state.sessions[binding.sessionId] ?? null;
    if (!fromChat || binding.accountId !== fromChat.accountId || (binding.agentId !== null && binding.agentId !== fromChat.chatId)) return null;
  }
  if (direct && fromChat && direct.sessionId !== fromChat.sessionId) return null;
  return direct ?? fromChat;
}

export function createProductionHarnessInspectorAdapter(
  store: StudioStore,
  ports: ProductionHarnessPorts = realPorts,
): HarnessInspectorAdapter {
  return Object.freeze({
    availability: { status: "available" as const },
    load: (sessionId: string) => ports.load(sessionId),
    async execute(operation: StudioOperation): Promise<StudioOperationOutcome> {
      const descriptor = STUDIO_ACTIONS[operation.action];
      if (descriptor.owner.kind === "renderer") return { status: "updated", revision: "renderer" };
      if (descriptor.owner.kind === "unsupported") return { status: "unavailable", reason: descriptor.owner.reason };
      if (descriptor.owner.kind !== "harness") return { status: "unavailable", reason: `${operation.action} is owned outside the Harness adapter.` };
      const session = findBoundSession(store, operation);
      if (!session) return reject("The operation is not bound to one authoritative Harness session.");
      const { outcome, session: projected } = await ports.execute({
        sessionId: session.sessionId,
        operation: operation as HarnessStudioOperation,
        expectedCursor: session.cursor,
        idempotencyKey: operation.operationId ?? null,
      });
      if (projected) store.dispatch({ type: "harness/session-projected", session: projected });
      return outcome;
    },
  });
}

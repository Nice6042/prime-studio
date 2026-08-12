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
import type { ArtifactOpenResult } from "../../entities/editor/types";
import { openHarnessArtifactCandidate } from "../../rpc";
import { loadActivityAttentionEvidence } from "../../attention/attentionClient";

interface ProductionHarnessPorts {
  load(sessionId: string): Promise<HarnessPanelDetails>;
  execute(request: HarnessStudioOperationRequest): Promise<Readonly<{ outcome: StudioOperationOutcome; session: RootSessionProjection | null }>>;
  openArtifact?(sessionId: string, candidateId: string): Promise<ArtifactOpenResult>;
  loadActivityEvidence?(sessionId: string): ReturnType<typeof loadActivityAttentionEvidence>;
}

const TERMINAL_RUNTIME_STATES = new Set<RootSessionProjection["state"]>(["disconnected", "failed", "stopped"]);

const realPorts: ProductionHarnessPorts = {
  load: loadHarnessInspector,
  async execute(request) {
    let projected: RootSessionProjection | null = null;
    const outcome = await executeHarnessStudioOperation(request, (session) => { projected = session; });
    return { outcome, session: projected };
  },
  openArtifact: openHarnessArtifactCandidate,
  loadActivityEvidence: loadActivityAttentionEvidence,
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
  const session = direct ?? fromChat;
  return session?.freshness === "live" && !TERMINAL_RUNTIME_STATES.has(session.state) ? session : null;
}

export function createProductionHarnessInspectorAdapter(
  store: StudioStore,
  ports: ProductionHarnessPorts = realPorts,
): HarnessInspectorAdapter {
  return Object.freeze({
    get availability() {
      return store.getSnapshot().compatibility.status === "ready"
        ? { status: "available" as const }
        : { status: "unavailable" as const, reason: "The verified Prime Harness broker is not live." };
    },
    load: (sessionId: string) => store.getSnapshot().sessions[sessionId]
      ? ports.load(sessionId)
      : Promise.reject(new Error("The requested Harness session is not admitted by the native broker.")),
    loadActivityEvidence: (sessionId: string) => store.getSnapshot().sessions[sessionId] && ports.loadActivityEvidence
      ? ports.loadActivityEvidence(sessionId)
      : Promise.reject(new Error("Activity content evidence is unavailable for this Harness session.")),
    workerRecovery: Object.freeze({
      status: "unavailable" as const,
      reason: "Prime Studio cannot safely retry a silent worker because the native Harness bridge does not expose a verified closure reason and retry identity.",
    }),
    openArtifact(sessionId: string, candidateId: string) {
      const session = store.getSnapshot().sessions[sessionId];
      if (!session) return Promise.resolve({ kind: "unsupported" as const, reason: "The artifact candidate is not bound to an authoritative Harness session." });
      if (!ports.openArtifact) return Promise.resolve({ kind: "unsupported" as const, reason: "The native artifact candidate resolver is unavailable." });
      return ports.openArtifact(session.sessionId, candidateId);
    },
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

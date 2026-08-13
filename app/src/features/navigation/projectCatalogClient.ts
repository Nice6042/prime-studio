import { invoke } from "@tauri-apps/api/core";

import {
  deserializeProjectChatState,
  type ProjectChatCommand,
  type ProjectChatState,
} from "../../domain/projectChats";
import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessCursor } from "../../shared/ipc/harness.generated";
import { decodeRootSessionProjection, registerHarnessSessionProjection } from "../../shared/ipc/client";

const MAX_CATALOG_TRANSPORT_BYTES = 8 * 1024 * 1024;

export interface ProjectCatalogSnapshot {
  readonly revision: number;
  readonly state: ProjectChatState;
}

export interface ResidentChatBindingResult {
  readonly catalog: ProjectCatalogSnapshot;
  readonly session: RootSessionProjection;
}

export interface BranchResidentCatalogChatRequest {
  readonly expectedRevision: number;
  readonly projectId: string;
  readonly sourceChatId: string;
  readonly sourceSessionId: string;
  readonly messageId: string;
  readonly expectedCursor: HarnessCursor;
}

export interface BranchResidentChatBindingResult extends ResidentChatBindingResult {
  readonly branchChatId: string;
}

function fail(): never {
  throw new Error("Project catalog unavailable.");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function preflight(value: unknown, depth = 0, budget = { nodes: 0 }, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (depth > 128 || ++budget.nodes > 50_000 || seen.has(value)) return fail();
  seen.add(value);
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) return fail();
    preflight(descriptor.value, depth + 1, budget, seen);
  }
}

export function decodeProjectCatalogSnapshot(value: unknown): ProjectCatalogSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  let detached: unknown;
  try {
    preflight(value);
    detached = structuredClone(value);
  } catch {
    return fail();
  }
  if (!detached || typeof detached !== "object" || Array.isArray(detached)) return fail();
  const source = detached as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "revision,state") return fail();
  if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 0) return fail();
  let serialized: string;
  try {
    serialized = JSON.stringify(source.state);
  } catch {
    return fail();
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CATALOG_TRANSPORT_BYTES) return fail();
  const decoded = deserializeProjectChatState(serialized);
  if (decoded.status !== "loaded") return fail();
  return deepFreeze({ revision: source.revision as number, state: decoded.state });
}

export async function loadProjectCatalog(): Promise<ProjectCatalogSnapshot> {
  return decodeProjectCatalogSnapshot(await invoke("project_catalog_load"));
}

export async function applyProjectCatalogCommand(
  expectedRevision: number,
  command: ProjectChatCommand,
): Promise<ProjectCatalogSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail();
  let detached: ProjectChatCommand;
  try {
    preflight(command);
    detached = structuredClone(command);
  } catch {
    return fail();
  }
  return decodeProjectCatalogSnapshot(await invoke("project_catalog_apply", {
    expectedRevision,
    command: detached,
  }));
}

export async function createResidentForCatalogChat(
  expectedRevision: number,
  projectId: string,
  chatId: string,
): Promise<ResidentChatBindingResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail();
  if (![projectId, chatId].every((id) => id.length > 0 && id.length <= 128 && /^[\x20-\x7e]+$/.test(id) && id.trim() === id)) return fail();
  const value = await invoke("harness_create_resident_chat", { request: { expectedRevision, projectId, chatId } });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  preflight(value);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "catalog,session") return fail();
  const session = registerHarnessSessionProjection(decodeRootSessionProjection(source.session));
  return deepFreeze({
    catalog: decodeProjectCatalogSnapshot(source.catalog),
    session,
  });
}

export async function branchResidentCatalogChat(
  request: BranchResidentCatalogChatRequest,
): Promise<BranchResidentChatBindingResult> {
  const identifiers = [request.projectId, request.sourceChatId, request.sourceSessionId, request.messageId, request.expectedCursor.runtimeGeneration];
  if (
    !Number.isSafeInteger(request.expectedRevision)
    || request.expectedRevision < 0
    || !Number.isSafeInteger(request.expectedCursor.sequence)
    || request.expectedCursor.sequence < 0
    || !identifiers.every((value) => value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/.test(value) && value.trim() === value)
  ) return fail();
  const value = await invoke("harness_branch_resident_chat", { request: structuredClone(request) });
  preflight(value);
  let detached: unknown;
  try {
    detached = structuredClone(value);
  } catch {
    return fail();
  }
  if (!detached || typeof detached !== "object" || Array.isArray(detached)) return fail();
  const source = detached as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "branchChatId,catalog,session") return fail();
  if (typeof source.branchChatId !== "string") return fail();
  const branchChatId = source.branchChatId;
  const catalog = decodeProjectCatalogSnapshot(source.catalog);
  const session = decodeRootSessionProjection(source.session);
  const project = catalog.state.projects.find((candidate) => candidate.id === request.projectId && !candidate.archived);
  const matches = project?.chats.filter((chat) => chat.id === branchChatId && !chat.archived) ?? [];
  const branch = matches.length === 1 ? matches[0] : null;
  if (
    !branch
    || branchChatId === request.sourceChatId
    || branchChatId === request.sourceSessionId
    || session.sessionId === request.sourceSessionId
    || branchChatId === session.sessionId
    || branchChatId === session.chatId
    || branch.binding?.sessionId !== session.sessionId
    || branch.binding.accountId !== session.accountId
    || branch.binding.agentId !== session.chatId
    || !session.parentMessages.some((message) => message.id === request.messageId)
  ) return fail();
  return deepFreeze({ branchChatId, catalog, session });
}

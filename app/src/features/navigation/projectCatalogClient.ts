import { invoke } from "@tauri-apps/api/core";

import { deserializeProjectChatState, type ProjectChatState } from "../../domain/projectChats";

const MAX_CATALOG_TRANSPORT_BYTES = 8 * 1024 * 1024;

export interface ProjectCatalogSnapshot {
  readonly revision: number;
  readonly state: ProjectChatState;
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

import { invoke } from "@tauri-apps/api/core";

import type { HarnessComposerProjection } from "./adapter";

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const COMMANDS = new Set(["model", "effort", "compact", "fork", "export"] as const);
const ID = /^[\w./:@+-]{1,128}$/u;

function unavailable(): never {
  throw new Error("Harness composer projection unavailable.");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some((key) => !(key in source))) unavailable();
  return source;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) unavailable();
  return value;
}

function id(value: unknown): string {
  const candidate = text(value, 128);
  if (!ID.test(candidate)) unavailable();
  return candidate;
}

function choice<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T)) unavailable();
  return value as T;
}

function unique<T>(items: readonly T[]): readonly T[] {
  if (new Set(items).size !== items.length) unavailable();
  return items;
}

export function decodeHarnessComposerProjection(value: unknown): HarnessComposerProjection {
  const source = record(value, ["models", "selectedModel", "thinkingLevels", "selectedThinking", "supportedCommands"]);
  if (!Array.isArray(source.models) || source.models.length > 512) unavailable();
  const modelIds = new Set<string>();
  const models = source.models.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.enabled !== "boolean") unavailable();
    const model = record(candidate, candidate.enabled
      ? ["id", "label", "shortLabel", "enabled"]
      : ["id", "label", "shortLabel", "enabled", "disabledReason"]);
    const modelId = id(model.id);
    if (modelIds.has(modelId) || typeof model.enabled !== "boolean") unavailable();
    modelIds.add(modelId);
    return Object.freeze({
      id: modelId, label: text(model.label, 200), shortLabel: text(model.shortLabel, 200), enabled: model.enabled,
      ...(model.enabled ? {} : { disabledReason: text(model.disabledReason, 200) }),
    });
  });
  if (!Array.isArray(source.thinkingLevels) || source.thinkingLevels.length > LEVELS.size) unavailable();
  if (!Array.isArray(source.supportedCommands) || source.supportedCommands.length > COMMANDS.size) unavailable();
  const thinkingLevels = unique(source.thinkingLevels.map((item) => choice(item, LEVELS)));
  const supportedCommands = unique(source.supportedCommands.map((item) => choice(item, COMMANDS)));
  const selectedModel = source.selectedModel === null ? null : id(source.selectedModel);
  const selectedThinking = source.selectedThinking === null ? null : choice(source.selectedThinking, LEVELS);
  if (selectedModel !== null && !modelIds.has(selectedModel)) unavailable();
  if (selectedThinking !== null && !thinkingLevels.includes(selectedThinking)) unavailable();
  if (supportedCommands.includes("model") && !models.some((model) => model.enabled)) unavailable();
  if (supportedCommands.includes("effort") && thinkingLevels.length === 0) unavailable();
  return Object.freeze({ models: Object.freeze(models), selectedModel, thinkingLevels: Object.freeze([...thinkingLevels]), selectedThinking, supportedCommands: Object.freeze([...supportedCommands]) });
}

export async function loadHarnessComposerProjection(sessionId: string): Promise<HarnessComposerProjection> {
  const response = await invoke("harness_composer_projection", { request: { sessionId: id(sessionId) } });
  if (typeof response !== "string" || new TextEncoder().encode(response).byteLength > 131_072) unavailable();
  try {
    return decodeHarnessComposerProjection(JSON.parse(response));
  } catch (error) {
    if (error instanceof Error && error.message === "Harness composer projection unavailable.") throw error;
    return unavailable();
  }
}

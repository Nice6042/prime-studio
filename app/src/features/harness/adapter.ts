import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import type { ComposerRuntimeChoice, ThinkingLevel } from "../conversation/workspacePresentation";

export type HarnessActivityKind = "agent" | "tool" | "file" | "system";

export interface HarnessContextWindow {
  readonly usedTokens: number;
  readonly capacityTokens: number;
  readonly turns?: number;
  /** Observed context utilization ratios (0..1) or used-token samples, in chronological order. */
  readonly samples?: readonly number[];
}

export interface HarnessContribution {
  readonly id: string;
  readonly label: string;
  readonly tokens: number;
}

export interface HarnessNotice {
  readonly id: string;
  readonly kind: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly dismissible: boolean;
}

export interface HarnessActivityItem {
  readonly id: string;
  readonly occurredAtMs: number;
  readonly group: string;
  readonly kind: HarnessActivityKind;
  readonly title: string;
  readonly detail: string;
  /** Runtime-projected acknowledgement state. Absent means unknown, never unseen. */
  readonly seen?: boolean;
  readonly childId?: string;
  readonly filePath?: string;
  readonly tool?: Readonly<{
    command: string;
    status: "pending" | "running" | "blocked" | "succeeded" | "failed";
    durationMs: number | null;
    files: readonly string[];
  }>;
}

export interface HarnessChildDetails {
  readonly summary: string;
  readonly startedAtMs: number | null;
  readonly context: HarnessContextWindow | null;
  readonly transcript: readonly Readonly<{
    id: string;
    actor: string;
    occurredAtMs: number;
    text: string;
  }>[];
  readonly activity: readonly Readonly<{
    id: string;
    occurredAtMs: number;
    label: string;
  }>[];
  readonly files: readonly Readonly<{
    id: string;
    path: string;
    change: "added" | "modified" | "deleted" | "read";
  }>[];
  readonly error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
}

export interface HarnessPanelDetails {
  readonly observedAtMs: number;
  readonly startedAtMs: number | null;
  readonly context: HarnessContextWindow | null;
  /** Per-turn token evidence. Absent means the runtime did not expose it. */
  readonly turnUsage?: readonly Readonly<{ turn: number; input: number; output: number; totalTokens: number }>[];
  readonly contributions: readonly HarnessContribution[];
  readonly notices: readonly HarnessNotice[];
  readonly activity: readonly HarnessActivityItem[];
  readonly outputs: readonly Readonly<{ id: string; label: string; path: string; kind: string }>[];
  readonly sources: readonly Readonly<{ id: string; label: string; detail: string; kind: string }>[];
  readonly children: Readonly<Record<string, HarnessChildDetails>>;
}

export interface HarnessInspectorAdapter {
  readonly availability:
    | Readonly<{ status: "available" }>
    | Readonly<{ status: "unavailable"; reason: string }>;
  load(sessionId: string): Promise<HarnessPanelDetails>;
  execute(operation: StudioOperation): Promise<StudioOperationOutcome>;
  readonly composer?: Readonly<{
    models: readonly ComposerRuntimeChoice[];
    selectedModel: string | null;
    thinkingLevels: readonly ThinkingLevel[];
    selectedThinking: ThinkingLevel | null;
    supportedCommands: readonly ("model" | "effort" | "compact" | "fork" | "export")[];
  }>;
}

export const unavailableHarnessInspectorAdapter: HarnessInspectorAdapter = {
  availability: { status: "unavailable", reason: "The installed Harness does not expose inspector paging and controls." },
  load: async () => { throw new Error("Harness inspector details are unavailable."); },
  execute: async () => ({ status: "unavailable", reason: "Harness inspector controls are unavailable." }),
};

export function contextPercent(context: HarnessContextWindow | null): number | null {
  if (!context || !Number.isFinite(context.capacityTokens) || context.capacityTokens <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(context.usedTokens / context.capacityTokens * 100)));
}

export function compactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  if (value < 1_000) return value.toLocaleString();
  const digits = value >= 100_000 ? 0 : 1;
  return `${(value / 1_000).toFixed(digits).replace(/\.0$/, "")}k`;
}

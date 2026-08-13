import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import type { ComposerRuntimeChoice, ThinkingLevel } from "../conversation/workspacePresentation";
import type { ArtifactOpenResult } from "../../entities/editor/types";
import type { AttentionEvidence } from "../../attention/attentionLedger";
import type { RootSessionProjection } from "../../entities/harness/types";
import type { HarnessChildDataPage, HarnessExtensionUiRequest } from "../../shared/ipc/client";

export type HarnessActivityKind = "agent" | "tool" | "file" | "system";

export interface HarnessArtifactCandidate {
  readonly candidateId: string;
  readonly label: string;
}

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

/**
 * A daemon-minted partition of the exact current-chat token total. Raw
 * inspector contributions are intentionally not interchangeable with this:
 * they may describe context occupancy or a child-local measurement.
 */
export interface HarnessContributionPartition {
  readonly unit: "current_chat_tokens";
  readonly totalTokens: number;
  readonly contributions: readonly HarnessContribution[];
}

export interface HarnessTurnUsageRow {
  readonly turn: number;
  readonly occurredAtMs: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface HarnessTurnUsageSeries {
  readonly totalTurns: number;
  readonly omittedTurns: number;
  readonly rows: readonly HarnessTurnUsageRow[];
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
  readonly artifactCandidateId?: string;
  readonly tool?: Readonly<{
    command: string;
    status: "pending" | "running" | "blocked" | "succeeded" | "failed";
    durationMs: number | null;
    files: readonly HarnessArtifactCandidate[];
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
    label: string;
    candidateId: string;
    change: "added" | "modified" | "deleted" | "read";
  }>[];
  readonly error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
}

export interface HarnessPanelDetails {
  readonly observedAtMs: number;
  readonly startedAtMs: number | null;
  readonly context: HarnessContextWindow | null;
  /** Bounded finalized assistant-call usage. Absent means exact runtime evidence did not reconcile. */
  readonly turnUsage?: HarnessTurnUsageSeries;
  /** Present only when the verified daemon supplies same-unit partition provenance. */
  readonly contributionPartition?: HarnessContributionPartition;
  readonly contributions: readonly HarnessContribution[];
  readonly notices: readonly HarnessNotice[];
  readonly activity: readonly HarnessActivityItem[];
  readonly outputs: readonly Readonly<{ id: string; label: string; candidateId?: string; kind: string }>[];
  readonly sources: readonly Readonly<{ id: string; label: string; detail: string; candidateId?: string; kind: string }>[];
  readonly children: Readonly<Record<string, HarnessChildDetails>>;
  readonly extensionUi:
    | Readonly<{ status: "available"; requests: readonly HarnessExtensionUiRequest[] }>
    | Readonly<{ status: "unavailable"; reason: string }>;
  readonly composer?: HarnessComposerProjection;
}

export interface HarnessComposerProjection {
  readonly models: readonly ComposerRuntimeChoice[];
  readonly selectedModel: string | null;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly selectedThinking: ThinkingLevel | null;
  readonly supportedCommands: readonly ("model" | "effort" | "compact" | "fork" | "export")[];
}

export type HarnessRuntimeStatusProjection =
  | Readonly<{
      status: "available";
      sessionId: string;
      cursor: RootSessionProjection["cursor"];
      context: HarnessContextWindow | null;
      overload: "server_is_overloaded" | null;
    }>
  | Readonly<{
      status: "unavailable";
      sessionId: string;
      cursor: RootSessionProjection["cursor"];
      reason: string;
    }>;

export function projectHarnessRuntimeStatus(
  session: RootSessionProjection,
  details: HarnessPanelDetails,
): HarnessRuntimeStatusProjection {
  return Object.freeze({
    status: "available",
    sessionId: session.sessionId,
    cursor: Object.freeze({ ...session.cursor }),
    context: details.context ? Object.freeze({ ...details.context }) : null,
    overload: details.notices.some((notice) => notice.detail === "server_is_overloaded")
      ? "server_is_overloaded"
      : null,
  });
}

export interface HarnessInspectorAdapter {
  readonly availability:
    | Readonly<{ status: "available" }>
    | Readonly<{ status: "unavailable"; reason: string }>;
  load(sessionId: string): Promise<HarnessPanelDetails>;
  loadChildPage?(sessionId: string, childId: string, tab: "chat" | "activity" | "files", displayedCursor: RootSessionProjection["cursor"], pageCursor: string | null): Promise<HarnessChildDataPage>;
  /** Native broker evidence minted from the last hydrated Activity payload. */
  readonly loadActivityEvidence?: (sessionId: string) => Promise<AttentionEvidence | null>;
  /** Loads choices from one admitted session's verified daemon projection. */
  loadComposer?(sessionId: string): Promise<HarnessComposerProjection>;
  execute(operation: StudioOperation): Promise<StudioOperationOutcome>;
  /** Available only when native authority supplies closure and retry identities. */
  readonly workerRecovery?:
    | Readonly<{
        status: "available";
        maximumAutomaticRetries: 1;
        retry(sessionId: string, observationId: string): Promise<Readonly<{
          outcome: "recovered" | "terminal_failure";
          session: RootSessionProjection;
        }>>;
      }>
    | Readonly<{ status: "unavailable"; reason: string }>;
  openArtifact?(sessionId: string, candidateId: string): Promise<ArtifactOpenResult>;
  /** Explicit settings-operation authority; inspector availability alone is insufficient. */
  readonly settings?: Readonly<{
    harnessPolicy: boolean;
    toolPolicy: boolean;
  }>;
  readonly composer?: HarnessComposerProjection;
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

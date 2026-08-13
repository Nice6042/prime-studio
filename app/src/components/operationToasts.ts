import { STUDIO_ACTIONS, type StudioOperation, type StudioOperationOutcome } from "../contracts/studioOperations";
import type { ToastIdentity, ToastInput, ToastOwner } from "./toastQueue";

export interface OperationToastProjection {
  readonly identity: ToastIdentity;
  readonly operationId: string;
  readonly toast: ToastInput | null;
}

function ownerFor(operation: StudioOperation): ToastOwner {
  const kind = STUDIO_ACTIONS[operation.action].owner.kind;
  return kind === "studio_durable" ? "studio_durable" : kind;
}

function safeScope(operation: StudioOperation) {
  // Presentation scope is intentionally action-only. Payload values remain in
  // the coordinator's private action ledger and never enter render state.
  return JSON.stringify(["operation", operation.action]);
}

function title(owner: ToastOwner, unknown: boolean) {
  const subject = owner === "harness" ? "Harness request"
    : owner === "studio_durable" ? "Studio data operation"
      : owner === "native" ? "System operation"
        : owner === "runtime" ? "Runtime operation"
          : owner === "unsupported" ? "Unsupported operation"
            : "Studio operation";
  return `${subject} ${unknown ? "outcome unknown" : "failed"}`;
}

export function projectOperationToast(
  operation: StudioOperation & Readonly<{ operationId: string }>,
  outcome: StudioOperationOutcome,
): OperationToastProjection {
  const owner = ownerFor(operation);
  const identity = Object.freeze({ owner, scope: safeScope(operation) });
  if (outcome.status !== "unavailable" && outcome.status !== "rejected" && outcome.status !== "unknown_outcome") {
    return Object.freeze({ identity, operationId: operation.operationId, toast: null });
  }
  const retryable = outcome.status === "rejected" && outcome.retryable;
  return Object.freeze({
    identity,
    operationId: operation.operationId,
    toast: Object.freeze({
      ...identity,
      severity: "error" as const,
      title: title(owner, outcome.status === "unknown_outcome"),
      message: outcome.reason.slice(0, 300),
      action: retryable ? Object.freeze({ id: operation.operationId, label: "Retry", action: operation.action }) : undefined,
    }),
  });
}

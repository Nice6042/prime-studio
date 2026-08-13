import {
  dispatchStudioOperation,
  STUDIO_ACTIONS,
  type StudioOperation,
  type StudioOperationExecutors,
  type StudioOperationOutcome,
} from "../studioOperations";

export type StudioAuthorityExecutor = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

export interface StudioOperationRoutes {
  readonly harness?: StudioAuthorityExecutor;
  readonly studioDurable?: StudioAuthorityExecutor;
  readonly renderer?: StudioAuthorityExecutor;
  readonly native?: StudioAuthorityExecutor;
  readonly onOutcome?: (operation: StudioOperation, outcome: StudioOperationOutcome) => void;
}

function authorityLabel(kind: "harness" | "studioDurable" | "renderer" | "native"): string {
  return kind === "studioDurable" ? "studio durable" : kind;
}

function missingExecutor(kind: "harness" | "studioDurable" | "renderer" | "native"): StudioAuthorityExecutor {
  return async (operation) => ({
    status: "unavailable",
    reason: `No ${authorityLabel(kind)} executor is registered for ${operation.action}.`,
  });
}

function rejected(operation: StudioOperation, error: unknown): StudioOperationOutcome {
  const reason = error instanceof Error ? error.message : "Studio operation failed.";
  if (operation.operationId && STUDIO_ACTIONS[operation.action].owner.kind === "harness") {
    return { status: "unknown_outcome", operationId: operation.operationId, reason };
  }
  return { status: "rejected", reason, retryable: !reason.includes("interactive no-ops are forbidden") };
}

/**
 * Creates the one product-level operation boundary.
 *
 * Ownership is always selected from STUDIO_ACTIONS, never from the caller. A
 * missing route and every unsupported action therefore produce a visible,
 * typed outcome instead of allowing an interactive control to silently do
 * nothing.
 */
export function createStudioOperationDispatcher(routes: StudioOperationRoutes): StudioAuthorityExecutor {
  const executors: StudioOperationExecutors = {
    harness: routes.harness ?? missingExecutor("harness"),
    studioDurable: routes.studioDurable ?? missingExecutor("studioDurable"),
    renderer: routes.renderer ?? missingExecutor("renderer"),
    native: routes.native ?? missingExecutor("native"),
    unsupported: async (operation) => {
      const descriptor = STUDIO_ACTIONS[operation.action];
      return descriptor.owner.kind === "unsupported"
        ? { status: "unavailable", reason: descriptor.owner.reason }
        : { status: "unavailable", reason: `${operation.action} is unavailable.` };
    },
  };

  return async (operation) => {
    let outcome: StudioOperationOutcome;
    try {
      outcome = await dispatchStudioOperation(operation, executors);
    } catch (error) {
      outcome = rejected(operation, error);
    }
    routes.onOutcome?.(operation, outcome);
    return outcome;
  };
}

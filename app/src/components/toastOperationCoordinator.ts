import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { projectOperationToast } from "./operationToasts";
import {
  MAX_VISIBLE_TOASTS,
  dismissToast,
  enqueueToast,
  resolveToast,
  settleToastAction,
  type StudioToast,
  type ToastInput,
} from "./toastQueue";

export { MAX_VISIBLE_TOASTS };
export const MAX_ACTIONABLE_OPERATIONS = MAX_VISIBLE_TOASTS - 1;

type AdmittedOperation = StudioOperation & Readonly<{ operationId: string }>;
type Dispatcher = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

interface CoordinatorOptions {
  readonly dispatch: Dispatcher;
  readonly createOperationId?: () => string;
  readonly onQueueChange?: (queue: readonly StudioToast[]) => void;
}

const CAPACITY_IDENTITY = Object.freeze({ owner: "renderer" as const, scope: "queue.hard-capacity" });

function completed(outcome: StudioOperationOutcome) {
  return outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "updated" || outcome.status === "cancelled";
}

function uncertain(operationId: string, error: unknown): StudioOperationOutcome {
  return {
    status: "unknown_outcome",
    operationId,
    reason: error instanceof Error ? error.message : "The operation outcome is unknown.",
  };
}

export class ToastOperationCoordinator {
  private queue: readonly StudioToast[] = Object.freeze([]);
  private readonly actions = new Map<string, AdmittedOperation>();
  private readonly reservations = new Set<string>();
  private readonly retrying = new Set<string>();
  private dispatch: Dispatcher;
  private listener: ((queue: readonly StudioToast[]) => void) | undefined;
  private readonly createOperationId: () => string;
  private admissionSequence = 0;

  constructor(options: CoordinatorOptions) {
    this.dispatch = options.dispatch;
    this.listener = options.onQueueChange;
    this.createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  }

  setDispatch(dispatch: Dispatcher) {
    this.dispatch = dispatch;
  }

  setListener(listener: (queue: readonly StudioToast[]) => void) {
    this.listener = listener;
    listener(this.queue);
  }

  getSnapshot() {
    return this.queue;
  }

  hasAction(operationId: string) {
    return this.actions.has(operationId);
  }

  notify(input: ToastInput) {
    this.replaceQueue(enqueueToast(this.queue, input));
  }

  async execute(operation: StudioOperation): Promise<StudioOperationOutcome> {
    if (operation.action === "toast.dismiss") {
      const toastId = operation.payload.toastId;
      if (!this.queue.some((toast) => toast.id === toastId)) {
        return { status: "unavailable", reason: "This notification is already resolved." };
      }
      const admitted = this.admit(operation);
      let outcome: StudioOperationOutcome;
      try {
        outcome = await this.dispatch(admitted);
      } catch (error) {
        outcome = uncertain(admitted.operationId, error);
      }
      if (completed(outcome)) this.dismiss(toastId);
      return outcome;
    }

    const admitted = this.admit(operation);
    if (this.actions.size + this.reservations.size >= MAX_ACTIONABLE_OPERATIONS) {
      this.recordHardCapacity();
      return {
        status: "unavailable",
        reason: "No operation was started. Resolve or dismiss a retryable failure before starting another operation.",
      };
    }

    this.reservations.add(admitted.operationId);
    let outcome: StudioOperationOutcome;
    try {
      outcome = await this.dispatch(admitted);
    } catch (error) {
      outcome = uncertain(admitted.operationId, error);
    }
    this.reservations.delete(admitted.operationId);
    this.settleNew(admitted, outcome);
    return outcome;
  }

  async retry(operationId: string): Promise<StudioOperationOutcome> {
    const operation = this.actions.get(operationId);
    if (!operation || this.retrying.has(operationId)) {
      return { status: "unavailable", reason: "This retry is no longer available." };
    }

    this.retrying.add(operationId);
    let outcome: StudioOperationOutcome;
    try {
      outcome = await this.dispatch(operation);
    } catch (error) {
      outcome = uncertain(operationId, error);
    }
    this.retrying.delete(operationId);
    this.settleRetry(operation, outcome);
    return outcome;
  }

  private admit(operation: StudioOperation): AdmittedOperation {
    const operationId = `${this.createOperationId()}:${++this.admissionSequence}`;
    return Object.freeze({ ...operation, operationId }) as AdmittedOperation;
  }

  private settleNew(operation: AdmittedOperation, outcome: StudioOperationOutcome) {
    const projected = projectOperationToast(operation, outcome);
    if (!projected.toast) {
      this.clearCapacityIfAvailable();
      return;
    }
    if (projected.toast.action) this.actions.set(operation.operationId, operation);
    this.replaceQueue(enqueueToast(this.queue, projected.toast));
    this.clearCapacityIfAvailable();
  }

  private settleRetry(operation: AdmittedOperation, outcome: StudioOperationOutcome) {
    const projected = projectOperationToast(operation, outcome);
    if (projected.toast?.action) {
      if (this.actions.get(operation.operationId) !== operation) return;
      this.replaceQueue(enqueueToast(this.queue, projected.toast));
      return;
    }

    this.actions.delete(operation.operationId);
    this.replaceQueue(settleToastAction(this.queue, projected.identity, operation.operationId, projected.toast));
    this.clearCapacityIfAvailable();
  }

  private dismiss(toastId: string) {
    const toast = this.queue.find((candidate) => candidate.id === toastId);
    if (toast) for (const action of toast.actions) this.actions.delete(action.id);
    this.replaceQueue(dismissToast(this.queue, toastId));
    this.clearCapacityIfAvailable();
  }

  private recordHardCapacity() {
    this.replaceQueue(enqueueToast(this.queue, {
      ...CAPACITY_IDENTITY,
      severity: "warning",
      title: "Retry queue full",
      message: "No operation was started. Resolve or dismiss a retryable failure before starting another operation.",
      persistent: true,
    }));
  }

  private clearCapacityIfAvailable() {
    if (this.actions.size + this.reservations.size < MAX_ACTIONABLE_OPERATIONS) {
      this.replaceQueue(resolveToast(this.queue, CAPACITY_IDENTITY));
    }
  }

  private replaceQueue(queue: readonly StudioToast[]) {
    if (queue === this.queue) return;
    this.queue = queue;
    this.listener?.(queue);
  }
}

import type { StudioActionId } from "../contracts/studioOperations";

export type ToastSeverity = "info" | "success" | "warning" | "error";
export type ToastOwner = "runtime" | "harness" | "studio_durable" | "renderer" | "native" | "unsupported";

export interface ToastActionReference {
  readonly id: string;
  readonly label: string;
  readonly action: StudioActionId;
}

export interface ToastIdentity {
  readonly owner: ToastOwner;
  readonly scope: string;
}

export interface ToastInput extends ToastIdentity {
  readonly severity: ToastSeverity;
  readonly title: string;
  readonly message: string;
  readonly action?: ToastActionReference;
  readonly persistent?: boolean;
}

export interface StudioToast extends ToastIdentity {
  readonly id: string;
  readonly severity: ToastSeverity;
  readonly title: string;
  readonly message: string;
  readonly persistent: boolean;
  readonly occurrences: number;
  readonly expiresAtMs: number | null;
  readonly actions: readonly ToastActionReference[];
}

export const MAX_VISIBLE_TOASTS = 6;
export const TOAST_DURATION_MS = 2_400;

function sameIdentity(left: ToastIdentity, right: ToastIdentity) {
  return left.owner === right.owner && left.scope === right.scope;
}

function appendAction(actions: readonly ToastActionReference[], action: ToastActionReference | undefined) {
  if (!action || actions.some((candidate) => candidate.id === action.id)) return actions;
  return Object.freeze([...actions, Object.freeze({ ...action })]);
}

function persistentFor(input: ToastInput, actions: readonly ToastActionReference[]) {
  return input.persistent === true || input.severity === "error" || actions.length > 0;
}

function createToast(input: ToastInput, nowMs: number): StudioToast {
  const actions = Object.freeze(input.action ? [Object.freeze({ ...input.action })] : []);
  const persistent = persistentFor(input, actions);
  return Object.freeze({
    id: crypto.randomUUID(),
    owner: input.owner,
    scope: input.scope,
    severity: input.severity,
    title: input.title,
    message: input.message,
    persistent,
    occurrences: 1,
    expiresAtMs: persistent ? null : nowMs + TOAST_DURATION_MS,
    actions,
  });
}

/**
 * Adds one presentation without ever evicting an actionable presentation.
 * The coordinator guarantees a spare visible slot before admitting action
 * ledger entries; throwing here makes an invariant breach loud, never silent.
 */
export function enqueueToast(queue: readonly StudioToast[], input: ToastInput, nowMs = Date.now()): readonly StudioToast[] {
  const existing = queue.findIndex((toast) => sameIdentity(toast, input));
  if (existing >= 0) {
    const prior = queue[existing]!;
    const actions = appendAction(prior.actions, input.action);
    const persistent = persistentFor(input, actions);
    return Object.freeze(queue.map((toast, index) => index === existing
      ? Object.freeze({
        ...toast,
        severity: input.severity,
        title: input.title,
        message: input.message,
        persistent,
        occurrences: toast.occurrences + 1,
        expiresAtMs: persistent ? null : nowMs + TOAST_DURATION_MS,
        actions,
      })
      : toast));
  }

  const toast = createToast(input, nowMs);
  if (queue.length < MAX_VISIBLE_TOASTS) return Object.freeze([...queue, toast]);

  const transientIndex = queue.findIndex((candidate) => !candidate.persistent);
  const passiveIndex = transientIndex >= 0
    ? transientIndex
    : queue.findIndex((candidate) => candidate.actions.length === 0);
  if (passiveIndex >= 0) {
    return Object.freeze([...queue.filter((_, index) => index !== passiveIndex), toast]);
  }
  if (toast.actions.length === 0) return queue;
  throw new Error("Toast queue actionable capacity invariant violated.");
}

export function removeToastAction(queue: readonly StudioToast[], identity: ToastIdentity, actionId: string): readonly StudioToast[] {
  return Object.freeze(queue.flatMap((toast) => {
    if (!sameIdentity(toast, identity)) return [toast];
    const actions = Object.freeze(toast.actions.filter((action) => action.id !== actionId));
    return actions.length === 0 ? [] : [Object.freeze({ ...toast, actions })];
  }));
}

export function settleToastAction(
  queue: readonly StudioToast[],
  identity: ToastIdentity,
  actionId: string,
  replacement: ToastInput | null,
  nowMs = Date.now(),
): readonly StudioToast[] {
  return Object.freeze(queue.flatMap((toast) => {
    if (!sameIdentity(toast, identity)) return [toast];
    const actions = Object.freeze(toast.actions.filter((action) => action.id !== actionId));
    if (!replacement) return actions.length === 0 ? [] : [Object.freeze({ ...toast, actions })];
    const persistent = persistentFor(replacement, actions);
    return [Object.freeze({
      ...toast,
      severity: replacement.severity,
      title: replacement.title,
      message: replacement.message,
      persistent,
      occurrences: toast.occurrences + 1,
      expiresAtMs: persistent ? null : nowMs + TOAST_DURATION_MS,
      actions,
    })];
  }));
}

export function resolveToast(queue: readonly StudioToast[], identity: ToastIdentity): readonly StudioToast[] {
  return Object.freeze(queue.filter((toast) => !sameIdentity(toast, identity)));
}

export function dismissToast(queue: readonly StudioToast[], id: string): readonly StudioToast[] {
  return Object.freeze(queue.filter((toast) => toast.id !== id));
}

export function dismissToastSnapshot(
  queue: readonly StudioToast[],
  id: string,
  coveredOccurrences: number,
  coveredActionIds: readonly string[],
): readonly StudioToast[] {
  const coveredActions = new Set(coveredActionIds);
  return Object.freeze(queue.flatMap((toast) => {
    if (toast.id !== id) return [toast];
    const actions = Object.freeze(toast.actions.filter((action) => !coveredActions.has(action.id)));
    const laterOccurrences = Math.max(0, toast.occurrences - coveredOccurrences);
    if (laterOccurrences === 0 && actions.length === 0) return [];
    return [Object.freeze({
      ...toast,
      occurrences: Math.max(1, laterOccurrences),
      actions,
    })];
  }));
}

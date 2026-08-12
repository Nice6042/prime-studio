export type ToastKind = "status" | "failure";

export interface ToastInput {
  readonly kind: ToastKind;
  readonly text: string;
  readonly actionLabel?: string;
}

export interface StudioToast extends ToastInput {
  readonly id: string;
  readonly persistent: boolean;
  readonly occurrences: number;
}

const MAX_TOASTS = 4;

function keyFor(input: ToastInput) {
  return `${input.kind}\u0000${input.text}\u0000${input.actionLabel ?? ""}`;
}

export function enqueueToast(queue: readonly StudioToast[], input: ToastInput): readonly StudioToast[] {
  const existing = queue.find((toast) => keyFor(toast) === keyFor(input));
  if (existing) return queue.map((toast) => toast.id === existing.id ? Object.freeze({ ...toast, occurrences: toast.occurrences + 1 }) : toast);
  const toast: StudioToast = Object.freeze({
    ...input,
    id: crypto.randomUUID(),
    persistent: input.kind === "failure",
    occurrences: 1,
  });
  return Object.freeze([...queue.filter((candidate) => candidate.persistent).slice(-(MAX_TOASTS - 1)), toast]);
}

export function dismissToast(queue: readonly StudioToast[], id: string): readonly StudioToast[] {
  return Object.freeze(queue.filter((toast) => toast.id !== id));
}

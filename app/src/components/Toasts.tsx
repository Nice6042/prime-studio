import { useEffect, useRef, useState } from "react";

import type { StudioOperation, StudioOperationOutcome } from "../contracts/studioOperations";
import { MAX_VISIBLE_TOASTS, type StudioToast } from "./toastQueue";

export function Toasts({
  toasts,
  retry,
  execute,
}: {
  readonly toasts: readonly StudioToast[];
  readonly retry: (actionId: string) => Promise<StudioOperationOutcome>;
  readonly execute: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
}) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const attempts = useRef<Set<string>>(new Set());
  const lastOutsideFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest(".toasts")) lastOutsideFocus.current = target;
    };
    document.addEventListener("focusin", remember, true);
    return () => document.removeEventListener("focusin", remember, true);
  }, []);

  const handOffFocus = (origin: HTMLElement, movedOutside: () => boolean, done: () => void) => window.requestAnimationFrame(() => {
    if (movedOutside()) {
      done();
      return;
    }
    if (origin.isConnected) {
      done();
      return;
    }
    const nextToast = document.querySelector<HTMLElement>(".toasts button:not(:disabled)");
    if (nextToast) {
      nextToast.focus();
      done();
      return;
    }
    const prior = lastOutsideFocus.current;
    if (prior?.isConnected) {
      prior.focus();
      done();
      return;
    }
    document.querySelector<HTMLElement>(
      '[data-toast-focus-fallback], [data-control-id="title-harness"], [data-control-id="settings.back"], [data-control-id="title-projects"], button:not(.toast-action):not(.toast-dismiss)',
    )?.focus();
    done();
  });

  const attempt = async (toast: StudioToast, attemptId: string, run: () => Promise<StudioOperationOutcome>) => {
    if (attempts.current.has(attemptId)) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const startedInside = Boolean(active?.closest(`[data-toast-id="${CSS.escape(toast.id)}"]`));
    let movedOutside = false;
    const watchFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest(`[data-toast-id="${CSS.escape(toast.id)}"]`)) movedOutside = true;
    };
    document.addEventListener("focusin", watchFocus, true);
    attempts.current.add(attemptId);
    setPending((current) => new Set(current).add(attemptId));
    try {
      await run();
    } finally {
      attempts.current.delete(attemptId);
      setPending((current) => {
        const next = new Set(current);
        next.delete(attemptId);
        return next;
      });
      if (startedInside && active) {
        handOffFocus(active, () => movedOutside, () => document.removeEventListener("focusin", watchFocus, true));
      } else {
        document.removeEventListener("focusin", watchFocus, true);
      }
    }
  };

  useEffect(() => {
    const timers = toasts.filter((toast) => !toast.persistent).map((toast) => window.setTimeout(() => {
      void execute({ action: "toast.dismiss", payload: { toastId: toast.id } });
    }, Math.max(0, (toast.expiresAtMs ?? Date.now()) - Date.now())));
    return () => timers.forEach(window.clearTimeout);
  }, [execute, toasts]);

  const visible = toasts.slice(0, MAX_VISIBLE_TOASTS);
  if (visible.length === 0) return null;
  return <section className="toasts" aria-label="Notifications">
    {visible.map((toast) => {
      const assertive = toast.severity === "warning" || toast.severity === "error";
      const action = toast.actions[0];
      const actionPending = action ? pending.has(action.id) : false;
      const dismissPending = pending.has(`dismiss:${toast.id}`);
      return <article
        key={toast.id}
        className="toast"
        data-toast-id={toast.id}
        data-severity={toast.severity}
        role={assertive ? "alert" : "status"}
        aria-label={toast.title}
        aria-atomic="true"
      >
        <span className="toast-severity" aria-hidden="true" />
        <span className="toast-copy">
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
          {toast.occurrences > 1 && <small>Occurred {toast.occurrences} times</small>}
        </span>
        <span className="toast-actions">
          {action && <button
            type="button"
            className="toast-action"
            disabled={actionPending}
            data-control-id={`toast.action:${toast.id}`}
            data-studio-action={action.action}
            onClick={() => void attempt(toast, action.id, () => retry(action.id))}
          >{actionPending ? `${action.label}…` : action.label}{toast.actions.length > 1 && !actionPending ? ` (${toast.actions.length})` : ""}</button>}
          <button
            type="button"
            className="toast-dismiss"
            disabled={dismissPending || actionPending}
            data-control-id={`toast.dismiss:${toast.id}`}
            data-studio-action="toast.dismiss"
            aria-label={`Dismiss ${toast.title}`}
            onClick={() => void attempt(toast, `dismiss:${toast.id}`, () => execute({ action: "toast.dismiss", payload: { toastId: toast.id } }))}
          >Dismiss</button>
        </span>
      </article>;
    })}
  </section>;
}

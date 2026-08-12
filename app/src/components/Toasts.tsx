import { useEffect, useState } from "react";
import * as rpc from "../rpc";
import { dismissToast, enqueueToast, type StudioToast } from "./toastQueue";

export function Toasts() {
  const [toasts, setToasts] = useState<readonly StudioToast[]>([]);

  useEffect(() => {
    const push = (text: string, kind: "status" | "failure") => {
      let queued: StudioToast | undefined;
      setToasts((current) => {
        const next = enqueueToast(current, { kind, text: text.slice(0, 300) });
        queued = next.find((toast) => toast.text === text.slice(0, 300) && toast.kind === kind);
        return next;
      });
      if (kind === "status") setTimeout(() => {
        if (queued) setToasts((current) => dismissToast(current, queued!.id));
      }, 6000);
    };
    // A non-zero prime exit is not an error (PROTOCOL quirks), so `onExited`
    // deliberately isn't wired here — only real failures and stderr noise are.
    const offErr = rpc.onError((text) => push(text, "failure"));
    const offStderr = rpc.onStderr((line) => push(line, "status"));
    return () => {
      offErr();
      offStderr();
    };
  }, []);

  if (!toasts.length) return null;
  const dismiss = (id: string) =>
    setToasts((current) => dismissToast(current, id));
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="alert" aria-atomic="true">
          <span>{t.text}{t.occurrences > 1 ? ` (${t.occurrences})` : ""}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

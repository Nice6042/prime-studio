import { useEffect, useState } from "react";
import * as rpc from "../rpc";

interface Toast {
  id: number;
  text: string;
}

let seq = 0;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const push = (text: string) => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-3), { id, text }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    };
    // A non-zero prime exit is not an error (PROTOCOL quirks), so `onExited`
    // deliberately isn't wired here — only real failures and stderr noise are.
    const offErr = rpc.onError(push);
    const offStderr = rpc.onStderr((line) => push(line.slice(0, 300)));
    return () => {
      offErr();
      offStderr();
    };
  }, []);

  if (!toasts.length) return null;
  const dismiss = (id: number) =>
    setToasts((current) => current.filter((toast) => toast.id !== id));
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="alert" aria-atomic="true">
          <span>{t.text}</span>
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

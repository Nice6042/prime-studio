import { useState } from "react";

export function MessageActions({ text, onOpenCanvas }: { readonly text: string; readonly onOpenCanvas?: () => void }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return <div className="parent-message-actions">
    <button type="button" onClick={() => {
      if (!navigator.clipboard?.writeText) {
        setStatus("failed");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      );
    }}>Copy</button>
    {onOpenCanvas && <button type="button" aria-label="Edit answer in Canvas" onClick={onOpenCanvas}>Canvas</button>}
    <span className="sr-only" role="status">{status === "copied" ? "Message copied." : status === "failed" ? "Copy failed." : ""}</span>
  </div>;
}

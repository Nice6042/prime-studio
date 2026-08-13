import { useState } from "react";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { controlBinding } from "./controlBinding";

type ExecuteOperation = (operation: StudioOperation) => Promise<StudioOperationOutcome>;

function copyStatus(outcome: StudioOperationOutcome): string {
  if (outcome.status === "accepted" || outcome.status === "updated") return "Message copied.";
  if (outcome.status === "cancelled") return "Copy cancelled.";
  if (outcome.status === "queued") return "Copy queued.";
  return outcome.reason;
}

export function MessageActions({ chatId, messageId, displayRevision, text, executeOperation }: {
  readonly chatId?: string;
  readonly messageId: string;
  readonly displayRevision: number;
  readonly text: string;
  readonly executeOperation?: ExecuteOperation;
}) {
  const [status, setStatus] = useState("");
  const copy = async () => {
    if (!executeOperation) return;
    try {
      setStatus(copyStatus(await executeOperation({ action: "conversation.response.copy", payload: { messageId, text } })));
    } catch {
      setStatus("Copy result is unavailable because no verified operation outcome was returned.");
    }
  };
  const openCanvas = async () => {
    if (!executeOperation || !chatId) return;
    try {
      const outcome = await executeOperation({ action: "conversation.canvas.open", payload: { chatId, messageId, expectedRevision: displayRevision, content: text } });
      if (outcome.status !== "updated") setStatus(outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "cancelled" ? "Canvas did not open." : outcome.reason);
    } catch {
      setStatus("Canvas did not open because no verified operation outcome was returned.");
    }
  };
  return <div className="parent-message-actions">
    <button type="button" {...controlBinding(`conversation-copy-${messageId}`, "conversation.response.copy")} disabled={!executeOperation} onClick={() => { void copy(); }}>Copy</button>
    {chatId && <button type="button" {...controlBinding(`conversation-canvas-${messageId}`, "conversation.canvas.open")} aria-label="Edit answer in Canvas" disabled={!executeOperation} onClick={() => { void openCanvas(); }}>Canvas</button>}
    <span className="sr-only" role="status">{status}</span>
  </div>;
}

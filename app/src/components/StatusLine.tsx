import { useEffect, useState } from "react";
import { statusSentence } from "../transcript";
import type { ChatState } from "../reducer";

/**
 * "What is happening right now", as a sentence — the replacement for LIVE badges.
 *
 * The wrapper stays mounted so the live region exists before it has anything to
 * announce; when idle it simply has no content and collapses to nothing.
 */
export function StatusLine({ chat, onStop }: { chat: ChatState; onStop: () => void }) {
  const active = Object.values(chat.tools).find((t) => t.status === "running");
  const [elapsed, setElapsed] = useState(0);

  // Restarts whenever the cell in flight changes, so the number is that cell's age.
  useEffect(() => {
    setElapsed(0);
    if (!chat.busy) return;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [chat.busy, active?.id]);

  const text = statusSentence(chat, { elapsedSec: elapsed });
  const announcement = statusSentence(chat);

  return (
    <div className={`statusline ${text ? "" : "statusline-off"}`}>
      <span
        className="sr-only"
        role="status"
        aria-label="Live session status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
      {text && (
        <>
          <span className="status-dot" />
          <span className="status-text">{text}</span>
          <button className="status-stop" onClick={onStop} title="Abort the current turn">
            esc to stop
          </button>
        </>
      )}
    </div>
  );
}

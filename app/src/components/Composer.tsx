import { useEffect, useRef, useState } from "react";

/**
 * Prime's own slash commands, and the two that matter enough to sit on the
 * composer: `/refine` folds the turn's lessons into the continual harness, and
 * `/goal` is how a session gets the goal the rail's PLAN block reports on.
 * Clicking one types it rather than sending it — they all take an argument.
 */
const CHIPS = ["/refine", "/goal"] as const;

export function Composer({
  busy,
  readOnly,
  onSend,
  onSteer,
  onQueue,
  onPreloadMarkdown,
}: {
  busy: boolean;
  readOnly: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  /** `follow_up`: runs after the current turn instead of interrupting it. */
  onQueue: (text: string) => void;
  /** Starts the formatter fetch without rendering or moving focus. */
  onPreloadMarkdown?: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const fire = (fn: (t: string) => void) => {
    const t = text.trim();
    if (!t) return;
    fn(t);
    setText("");
  };
  const send = () => {
    onPreloadMarkdown?.();
    fire(onSend);
  };

  if (readOnly) {
    return <div className="composer composer-ro">Archived transcript — start a new chat to continue.</div>;
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        aria-label="Message Prime"
        value={text}
        autoFocus
        rows={1}
        placeholder="Message Prime, or / for commands"
        onChange={(e) => setText(e.target.value)}
        onFocus={onPreloadMarkdown}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (busy) fire(onSteer);
            else send();
          }
        }}
      />
      <div className="composer-actions">
        {CHIPS.map((c) => (
          <button
            key={c}
            className="slash"
            title={`Insert ${c}`}
            onClick={() => {
              setText((t) => (t.startsWith(c) ? t : `${c} ${t}`.trimEnd() + " "));
              ref.current?.focus();
            }}
          >
            {c}
          </button>
        ))}
        <span className="spacer" />
        {busy ? (
          <>
            {/* Two paths because prime has two: queue waits for the turn to end,
                steer interrupts it. Collapsing them would lose the distinction. */}
            <button className="btn-queue" onClick={() => fire(onQueue)} disabled={!text.trim()}>
              QUEUE
            </button>
            <button className="btn-steer" onClick={() => fire(onSteer)} disabled={!text.trim()}>
              STEER NOW
            </button>
          </>
        ) : (
          <button className="btn-steer" onClick={send} disabled={!text.trim()}>
            SEND
          </button>
        )}
      </div>
    </div>
  );
}

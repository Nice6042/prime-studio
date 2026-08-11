import { useEffect, useMemo, useRef, useState } from "react";

import type { RootSessionProjection } from "../../entities/harness/types";
import { createEmptyParentTranscript, reduceParentTranscript } from "../../entities/messages/parentTranscriptReducer";
import { MessageActions } from "./MessageActions";
import { TurnActivity } from "./TurnActivity";
import "./conversation.css";

export function ParentConversation({ title, session, archived }: {
  readonly title: string;
  readonly session: RootSessionProjection | null;
  readonly archived: boolean;
}) {
  const transcript = useMemo(() => session ? reduceParentTranscript(createEmptyParentTranscript(), {
    type: "snapshot",
    cursor: session.cursor,
    messages: session.parentMessages,
    omittedBefore: 0,
  }) : createEmptyParentTranscript(), [session]);
  const latestAssistant = [...transcript.messages].reverse().find((message) => message.kind === "assistant");
  const previousStreaming = useRef(latestAssistant?.kind === "assistant" ? latestAssistant.streaming : false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const streaming = latestAssistant?.kind === "assistant" ? latestAssistant.streaming : false;
    setAnnouncement(previousStreaming.current && !streaming ? "Prime finished responding." : "");
    previousStreaming.current = streaming;
  }, [latestAssistant]);

  return <section className="parent-conversation" aria-label={title}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    <div className="parent-transcript" role="log" aria-label={`${title} conversation`} aria-live="off" tabIndex={0}>
      {archived && <p className="conversation-notice">Archived chat. This conversation is read-only.</p>}
      {transcript.omittedBefore > 0 && <p className="conversation-notice">
        {transcript.omittedBefore.toLocaleString()} earlier messages are not resident in this view.
      </p>}
      {transcript.payloadClipped && <p className="conversation-notice">Large content was clipped in this view; the source session is unchanged.</p>}
      {transcript.messages.length === 0 && <div className="conversation-empty">
        <h1>{title}</h1>
        <p>Start a conversation when the verified Harness is available.</p>
      </div>}
      <div className="parent-reading-column">
        {transcript.messages.map((message) => {
          if (message.kind === "notice") return <p className="conversation-notice" key={message.id}>{message.text}</p>;
          if (message.kind === "user") return <article className="parent-turn parent-user-turn" key={message.id}>
            <div className="parent-user-bubble"><p>{message.text}</p></div>
            <MessageActions text={message.text} />
          </article>;
          const text = message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n");
          return <article className="parent-turn parent-assistant-turn" key={message.id} aria-busy={message.streaming}>
            <TurnActivity blocks={message.blocks} />
            {text ? <div className="parent-assistant-copy">{text.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : null}
            {message.streaming && <span className="assistant-streaming" role="status">Responding</span>}
            {!message.streaming && text && <MessageActions text={text} />}
          </article>;
        })}
      </div>
    </div>
  </section>;
}

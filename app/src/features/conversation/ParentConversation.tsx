import { useEffect, useMemo, useRef, useState } from "react";

import type { RootSessionProjection } from "../../entities/harness/types";
import { createEmptyParentTranscript, reduceParentTranscript } from "../../entities/messages/parentTranscriptReducer";
import { MessageActions } from "./MessageActions";
import { TurnActivity } from "./TurnActivity";
import type { ConversationTurnPresentation } from "./workspaceAdapter";
import { controlBinding } from "./controlBinding";
import "./conversation.css";

function timeLabel(emittedAtMs: number): string {
  if (emittedAtMs <= 0) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(emittedAtMs));
}

function PrimeMark() {
  return <svg className="parent-prime-mark" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 2 22 12 12 22 2 12Z" /><path d="m12 7 5 5-5 5-5-5Z" /></svg>;
}

function VersionStepper({ label, selected, count, onSelect }: { readonly label: "user" | "assistant"; readonly selected: number; readonly count: number; readonly onSelect?: (index: number) => void }) {
  if (count <= 1) return null;
  return <span className="conversation-version-stepper">
    <button type="button" {...controlBinding(`${label}-version-previous`, label === "user" ? "conversation.user-version.select" : "conversation.assistant-version.select")} aria-label={`Previous ${label} version`} disabled={selected <= 0} onClick={() => onSelect?.(Math.max(0, selected - 1))}>‹</button>
    <span>{selected + 1}/{count}</span>
    <button type="button" {...controlBinding(`${label}-version-next`, label === "user" ? "conversation.user-version.select" : "conversation.assistant-version.select")} aria-label={`Next ${label} version`} disabled={selected >= count - 1} onClick={() => onSelect?.(Math.min(count - 1, selected + 1))}>›</button>
  </span>;
}

function EditedFiles({ messageId, files, onUndo, onReview, onOpen }: {
  readonly messageId: string;
  readonly files: NonNullable<ConversationTurnPresentation["editedFiles"]>;
  readonly onUndo?: (messageId: string) => void;
  readonly onReview?: (messageId: string) => void;
  readonly onOpen?: (messageId: string, path: string) => void;
}) {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return <section className="conversation-edited-files" aria-label={`Edited ${files.length} files`}>
    <header><span className="conversation-file-icon" aria-hidden="true">◇</span><span><strong>Edited {files.length} files</strong><small><b>+{additions}</b> <i>−{deletions}</i></small></span>
      <button type="button" {...controlBinding(`files-undo-${messageId}`, "conversation.files.undo", "Prime Harness exposes no verified reversible patch capability.")} aria-label="Undo edited files" disabled={!onUndo} title={onUndo ? "Undo these edits" : "The verified Harness exposes no reversible patch capability."} onClick={() => onUndo?.(messageId)}>Undo ↶</button>
      <button type="button" {...controlBinding(`files-review-${messageId}`, "conversation.files.review")} aria-label="Review edited files" onClick={() => onReview?.(messageId)}>Review</button>
    </header>
    {files.map((file) => <button key={file.path} type="button" {...controlBinding(`file-open-${messageId}-${file.path}`, "editor.artifact.open")} aria-label={`Open ${file.path}`} onClick={() => onOpen?.(messageId, file.path)}><code>{file.path}</code><b>+{file.additions}</b><i>−{file.deletions}</i></button>)}
  </section>;
}

const suggestions = [
  ["Explore this codebase", "Explore this codebase and explain its architecture."],
  ["Plan a feature", "Help me plan and implement a feature in this project."],
  ["Review recent changes", "Review the recent changes and identify risks."],
] as const;

export function ParentConversation({
  title,
  session,
  archived,
  displayRevisions = {},
  presentations = {},
  onOpenCanvas,
  onEditUserMessage,
  onBranchFrom,
  onSelectUserVersion,
  onSelectAssistantVersion,
  onRegenerate,
  onUndoEditedFiles,
  onReviewEditedFiles,
  onOpenEditedFile,
  onSuggestionFill,
}: {
  readonly title: string;
  readonly session: RootSessionProjection | null;
  readonly archived: boolean;
  readonly displayRevisions?: Readonly<Record<string, Readonly<{ revision: number; content: string }>>>;
  readonly presentations?: Readonly<Record<string, ConversationTurnPresentation>>;
  readonly onOpenCanvas?: (messageId: string, content: string) => void;
  readonly onEditUserMessage?: (messageId: string, text: string) => void;
  readonly onBranchFrom?: (messageId: string) => void;
  readonly onSelectUserVersion?: (messageId: string, index: number) => void;
  readonly onSelectAssistantVersion?: (messageId: string, index: number) => void;
  readonly onRegenerate?: (messageId: string) => void;
  readonly onUndoEditedFiles?: (messageId: string) => void;
  readonly onReviewEditedFiles?: (messageId: string) => void;
  readonly onOpenEditedFile?: (messageId: string, path: string) => void;
  readonly onSuggestionFill?: (text: string) => void;
}) {
  const transcript = useMemo(() => session ? reduceParentTranscript(createEmptyParentTranscript(), { type: "snapshot", cursor: session.cursor, messages: session.parentMessages, omittedBefore: 0 }) : createEmptyParentTranscript(), [session]);
  const latestAssistant = [...transcript.messages].reverse().find((message) => message.kind === "assistant");
  const previousStreaming = useRef(latestAssistant?.kind === "assistant" ? latestAssistant.streaming : false);
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<Readonly<{ id: string; text: string }> | null>(null);
  const [expandedWork, setExpandedWork] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const streaming = latestAssistant?.kind === "assistant" ? latestAssistant.streaming : false;
    setAnnouncement(previousStreaming.current && !streaming ? "Prime finished responding." : "");
    previousStreaming.current = streaming;
  }, [latestAssistant]);

  return <section className="parent-conversation" aria-label={title}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    <div className="parent-transcript" role="log" aria-label={`${title} conversation`} aria-live="off" tabIndex={0}>
      {archived && <p className="conversation-notice">Archived chat. This conversation is read-only.</p>}
      {transcript.omittedBefore > 0 && <p className="conversation-notice">{transcript.omittedBefore.toLocaleString()} earlier messages are not resident in this view.</p>}
      {transcript.payloadClipped && <p className="conversation-notice">Large content was clipped in this view; the source session is unchanged.</p>}
      {transcript.messages.length === 0 && <div className="conversation-empty">
        <PrimeMark /><h1>Start a conversation</h1>
        <p>Prime Assistant runs on the Prime Harness — it can fan out subagents, run tools, and keep big data out of context.</p>
        <div className="conversation-suggestions">{suggestions.map(([label, prompt], index) => <button key={label} type="button" {...controlBinding(`suggestion-${index}`, "conversation.suggestion.fill")} onClick={() => onSuggestionFill?.(prompt)}>{label}</button>)}</div>
        {!session && <small>Start a conversation when the verified Harness is available.</small>}
      </div>}
      <div className="parent-reading-column">
        {transcript.messages.map((message) => {
          if (message.kind === "notice") return <p className="conversation-notice" key={message.id}>{message.text}</p>;
          const presentation = presentations[message.id] ?? {};
          if (message.kind === "user") {
            const versions = presentation.userVersions ?? [{ text: message.text }];
            const selected = Math.min(versions.length - 1, Math.max(0, presentation.selectedUserVersion ?? 0));
            const text = versions[selected]?.text ?? message.text;
            return <article className="parent-turn parent-user-turn" key={message.id}>
              <time>{timeLabel(message.emittedAtMs)}</time>
              {editing?.id === message.id ? <div className="parent-user-edit"><textarea aria-label="Edit message text" value={editing.text} onChange={(event) => setEditing({ id: message.id, text: event.currentTarget.value.slice(0, 64 * 1024) })} /><span><button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="primary" aria-label="Send edited message" disabled={!editing.text.trim()} onClick={() => { onEditUserMessage?.(message.id, editing.text.trim()); setEditing(null); }}>Send</button></span></div> : <div className="parent-user-bubble"><p>{text}</p></div>}
              {editing?.id !== message.id && <div className="parent-message-actions">
                <VersionStepper label="user" selected={selected} count={versions.length} onSelect={(index) => onSelectUserVersion?.(message.id, index)} />
                <button type="button" {...controlBinding(`user-edit-${message.id}`, "conversation.user-edit.start")} aria-label="Edit message" disabled={!onEditUserMessage} onClick={() => setEditing({ id: message.id, text })}>Edit</button>
                <button type="button" {...controlBinding(`user-branch-${message.id}`, "conversation.branch.create")} aria-label="Branch chat from message" disabled={!onBranchFrom} onClick={() => onBranchFrom?.(message.id)}>Branch</button>
              </div>}
            </article>;
          }
          const sourceText = message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n");
          const versions = presentation.assistantVersions ?? [{ text: sourceText }];
          const selected = Math.min(versions.length - 1, Math.max(0, presentation.selectedAssistantVersion ?? 0));
          const displayRevision = displayRevisions[message.id];
          const text = displayRevision?.content ?? versions[selected]?.text ?? sourceText;
          const workExpanded = expandedWork.has(message.id);
          return <article className="parent-turn parent-assistant-turn" key={message.id} aria-busy={message.streaming}>
            <TurnActivity blocks={message.blocks} />
            <header className="parent-assistant-header"><PrimeMark /><strong>Prime Assistant</strong><time>{message.streaming ? "streaming…" : timeLabel(message.emittedAtMs)}</time></header>
            <div className="parent-assistant-body">
              {displayRevision && <span className="canvas-revision-label">Display revision {displayRevision.revision}</span>}
              {text ? <div className="parent-assistant-copy">{text.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : null}
              {message.streaming && <span className="assistant-streaming" role="status">Responding<span className="assistant-cursor" /></span>}
              {presentation.workedFor && <><button type="button" className="conversation-work-toggle" {...controlBinding(`work-toggle-${message.id}`, "conversation.work-details.toggle")} aria-expanded={workExpanded} aria-label={`Worked for ${presentation.workedFor}`} onClick={() => setExpandedWork((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}>Worked for {presentation.workedFor} <span aria-hidden="true">⌄</span></button>
                {workExpanded && <div className="conversation-work-steps">{presentation.workSteps?.map((step) => <p key={step}>{step}</p>)}</div>}</>}
              {presentation.editedFiles && presentation.editedFiles.length > 0 && <EditedFiles messageId={message.id} files={presentation.editedFiles} onUndo={onUndoEditedFiles} onReview={onReviewEditedFiles} onOpen={onOpenEditedFile} />}
              {!message.streaming && text && <div className="parent-message-actions assistant-actions"><VersionStepper label="assistant" selected={selected} count={versions.length} onSelect={(index) => onSelectAssistantVersion?.(message.id, index)} /><button type="button" {...controlBinding(`response-regenerate-${message.id}`, "conversation.response.regenerate")} aria-label="Regenerate response" disabled={!onRegenerate} onClick={() => onRegenerate?.(message.id)}>Regenerate</button><MessageActions text={text} onOpenCanvas={onOpenCanvas ? () => onOpenCanvas(message.id, text) : undefined} /></div>}
            </div>
          </article>;
        })}
      </div>
    </div>
  </section>;
}

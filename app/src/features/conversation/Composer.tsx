import { useMemo } from "react";

import { AttachmentChips } from "./AttachmentChips";
import {
  approximateDraftTokens,
  acceptAttachmentMetadata,
  boundDraft,
  filterSlashCommands,
  keyboardComposerAction,
  type AttachmentMetadata,
  type ComposerState,
  type SlashCommand,
} from "./composerModel";
import { SlashMenu } from "./SlashMenu";

function SendIcon({ stop = false }: { readonly stop?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {stop ? <rect x="7" y="7" width="10" height="10" rx="2" /> : <><path d="m5 12 7-7 7 7" /><path d="M12 5v14" /></>}
  </svg>;
}

export function Composer({
  draft,
  state,
  attachments = [],
  onDraftChange,
  onSubmit,
  onAbort,
  onOpenUsage,
  onAttachmentsChange,
}: {
  readonly draft: string;
  readonly state: ComposerState;
  readonly attachments?: readonly AttachmentMetadata[];
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onAbort: () => void;
  readonly onOpenUsage: () => void;
  readonly onAttachmentsChange?: (attachments: readonly AttachmentMetadata[]) => void;
}) {
  const slashCommands = useMemo(() => filterSlashCommands(draft), [draft]);
  const disabledReason = state.kind === "unavailable" ? state.reason : state.kind === "read_only" ? "Archived conversations are read-only." : null;
  const canSubmit = state.kind === "idle" ? state.canSend : state.kind === "working" ? draft.trim().length > 0 && (state.canQueue || state.canSteer) : false;
  const busy = state.kind === "submitting" || state.kind === "aborting";

  const runSlashCommand = (command: SlashCommand) => {
    if (command.id === "usage") onOpenUsage();
  };
  const submit = () => {
    const exactSlash = slashCommands.find((command) => command.label === draft.trim());
    if (exactSlash?.enabled) {
      runSlashCommand(exactSlash);
      return;
    }
    if (exactSlash && !exactSlash.enabled) return;
    if (canSubmit) onSubmit();
  };

  return <div className="composer-dock">
    <div className="composer-frame" aria-label="Message composer">
      <SlashMenu commands={slashCommands} onSelect={(command) => {
        onDraftChange(`${command.label} `);
      }} />
      <AttachmentChips attachments={attachments} onRemove={onAttachmentsChange ? (id) => onAttachmentsChange(attachments.filter((attachment) => attachment.id !== id)) : undefined} />
      <textarea
        aria-label="Message Prime"
        value={draft}
        readOnly={state.kind === "read_only"}
        placeholder="Message Prime"
        rows={1}
        onChange={(event) => onDraftChange(boundDraft(event.currentTarget.value))}
        onKeyDown={(event) => {
          const action = keyboardComposerAction({
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          });
          if (action === "submit") {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-controls">
        {onAttachmentsChange && <label className="composer-attach" title="Attach files for native validation">
          <span aria-hidden="true">+</span><span className="sr-only">Attach files</span>
          <input type="file" multiple onChange={(event) => {
            const candidates = Array.from(event.currentTarget.files ?? []).map((file) => ({
              id: `${file.name}:${file.size}:${file.lastModified}`,
              name: file.name,
              size: file.size,
              mediaType: file.type || "application/octet-stream",
            }));
            onAttachmentsChange(acceptAttachmentMetadata(attachments, candidates).attachments);
            event.currentTarget.value = "";
          }} />
        </label>}
        <button className="composer-quick-control" type="button" disabled title="Model selection is not connected yet.">Model unavailable</button>
        <button className="composer-quick-control" type="button" disabled title="Thinking selection is not connected yet.">Thinking unavailable</button>
        <span className="composer-context" title="Approximate draft tokens">~{approximateDraftTokens(draft).toLocaleString()} tokens</span>
        {state.kind === "working" && state.canAbort ? <button className="composer-send" type="button" aria-label="Stop response" onClick={onAbort} disabled={busy}><SendIcon stop /></button>
          : <button className="composer-send" type="button" aria-label="Send message" onClick={submit} disabled={!canSubmit || busy}><SendIcon /></button>}
      </div>
    </div>
    <div className="composer-explanation" role="status">{disabledReason ?? (state.kind === "working" ? "Prime is working. Queue or steer this turn." : "")}</div>
  </div>;
}

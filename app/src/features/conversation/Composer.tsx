import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";


import { AttachmentChips } from "./AttachmentChips";
import {
  approximateDraftTokens,
  acceptAttachmentMetadata,
  boundDraft,
  composerSubmitAvailability,
  deriveSlashCommands,
  filterSlashCommands,
  keyboardComposerAction,
  type AttachmentMetadata,
  type ComposerState,
  type SendShortcut,
  type SlashCommand,
} from "./composerModel";
import { SlashMenu } from "./SlashMenu";
import type { ComposerModelId, ComposerRuntimeChoice, ThinkingLevel } from "./workspacePresentation";
import { controlBinding } from "./controlBinding";
import { usePopoverSurface } from "../../surfaceEscape";

const COMPOSER_MAX_BLOCK_SIZE_PX = 140;
const composerInputStyle = {
  "--composer-max-block-size": `${COMPOSER_MAX_BLOCK_SIZE_PX}px`,
} as CSSProperties;

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
  statusMessage,
  models = [],
  selectedModel,
  thinking = "off",
  onSelectModel,
  onSelectThinking,
  onVoiceInput,
  onSlashCommand,
  slashCommands: suppliedSlashCommands,
  thinkingLevels = [],
  sendShortcut = "enter",
  showTokenEstimate = true,
}: {
  readonly draft: string;
  readonly state: ComposerState;
  readonly attachments?: readonly AttachmentMetadata[];
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onAbort: () => void;
  readonly onOpenUsage: () => void;
  readonly onAttachmentsChange?: (attachments: readonly AttachmentMetadata[]) => void;
  readonly statusMessage?: string;
  readonly models?: readonly ComposerRuntimeChoice[];
  readonly selectedModel?: ComposerModelId;
  readonly thinking?: ThinkingLevel;
  readonly onSelectModel?: (modelId: ComposerModelId) => void;
  readonly onSelectThinking?: (level: ThinkingLevel) => void;
  readonly onVoiceInput?: () => void;
  readonly onSlashCommand?: (command: SlashCommand["id"]) => void;
  readonly slashCommands?: readonly SlashCommand[];
  readonly thinkingLevels?: readonly ThinkingLevel[];
  readonly sendShortcut?: SendShortcut;
  readonly showTokenEstimate?: boolean;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [focusedModelId, setFocusedModelId] = useState<string | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const thinkingMenu = useRef<HTMLDivElement>(null);
  const modelMenu = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const modelInitialFocus = useRef<"first" | "last" | "selected">("selected");
  usePopoverSurface(thinkingMenu, () => setThinkingOpen(false), thinkingOpen);
  const closeModelWithoutFocusRestore = usePopoverSurface(modelMenu, () => setModelOpen(false), modelOpen);
  const commandCatalog = useMemo(() => suppliedSlashCommands ?? deriveSlashCommands({
    model: models.length > 0 && Boolean(onSelectModel),
    effort: thinkingLevels.length > 0 && Boolean(onSelectThinking),
    compact: Boolean(onSlashCommand),
    fork: Boolean(onSlashCommand),
    new: Boolean(onSlashCommand),
    usage: true,
    export: Boolean(onSlashCommand),
  }), [models.length, onSelectModel, onSelectThinking, onSlashCommand, suppliedSlashCommands, thinkingLevels.length]);
  const slashCommands = useMemo(() => filterSlashCommands(draft, commandCatalog), [commandCatalog, draft]);
  const enabledSlashCommands = useMemo(() => slashCommands.filter((command) => command.enabled), [slashCommands]);
  const activeSlash = enabledSlashCommands[Math.min(activeSlashIndex, Math.max(0, enabledSlashCommands.length - 1))] ?? null;
  const disabledReason = state.kind === "unavailable" ? state.reason : state.kind === "read_only" ? "Archived conversations are read-only." : null;
  const canSubmit = composerSubmitAvailability(state, draft).enabled;
  const busy = state.kind === "submitting" || state.kind === "aborting";

  useEffect(() => {
    if (!modelOpen) return;
    const items = Array.from(modelMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    const selected = items.find((item) => item.getAttribute("aria-checked") === "true");
    const target = modelInitialFocus.current === "last" ? items[items.length - 1] : modelInitialFocus.current === "first" ? items[0] : selected ?? items[0];
    setFocusedModelId(target?.dataset.modelId ?? null);
    target?.focus();
  }, [modelOpen]);

  const moveModelFocus = (key: string) => {
    const items = Array.from(modelMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const target = key === "Home" ? items[0]
      : key === "End" ? items[items.length - 1]
        : key === "ArrowDown" ? items[(Math.max(0, current) + 1) % items.length]
          : items[(current <= 0 ? items.length : current) - 1];
    setFocusedModelId(target?.dataset.modelId ?? null);
    target?.focus();
  };

  const runSlashCommand = (command: SlashCommand) => {
    onDraftChange("");
    if (command.id === "usage") onOpenUsage();
    else {
      if (command.id === "effort") setThinkingOpen(true);
      onSlashCommand?.(command.id);
    }
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

  const droppedFiles = (files: FileList | readonly File[]) => {
    if (!onAttachmentsChange) return;
    const candidates = Array.from(files).map((file) => ({ id: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, size: file.size, mediaType: file.type || "application/octet-stream" }));
    onAttachmentsChange(acceptAttachmentMetadata(attachments, candidates).attachments);
  };

  return <div className="composer-dock">
    <div className="composer-frame" data-dragging={dragging} aria-label="Message composer" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); droppedFiles(event.dataTransfer.files); }}>
      <SlashMenu commands={slashCommands} activeCommandId={activeSlash?.id} onSelect={(command) => {
        onDraftChange(`${command.label} `);
      }} />
      <AttachmentChips attachments={attachments} onRemove={onAttachmentsChange ? (id) => onAttachmentsChange(attachments.filter((attachment) => attachment.id !== id)) : undefined} />
      <textarea
        {...controlBinding("composer-draft", "composer.draft.change")}
        className="composer-input"
        style={composerInputStyle}
        aria-label="Message Prime Studio"
        aria-controls={slashCommands.length > 0 ? "composer-slash-commands" : undefined}
        aria-activedescendant={activeSlash ? `slash-option-${activeSlash.id}` : undefined}
        value={draft}
        readOnly={state.kind === "read_only"}
        placeholder="Message Prime Studio — try / for commands"
        rows={1}
        onChange={(event) => onDraftChange(boundDraft(event.currentTarget.value))}
        onKeyDown={(event) => {
          if (enabledSlashCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActiveSlashIndex((current) => {
              const offset = event.key === "ArrowDown" ? 1 : -1;
              return (current + offset + enabledSlashCommands.length) % enabledSlashCommands.length;
            });
            return;
          }
          const action = keyboardComposerAction({
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          }, sendShortcut);
          if (action === "submit") {
            event.preventDefault();
            if (activeSlash) {
              runSlashCommand(activeSlash);
              return;
            }
            submit();
          }
        }}
      />
      <div className="composer-controls">
        {onAttachmentsChange && <label className="composer-attach" {...controlBinding("composer-attachment-pick", "composer.attachment.pick")} title="Attach files">
          <span aria-hidden="true">+</span><span className="sr-only">Attach files</span>
          <input type="file" {...controlBinding("composer-attachment-file-input", "composer.attachment.pick")} multiple onChange={(event) => {
            droppedFiles(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
          }} />
        </label>}
        {models.length > 0 && onSelectModel ? <div className="composer-model-pills" aria-label="Quick model switcher">
          {models.map((model) => {
            return <button key={model.id} type="button" {...controlBinding(`composer-model-${model.id}`, "composer.model.select", model.enabled ? null : (model.disabledReason ?? "This model is unavailable."))} aria-label={`Use ${model.label}`} aria-pressed={model.id === selectedModel} disabled={!model.enabled} title={model.disabledReason} onClick={() => onSelectModel?.(model.id)}>{model.shortLabel ?? model.label}</button>;
          })}
        </div> : null}
        {models.length > 0 && onSelectModel ? <div className="composer-model-root">
          <button ref={modelTrigger} type="button" {...controlBinding("composer-model-catalog", "composer.model.select")} className="composer-model-catalog" aria-label={`Choose model ${models.find((model) => model.id === selectedModel)?.label ?? "unavailable"}`} aria-haspopup="menu" aria-expanded={modelOpen} onClick={() => { modelInitialFocus.current = "selected"; setModelOpen((value) => !value); }} onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            modelInitialFocus.current = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
            setModelOpen(true);
          }}>Models</button>
          {modelOpen && <div ref={modelMenu} data-studio-overlay="menu" className="composer-model-menu" role="menu" aria-label="Verified models" onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              moveModelFocus(event.key);
            } else if (event.key === "Tab") {
              closeModelWithoutFocusRestore();
              window.setTimeout(() => setModelOpen(false), 0);
            }
          }}>{models.map((model) => <button key={model.id} type="button" {...controlBinding(`composer-model-catalog-${model.id}`, "composer.model.select", model.enabled ? null : (model.disabledReason ?? "This model is unavailable."))} role="menuitemradio" aria-checked={model.id === selectedModel} aria-label={model.label} data-model-id={model.id} tabIndex={model.enabled && model.id === focusedModelId ? 0 : -1} disabled={!model.enabled} title={model.disabledReason} onFocus={() => setFocusedModelId(model.id)} onClick={() => { setModelOpen(false); onSelectModel(model.id); }}>{model.label}</button>)}</div>}
        </div> : null}
        {thinkingLevels.length > 0 && onSelectThinking && <div className="composer-thinking-root">
          <button className="composer-thinking" type="button" {...controlBinding("composer-thinking", "composer.thinking.select")} aria-label={`Thinking ${thinking}`} aria-haspopup="menu" aria-expanded={thinkingOpen} disabled={!onSelectThinking} onClick={() => setThinkingOpen((value) => !value)}><span>Thinking</span><strong>{thinking}</strong><span aria-hidden="true">⌄</span></button>
          {thinkingOpen && <div ref={thinkingMenu} data-studio-overlay="menu" className="composer-thinking-menu" role="menu" aria-label="Thinking level">{thinkingLevels.map((level) => <button key={level} type="button" {...controlBinding(`composer-thinking-${level}`, "composer.thinking.select")} role="menuitemradio" aria-checked={thinking === level} onClick={() => { setThinkingOpen(false); onSelectThinking(level); }}>{level[0].toUpperCase() + level.slice(1)}{thinking === level && <span aria-hidden="true">✓</span>}</button>)}</div>}
        </div>}
        {showTokenEstimate && <span className="composer-context" title="Approximate draft tokens">≈ {approximateDraftTokens(draft).toLocaleString()} tokens</span>}
        <button className="composer-voice" type="button" {...controlBinding("composer-voice", "composer.voice.start", "Voice capture is unavailable until the native privacy contract is implemented.")} aria-label="Voice input" disabled={!onVoiceInput} title={onVoiceInput ? "Voice input" : "Voice capture is unavailable until the native privacy contract is implemented."} onClick={onVoiceInput}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4" /></svg></button>
        {state.kind === "working" && state.canAbort ? <button className="composer-send" type="button" {...controlBinding("composer-stop", "harness.session.abort")} aria-label="Stop response" onClick={onAbort} disabled={busy}><SendIcon stop /></button>
          : <button className="composer-send" type="button" {...controlBinding("composer-send", "harness.session.prompt")} aria-label="Send message" onClick={submit} disabled={!canSubmit || busy}><SendIcon /></button>}
      </div>
    </div>
    <div className="composer-explanation" role="status">{disabledReason ?? statusMessage ?? (state.kind === "working" ? "Prime is working. Queue or steer this turn." : "")}</div>
  </div>;
}

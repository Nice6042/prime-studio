import { useEffect, useMemo, useState, type ButtonHTMLAttributes } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
import type {
  ArtifactDocument,
  ArtifactOpenResult,
  ArtifactSaveCopyRequest,
  ArtifactSaveCopyResult,
  ArtifactSaveRequest,
  ArtifactSaveResult,
} from "../../entities/editor/types";
import "./editor.css";

export interface CanvasDocument {
  readonly chatId: string;
  readonly messageId: string;
  readonly displayRevision: number;
  readonly content: string;
}

export type { ArtifactDocument, ArtifactSaveRequest, ArtifactSaveResult } from "../../entities/editor/types";

const controls = {
  close: createControlBinding("editor.close", "layout.editor.close"),
  diff: createControlBinding("editor.mode.diff", "editor.mode.select"),
  edit: createControlBinding("editor.mode.edit", "editor.mode.select"),
  save: createControlBinding("editor.file.save", "editor.file.save"),
  apply: createControlBinding("editor.canvas.apply", "editor.canvas.apply"),
  reload: createControlBinding("editor.conflict.reload", "editor.conflict.reload"),
  saveCopy: createControlBinding("editor.conflict.save-copy", "editor.conflict.save-copy"),
};

function ControlButton({ binding, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly binding: typeof controls[keyof typeof controls] }) {
  return <button {...props} data-control-id={binding.controlId} data-action={binding.action} />;
}

export function EditorPane({
  onClose,
  artifact,
  onArtifactSave,
  onArtifactReload,
  onArtifactSaveCopy,
  onArtifactReloaded,
  onArtifactSaved,
  draftContent,
  onDraftChange,
  canvas,
  onCanvasApply,
  unsupportedReason,
}: {
  readonly onClose: () => void;
  readonly artifact?: ArtifactDocument | null;
  readonly onArtifactSave?: (request: ArtifactSaveRequest) => Promise<ArtifactSaveResult>;
  readonly onArtifactReload?: (document: ArtifactDocument) => Promise<ArtifactOpenResult>;
  readonly onArtifactSaveCopy?: (request: ArtifactSaveCopyRequest) => Promise<ArtifactSaveCopyResult>;
  readonly onArtifactReloaded?: (document: ArtifactDocument) => void;
  readonly onArtifactSaved?: (document: ArtifactDocument) => void;
  readonly draftContent?: string;
  readonly onDraftChange?: (content: string) => void;
  readonly canvas?: CanvasDocument | null;
  readonly onCanvasApply?: (content: string) => void;
  readonly unsupportedReason?: string;
}) {
  const [displayArtifact, setDisplayArtifact] = useState<ArtifactDocument | null>(artifact ?? null);
  const document = displayArtifact ?? canvas ?? null;
  const [mode, setMode] = useState<"diff" | "edit">(artifact ? "diff" : "edit");
  const [content, setContent] = useState(artifact ? (draftContent ?? artifact.content) : (canvas?.content ?? ""));
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [savedRevision, setSavedRevision] = useState(artifact?.ref.revision ?? 0);
  const [savedIdentity, setSavedIdentity] = useState(artifact?.identity ?? "");
  const [baseline, setBaseline] = useState(artifact?.content ?? canvas?.content ?? "");

  useEffect(() => {
    const parentEchoesLocalArtifact = Boolean(artifact && displayArtifact
      && artifact.ref.brokerId === displayArtifact.ref.brokerId
      && artifact.ref.rootSessionId === displayArtifact.ref.rootSessionId
      && artifact.ref.artifactId === displayArtifact.ref.artifactId
      && artifact.ref.revision === displayArtifact.ref.revision
      && artifact.identity === displayArtifact.identity);
    if (parentEchoesLocalArtifact) return;
    setDisplayArtifact(artifact ?? null);
    setMode(artifact ? "diff" : "edit");
    setContent(artifact ? (draftContent ?? artifact.content) : (canvas?.content ?? ""));
    setSaving(false);
    setRecovering(false);
    setConflict(false);
    setNotice(null);
    setSavedRevision(artifact?.ref.revision ?? 0);
    setSavedIdentity(artifact?.identity ?? "");
    setBaseline(artifact?.content ?? canvas?.content ?? "");
  }, [artifact?.ref.brokerId, artifact?.ref.rootSessionId, artifact?.ref.artifactId, artifact?.ref.revision, canvas?.chatId, canvas?.messageId, canvas?.displayRevision]);

  const dirty = Boolean(document && content !== baseline);
  const counts = useMemo(() => displayArtifact?.diff.reduce(
    (total, row) => ({ add: total.add + Number(row.kind === "add"), delete: total.delete + Number(row.kind === "delete") }),
    { add: 0, delete: 0 },
  ) ?? { add: 0, delete: 0 }, [displayArtifact]);

  const saveArtifact = async () => {
    if (!displayArtifact || !dirty || !displayArtifact.writable || !onArtifactSave || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await onArtifactSave({
        ref: { ...displayArtifact.ref, revision: savedRevision },
        expectedRevision: savedRevision,
        expectedIdentity: savedIdentity,
        content,
      });
      if (result.kind === "saved") {
        const savedDocument = {
          ...displayArtifact,
          ref: { ...displayArtifact.ref, revision: result.revision },
          identity: result.identity,
          content,
        };
        setSavedRevision(result.revision);
        setSavedIdentity(result.identity);
        setBaseline(content);
        setDisplayArtifact(savedDocument);
        setConflict(false);
        onArtifactSaved?.(savedDocument);
        setNotice({ kind: "status", text: `Saved revision ${result.revision}` });
      } else {
        setConflict(result.kind === "conflict");
        setNotice({ kind: "error", text: result.message });
      }
    } catch {
      setNotice({ kind: "error", text: "Save failed. Your unsaved content is still here; retry after checking the file authority." });
    } finally {
      setSaving(false);
    }
  };

  const reloadArtifact = async () => {
    if (!displayArtifact || !onArtifactReload || recovering) return;
    setRecovering(true);
    try {
      const result = await onArtifactReload(displayArtifact);
      if (result.kind === "unsupported") {
        setNotice({ kind: "error", text: result.reason });
        return;
      }
      setDisplayArtifact(result.document);
      setContent(result.document.content);
      setBaseline(result.document.content);
      setSavedRevision(result.document.ref.revision);
      setSavedIdentity(result.document.identity);
      setConflict(false);
      onDraftChange?.(result.document.content);
      onArtifactReloaded?.(result.document);
      setNotice({ kind: "status", text: `Reloaded revision ${result.document.ref.revision}` });
    } catch {
      setNotice({ kind: "error", text: "Reload failed. Your unsaved content is still available until you retry or save a copy." });
    } finally {
      setRecovering(false);
    }
  };

  const saveCopy = async () => {
    if (!displayArtifact || !onArtifactSaveCopy || recovering) return;
    setRecovering(true);
    try {
      const result = await onArtifactSaveCopy({ ref: displayArtifact.ref, content });
      if (result.kind === "saved_copy") setNotice({ kind: "status", text: `Saved copy as ${result.label}` });
      else if (result.kind !== "cancelled") setNotice({ kind: "error", text: result.message });
    } catch {
      setNotice({ kind: "error", text: "The copy could not be saved. Your unsaved content is still here." });
    } finally {
      setRecovering(false);
    }
  };

  return <section className="studio-editor-pane">
    <header>
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></svg>
      <h1 title={displayArtifact?.label}>{displayArtifact?.label ?? (canvas ? "Canvas" : "Editor")}</h1>
      {displayArtifact && <><span className="studio-editor-add">+{counts.add}</span><span className="studio-editor-delete">−{counts.delete}</span></>}
      <ControlButton binding={controls.close} type="button" aria-label="Close editor" onClick={onClose}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></ControlButton>
    </header>
    <div className="studio-editor-tabs" role="tablist" aria-label="Editor views">
      {displayArtifact && <ControlButton binding={controls.diff} type="button" role="tab" aria-selected={mode === "diff"} onClick={() => setMode("diff")}>Diff</ControlButton>}
      <ControlButton binding={controls.edit} type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>{canvas ? "Canvas" : "Edit"}</ControlButton>
    </div>
    {!document ? <div className="studio-editor-empty"><svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 8h8M8 12h6M8 16h4" /></svg><strong>No verified file or Canvas revision</strong><p>{unsupportedReason ?? "Open an identity-bound file from Harness activity, or create a display-only Canvas revision from a parent response."}</p></div>
      : displayArtifact && mode === "diff" ? <div className="studio-diff" role="table" aria-label={`Diff for ${displayArtifact.label}`}>
        {displayArtifact.diff.length === 0 ? <p className="studio-editor-zero">No structured changes were reported for this revision.</p> : displayArtifact.diff.map((row, index) => <div role="row" className={`studio-diff-row studio-diff-${row.kind}`} key={`${index}:${row.oldLine}:${row.newLine}`}>
          <span role="cell" aria-label={row.oldLine == null ? "No old line" : `Old line ${row.oldLine}`}>{row.oldLine ?? ""}</span>
          <span role="cell" aria-label={row.newLine == null ? "No new line" : `New line ${row.newLine}`}>{row.newLine ?? ""}</span>
          <span role="cell" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "}</span>
          <code role="cell" data-diff-kind={row.kind}>{row.text || " "}</code>
        </div>)}
        {displayArtifact.diffTruncated && <p className="studio-editor-zero" role="status">Diff truncated at the native safety boundary.</p>}
      </div> : <div className="studio-source-editor">
        <div className="studio-editor-meta"><span>{displayArtifact ? `Revision ${savedRevision}` : `Display revision ${canvas!.displayRevision}`}</span><span>{dirty ? "Unsaved changes" : "No unsaved changes"}</span></div>
        <textarea aria-label={displayArtifact ? "File content" : "Canvas content"} spellCheck={false} value={content} readOnly={Boolean(displayArtifact && !displayArtifact.writable)} onChange={(event) => {
          const next = event.target.value.slice(0, 2 * 1024 * 1024);
          setContent(next);
          onDraftChange?.(next);
          setNotice(null);
          setConflict(false);
        }} />
        {canvas && <p>Canvas changes affect Studio presentation only. Applying a revision does not rewrite Harness history.</p>}
        {displayArtifact && !displayArtifact.writable && <p role="status">This artifact is read-only because no verified write authority is available.</p>}
      </div>}
    {notice && <div className={`studio-editor-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      {conflict && <div className="studio-editor-conflict-actions">
        <ControlButton binding={controls.reload} type="button" disabled={!onArtifactReload || recovering} onClick={() => void reloadArtifact()}>Reload from disk</ControlButton>
        <ControlButton binding={controls.saveCopy} type="button" disabled={!onArtifactSaveCopy || recovering} onClick={() => void saveCopy()}>Save a copy</ControlButton>
      </div>}
    </div>}
    <footer>
      <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
      {displayArtifact ? <ControlButton binding={controls.save} type="button" className="studio-editor-primary" disabled={!dirty || !displayArtifact.writable || !onArtifactSave || saving} title={!onArtifactSave ? "A native conflict-aware save adapter is not connected." : undefined} onClick={() => void saveArtifact()}>{saving ? "Saving…" : "Save"}</ControlButton>
        : <><button type="button" disabled>Save</button>{canvas && <ControlButton binding={controls.apply} type="button" className="studio-editor-primary" disabled={!dirty || !onCanvasApply} onClick={() => onCanvasApply?.(content)}>Apply display revision</ControlButton>}</>}
    </footer>
  </section>;
}

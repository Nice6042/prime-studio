import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";

import { createControlBinding, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import type { ArtifactDocument } from "../../entities/editor/types";
import "./editor.css";

export interface CanvasDocument {
  readonly chatId: string;
  readonly messageId: string;
  readonly displayRevision: number;
  readonly content: string;
}

export type EditorMode = "diff" | "edit";

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
  documentId,
  mode,
  onExecute,
  artifact,
  admissionRevision = 0,
  draftContent,
  onDraftChange,
  canvas,
  unsupportedReason,
}: {
  readonly onClose: () => void;
  readonly documentId: string | null;
  readonly mode: EditorMode;
  readonly onExecute: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly artifact?: ArtifactDocument | null;
  readonly admissionRevision?: number;
  readonly draftContent?: string;
  readonly onDraftChange?: (content: string) => void;
  readonly canvas?: CanvasDocument | null;
  readonly unsupportedReason?: string;
}) {
  const [displayArtifact, setDisplayArtifact] = useState<ArtifactDocument | null>(artifact ?? null);
  const document = displayArtifact ?? canvas ?? null;
  const [content, setContent] = useState(artifact ? (draftContent ?? artifact.content) : (canvas?.content ?? ""));
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [savedRevision, setSavedRevision] = useState(artifact?.ref.revision ?? 0);
  const [savedIdentity, setSavedIdentity] = useState(artifact?.identity ?? "");
  const [baseline, setBaseline] = useState(artifact?.content ?? canvas?.content ?? "");
  const activeDocumentIdRef = useRef(documentId);
  activeDocumentIdRef.current = documentId;
  const activeArtifactRef = useRef(artifact ?? null);
  activeArtifactRef.current = artifact ?? null;
  const activeCanvasRef = useRef(canvas ?? null);
  activeCanvasRef.current = canvas ?? null;

  const isExactArtifactSuccessor = (outcome: StudioOperationOutcome) => {
    const current = activeArtifactRef.current;
    return outcome.status === "updated" && typeof outcome.revision === "number" && Boolean(outcome.identity) && Boolean(current)
      && current!.ref.brokerId === displayArtifact?.ref.brokerId
      && current!.ref.rootSessionId === displayArtifact?.ref.rootSessionId
      && current!.ref.artifactId === displayArtifact?.ref.artifactId
      && current!.ref.revision === outcome.revision
      && current!.identity === outcome.identity;
  };

  useEffect(() => {
    setDisplayArtifact(artifact ?? null);
    setContent(artifact ? (draftContent ?? artifact.content) : (canvas?.content ?? ""));
    setSaving(false);
    setRecovering(false);
    setConflict(false);
    setNotice(null);
    setSavedRevision(artifact?.ref.revision ?? 0);
    setSavedIdentity(artifact?.identity ?? "");
    setBaseline(artifact?.content ?? canvas?.content ?? "");
  }, [admissionRevision, artifact?.ref.brokerId, artifact?.ref.rootSessionId, artifact?.ref.artifactId, artifact?.ref.revision, artifact?.identity, artifact?.content, canvas?.chatId, canvas?.messageId, canvas?.displayRevision]);

  const dirty = Boolean(document && content !== baseline);
  const counts = useMemo(() => displayArtifact?.diff.reduce(
    (total, row) => ({ add: total.add + Number(row.kind === "add"), delete: total.delete + Number(row.kind === "delete") }),
    { add: 0, delete: 0 },
  ) ?? { add: 0, delete: 0 }, [displayArtifact]);

  const saveArtifact = async () => {
    if (!displayArtifact || !documentId || !dirty || !displayArtifact.writable || saving) return;
    const requestedDocumentId = documentId;
    setSaving(true);
    setNotice(null);
    try {
      const outcome = await onExecute({ action: "editor.file.save", payload: {
        documentId: requestedDocumentId,
        ref: { ...displayArtifact.ref, revision: savedRevision },
        expectedRevision: savedRevision,
        expectedIdentity: savedIdentity,
        content,
      } });
      if (activeDocumentIdRef.current !== requestedDocumentId && !isExactArtifactSuccessor(outcome)) return;
      if (outcome.status === "updated") {
        setConflict(false);
        setNotice({ kind: "status", text: `Saved revision ${outcome.revision}` });
      } else {
        const reason = outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "cancelled" ? "The native save did not return a committed revision." : outcome.reason;
        setConflict(/conflict|changed on disk/i.test(reason));
        setNotice({ kind: "error", text: reason });
      }
    } catch {
      if (activeDocumentIdRef.current === requestedDocumentId) setNotice({ kind: "error", text: "Save failed. Your unsaved content is still here; retry after checking the file authority." });
    } finally {
      if (activeDocumentIdRef.current === requestedDocumentId) setSaving(false);
    }
  };

  const reloadArtifact = async () => {
    if (!displayArtifact || !documentId || recovering) return;
    const requestedDocumentId = documentId;
    setRecovering(true);
    try {
      const outcome = await onExecute({ action: "editor.conflict.reload", payload: {
        documentId: requestedDocumentId, ref: displayArtifact.ref, expectedRevision: savedRevision, expectedIdentity: savedIdentity,
      } });
      if (activeDocumentIdRef.current !== requestedDocumentId && !isExactArtifactSuccessor(outcome)) return;
      if (outcome.status === "updated") { setConflict(false); setNotice({ kind: "status", text: `Reloaded revision ${outcome.revision}` }); }
      else setNotice({ kind: "error", text: outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "cancelled" ? "Reload did not return an admitted document." : outcome.reason });
    } catch {
      if (activeDocumentIdRef.current === requestedDocumentId) setNotice({ kind: "error", text: "Reload failed. Your unsaved content is still available until you retry or save a copy." });
    } finally {
      if (activeDocumentIdRef.current === requestedDocumentId) setRecovering(false);
    }
  };

  const saveCopy = async () => {
    if (!displayArtifact || !documentId || recovering) return;
    const requestedDocumentId = documentId;
    setRecovering(true);
    try {
      const outcome = await onExecute({ action: "editor.conflict.save-copy", payload: {
        documentId: requestedDocumentId, ref: displayArtifact.ref, expectedRevision: savedRevision, expectedIdentity: savedIdentity, content,
      } });
      if (activeDocumentIdRef.current !== requestedDocumentId) return;
      if (outcome.status === "updated") setNotice({ kind: "status", text: `Saved copy as ${outcome.revision}` });
      else if (outcome.status !== "cancelled") setNotice({ kind: "error", text: outcome.status === "accepted" || outcome.status === "queued" ? "Save-copy did not return a verified path." : outcome.reason });
    } catch {
      if (activeDocumentIdRef.current === requestedDocumentId) setNotice({ kind: "error", text: "The copy could not be saved. Your unsaved content is still here." });
    } finally {
      if (activeDocumentIdRef.current === requestedDocumentId) setRecovering(false);
    }
  };

  const applyCanvas = async () => {
    if (!canvas || !documentId || !dirty) return;
    const requestedDocumentId = documentId;
    try {
      const outcome = await onExecute({ action: "editor.canvas.apply", payload: { chatId: canvas.chatId, messageId: canvas.messageId, expectedRevision: canvas.displayRevision, content } });
      const currentCanvas = activeCanvasRef.current;
      const exactSuccessor = outcome.status === "updated" && typeof outcome.revision === "number" && currentCanvas?.chatId === canvas.chatId
        && currentCanvas.messageId === canvas.messageId && currentCanvas.displayRevision === outcome.revision && currentCanvas.content === content;
      if (activeDocumentIdRef.current !== requestedDocumentId && !exactSuccessor) return;
      if (outcome.status === "updated") setNotice({ kind: "status", text: `Applied display revision ${outcome.revision}` });
      else setNotice({ kind: "error", text: outcome.status === "accepted" || outcome.status === "queued" || outcome.status === "cancelled" ? "Canvas apply did not commit a display revision." : outcome.reason });
    } catch {
      if (activeDocumentIdRef.current === requestedDocumentId) setNotice({ kind: "error", text: "Canvas apply failed without changing the parent transcript." });
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
      {displayArtifact && <ControlButton binding={controls.diff} type="button" role="tab" aria-selected={mode === "diff"} disabled={!documentId} onClick={() => {
        if (documentId) void onExecute({ action: "editor.mode.select", payload: { documentId, mode: "diff" } });
      }}>Diff</ControlButton>}
      <ControlButton binding={controls.edit} type="button" role="tab" aria-selected={mode === "edit"} disabled={!documentId} onClick={() => {
        if (documentId) void onExecute({ action: "editor.mode.select", payload: { documentId, mode: "edit" } });
      }}>{canvas ? "Canvas" : "Edit"}</ControlButton>
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
        <ControlButton binding={controls.reload} type="button" disabled={recovering} onClick={() => void reloadArtifact()}>Reload from disk</ControlButton>
        <ControlButton binding={controls.saveCopy} type="button" disabled={recovering} onClick={() => void saveCopy()}>Save a copy</ControlButton>
      </div>}
    </div>}
    <footer>
      <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
      {displayArtifact ? <ControlButton binding={controls.save} type="button" className="studio-editor-primary" disabled={!dirty || !displayArtifact.writable || saving} onClick={() => void saveArtifact()}>{saving ? "Saving…" : "Save"}</ControlButton>
        : <><button type="button" disabled>Save</button>{canvas && <ControlButton binding={controls.apply} type="button" className="studio-editor-primary" disabled={!dirty} onClick={() => { void applyCanvas(); }}>Apply display revision</ControlButton>}</>}
    </footer>
  </section>;
}

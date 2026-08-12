import { useEffect, useMemo, useState, type ButtonHTMLAttributes } from "react";

import { createControlBinding } from "../../contracts/studioOperations";
import type { ArtifactRef } from "../../entities/editor/types";
import "./editor.css";

export interface CanvasDocument {
  readonly chatId: string;
  readonly messageId: string;
  readonly displayRevision: number;
  readonly content: string;
}

export interface StructuredDiffRow {
  readonly kind: "context" | "add" | "delete";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface ArtifactDocument {
  readonly label: string;
  readonly ref: ArtifactRef;
  readonly identity: string;
  readonly content: string;
  readonly writable: boolean;
  readonly diff: readonly StructuredDiffRow[];
}

export type ArtifactSaveResult =
  | Readonly<{ kind: "saved"; revision: number; identity: string }>
  | Readonly<{ kind: "conflict" | "error"; message: string }>;

export interface ArtifactSaveRequest {
  readonly ref: ArtifactRef;
  readonly expectedRevision: number;
  readonly expectedIdentity: string;
  readonly content: string;
}

const controls = {
  close: createControlBinding("editor.close", "layout.editor.close"),
  diff: createControlBinding("editor.mode.diff", "editor.mode.select"),
  edit: createControlBinding("editor.mode.edit", "editor.mode.select"),
  save: createControlBinding("editor.file.save", "editor.file.save"),
  apply: createControlBinding("editor.canvas.apply", "editor.canvas.apply"),
};

function ControlButton({ binding, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly binding: typeof controls[keyof typeof controls] }) {
  return <button {...props} data-control-id={binding.controlId} data-action={binding.action} />;
}

export function EditorPane({ onClose, artifact, onArtifactSave, canvas, onCanvasApply }: {
  readonly onClose: () => void;
  readonly artifact?: ArtifactDocument | null;
  readonly onArtifactSave?: (request: ArtifactSaveRequest) => Promise<ArtifactSaveResult>;
  readonly canvas?: CanvasDocument | null;
  readonly onCanvasApply?: (content: string) => void;
}) {
  const document = artifact ?? canvas ?? null;
  const [mode, setMode] = useState<"diff" | "edit">(artifact ? "diff" : "edit");
  const [content, setContent] = useState(document?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);

  useEffect(() => {
    setMode(artifact ? "diff" : "edit");
    setContent(document?.content ?? "");
    setSaving(false);
    setNotice(null);
  }, [artifact, canvas, document?.content]);

  const dirty = Boolean(document && content !== document.content);
  const counts = useMemo(() => artifact?.diff.reduce((total, row) => ({ add: total.add + Number(row.kind === "add"), delete: total.delete + Number(row.kind === "delete") }), { add: 0, delete: 0 }) ?? { add: 0, delete: 0 }, [artifact]);

  const saveArtifact = async () => {
    if (!artifact || !dirty || !artifact.writable || !onArtifactSave || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await onArtifactSave({ ref: artifact.ref, expectedRevision: artifact.ref.revision, expectedIdentity: artifact.identity, content });
      if (result.kind === "saved") setNotice({ kind: "status", text: `Saved revision ${result.revision}` });
      else setNotice({ kind: "error", text: result.message });
    } catch {
      setNotice({ kind: "error", text: "Save failed. Your unsaved content is still here; retry after checking the file authority." });
    } finally {
      setSaving(false);
    }
  };

  return <section className="studio-editor-pane" aria-label="Editor">
    <header>
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></svg>
      <h1 title={artifact?.label}>{artifact?.label ?? (canvas ? "Canvas" : "Editor")}</h1>
      {artifact && <><span className="studio-editor-add">+{counts.add}</span><span className="studio-editor-delete">−{counts.delete}</span></>}
      <ControlButton binding={controls.close} type="button" aria-label="Close editor" onClick={onClose}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></ControlButton>
    </header>
    <div className="studio-editor-tabs" role="tablist" aria-label="Editor views">
      {artifact && <ControlButton binding={controls.diff} type="button" role="tab" aria-selected={mode === "diff"} onClick={() => setMode("diff")}>Diff</ControlButton>}
      <ControlButton binding={controls.edit} type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>{canvas ? "Canvas" : "Edit"}</ControlButton>
    </div>
    {!document ? <div className="studio-editor-empty"><svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 8h8M8 12h6M8 16h4" /></svg><strong>No verified file or Canvas revision</strong><p>Open an identity-bound file from Harness activity, or create a display-only Canvas revision from a parent response.</p></div>
      : artifact && mode === "diff" ? <div className="studio-diff" role="table" aria-label={`Diff for ${artifact.label}`}>
        {artifact.diff.length === 0 ? <p className="studio-editor-zero">No structured changes were reported for this revision.</p> : artifact.diff.map((row, index) => <div role="row" className={`studio-diff-row studio-diff-${row.kind}`} key={`${index}:${row.oldLine}:${row.newLine}`}>
          <span role="cell" aria-label={row.oldLine == null ? "No old line" : `Old line ${row.oldLine}`}>{row.oldLine ?? ""}</span>
          <span role="cell" aria-label={row.newLine == null ? "No new line" : `New line ${row.newLine}`}>{row.newLine ?? ""}</span>
          <span role="cell" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "}</span>
          <code role="cell" data-diff-kind={row.kind}>{row.text || " "}</code>
        </div>)}
      </div> : <div className="studio-source-editor">
        <div className="studio-editor-meta"><span>{artifact ? `Revision ${artifact.ref.revision}` : `Display revision ${canvas!.displayRevision}`}</span><span>{dirty ? "Unsaved changes" : "No unsaved changes"}</span></div>
        <textarea aria-label={artifact ? "File content" : "Canvas content"} spellCheck={false} value={content} readOnly={Boolean(artifact && !artifact.writable)} onChange={(event) => { setContent(event.target.value.slice(0, 2 * 1024 * 1024)); setNotice(null); }} />
        {canvas && <p>Canvas changes affect Studio presentation only. Applying a revision does not rewrite Harness history.</p>}
        {artifact && !artifact.writable && <p role="status">This artifact is read-only because no verified write authority is available.</p>}
      </div>}
    {notice && <div className={`studio-editor-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    <footer>
      <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
      {artifact ? <ControlButton binding={controls.save} type="button" className="studio-editor-primary" disabled={!dirty || !artifact.writable || !onArtifactSave || saving} title={!onArtifactSave ? "A native conflict-aware save adapter is not connected." : undefined} onClick={() => void saveArtifact()}>{saving ? "Saving…" : "Save"}</ControlButton>
        : <><button type="button" disabled>Save</button>{canvas && <ControlButton binding={controls.apply} type="button" className="studio-editor-primary" disabled={!dirty || !onCanvasApply} onClick={() => onCanvasApply?.(content)}>Apply display revision</ControlButton>}</>}
    </footer>
  </section>;
}

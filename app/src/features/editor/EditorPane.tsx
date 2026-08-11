import { useEffect, useState } from "react";

import "./editor.css";

export interface CanvasDocument {
  readonly chatId: string;
  readonly messageId: string;
  readonly displayRevision: number;
  readonly content: string;
}

export function EditorPane({ onClose, canvas, onCanvasApply }: {
  readonly onClose: () => void;
  readonly canvas?: CanvasDocument | null;
  readonly onCanvasApply?: (content: string) => void;
}) {
  const [content, setContent] = useState(canvas?.content ?? "");
  useEffect(() => setContent(canvas?.content ?? ""), [canvas]);
  const dirty = Boolean(canvas && content !== canvas.content);
  return <div className="studio-editor-pane">
    <header><div><span>Workspace</span><h1>Editor</h1></div><button type="button" aria-label="Close editor" onClick={onClose}>×</button></header>
    <div className="studio-editor-tabs" role="tablist" aria-label="Editor views"><button type="button" role="tab" aria-selected="true">{canvas ? "Canvas" : "Editor"}</button></div>
    {!canvas ? <div className="studio-editor-empty"><div aria-hidden="true">⌘</div><strong>No verified file or Canvas revision</strong><p>Open an identity-bound file from Harness activity, or create a display-only Canvas revision from a parent response.</p></div> : <div className="studio-canvas-editor"><div className="studio-editor-meta"><span>Display revision {canvas.displayRevision}</span><span>{dirty ? "Unsaved display changes" : "Saved display revision"}</span></div><textarea aria-label="Canvas content" value={content} onChange={(event) => setContent(event.target.value.slice(0, 2 * 1024 * 1024))} /><p>Canvas changes affect Studio presentation only. Applying a revision does not rewrite Harness history.</p></div>}
    <footer><button type="button" disabled>Save</button>{canvas && <button type="button" className="studio-editor-primary" disabled={!dirty || !onCanvasApply} onClick={() => onCanvasApply?.(content)}>Apply display revision</button>}</footer>
  </div>;
}

import type { ReactNode } from "react";

import { solveLayout, type LayoutInput } from "./layoutSolver";
import { PaneSeparator } from "./PaneSeparator";
import "./shell.css";

export function WorkspaceShell({
  viewport,
  sidebar,
  inspector,
  editor,
  sidebarContent,
  sidebarRailContent,
  conversation,
  inspectorContent,
  editorContent,
  conversationLabel = "Conversation",
  onSidebarPreferred,
  onInspectorPreferred,
  onEditorPreferred,
  activeSheet = null,
}: LayoutInput & {
  readonly sidebarContent: ReactNode;
  readonly sidebarRailContent?: ReactNode;
  readonly conversation: ReactNode;
  readonly inspectorContent?: ReactNode;
  readonly editorContent?: ReactNode;
  readonly conversationLabel?: string;
  readonly onSidebarPreferred?: (width: number) => void;
  readonly onInspectorPreferred?: (width: number) => void;
  readonly onEditorPreferred?: (width: number) => void;
  readonly activeSheet?: "sidebar" | "inspector" | "editor" | null;
}) {
  const layout = solveLayout({ viewport, sidebar, inspector, editor });
  const sidebarAttached = layout.sidebar.mode !== "sheet";
  const inspectorAttached = layout.inspector.mode === "pane";
  const editorAttached = layout.editor.mode === "pane";
  const columns = sidebarAttached ? [layout.sidebar.width, 8, layout.centerWidth] : [layout.centerWidth];
  if (inspectorAttached) columns.push(8, layout.inspector.width);
  if (editorAttached) columns.push(8, layout.editor.width);

  return (
    <div className="studio-shell" style={{ gridTemplateColumns: columns.map((width) => `${width}px`).join(" ") }}>
      {layout.sidebar.mode !== "sheet" && (
        <nav className="studio-sidebar" aria-label="Projects and chats" data-mode={layout.sidebar.mode}>
          {layout.sidebar.mode === "rail" ? (sidebarRailContent ?? sidebarContent) : sidebarContent}
        </nav>
      )}
      {sidebarAttached && (layout.sidebar.mode === "pane" && onSidebarPreferred ? (
        <PaneSeparator label="Resize project sidebar" value={layout.sidebar.width} min={210} max={380} onChange={onSidebarPreferred} onReset={() => onSidebarPreferred(264)} />
      ) : <div className="studio-pane-divider" />)}
      <main className="studio-conversation" aria-label={conversationLabel}>{conversation}</main>
      {inspectorAttached && <>
        {onInspectorPreferred ? <PaneSeparator label="Resize Harness inspector" value={layout.inspector.width} min={300} max={600} direction={-1} onChange={onInspectorPreferred} onReset={() => onInspectorPreferred(384)} /> : <div className="studio-pane-divider" />}
        <aside className="studio-inspector" aria-label="Harness">{inspectorContent}</aside>
      </>}
      {editorAttached && <>
        {onEditorPreferred ? <PaneSeparator label="Resize editor" value={layout.editor.width} min={280} max={600} direction={-1} onChange={onEditorPreferred} onReset={() => onEditorPreferred(400)} /> : <div className="studio-pane-divider" />}
        <section className="studio-editor" aria-label="Editor">{editorContent}</section>
      </>}
      {layout.sidebar.mode === "sheet" && activeSheet === "sidebar" && <nav className="studio-sheet studio-sheet-left" aria-label="Projects and chats">{sidebarContent}</nav>}
      {layout.inspector.mode === "sheet" && activeSheet === "inspector" && <aside className="studio-sheet studio-sheet-right" aria-label="Harness">{inspectorContent}</aside>}
      {layout.editor.mode === "sheet" && activeSheet === "editor" && <section className="studio-sheet studio-sheet-right" aria-label="Editor">{editorContent}</section>}
    </div>
  );
}

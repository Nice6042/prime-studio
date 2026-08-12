import type { ReactNode } from "react";

import { layoutBounds, solveLayout, type LayoutInput } from "./layoutSolver";
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
  const narrow = viewport < layoutBounds.sheetBreakpoint;
  const columns = sidebarAttached ? [layout.sidebar.width, layoutBounds.handle, layout.centerWidth] : [layout.centerWidth];
  if (editorAttached) columns.push(layoutBounds.handle, layout.editor.width);
  if (inspectorAttached) columns.push(layoutBounds.handle, layout.inspector.width);

  return (
    <div className="studio-shell" style={{ gridTemplateColumns: columns.map((width) => `${width}px`).join(" ") }}>
      {layout.sidebar.mode !== "sheet" && (
        <nav className="studio-sidebar" aria-label="Projects and chats" data-mode={layout.sidebar.mode}>
          {layout.sidebar.mode === "rail" ? (sidebarRailContent ?? sidebarContent) : sidebarContent}
        </nav>
      )}
      {sidebarAttached && (layout.sidebar.mode === "pane" && onSidebarPreferred ? (
        <PaneSeparator label="Resize project sidebar" value={layout.sidebar.width} min={layoutBounds.sidebar.minimum} max={layoutBounds.sidebar.maximum} onChange={onSidebarPreferred} onReset={() => onSidebarPreferred(layoutBounds.sidebar.default)} />
      ) : <div className="studio-pane-divider" />)}
      <main className="studio-conversation" aria-label={conversationLabel}>{conversation}</main>
      {editorAttached && <>
        {onEditorPreferred ? <PaneSeparator label="Resize editor" value={layout.editor.width} min={layoutBounds.editor.minimum} max={layoutBounds.editor.maximum} direction={-1} onChange={onEditorPreferred} onReset={() => onEditorPreferred(layoutBounds.editor.default)} /> : <div className="studio-pane-divider" />}
        <section className="studio-editor" aria-label="Editor">{editorContent}</section>
      </>}
      {inspectorAttached && <>
        {onInspectorPreferred ? <PaneSeparator label="Resize Harness inspector" value={layout.inspector.width} min={layoutBounds.inspector.minimum} max={layoutBounds.inspector.maximum} direction={-1} onChange={onInspectorPreferred} onReset={() => onInspectorPreferred(layoutBounds.inspector.default)} /> : <div className="studio-pane-divider" />}
        <aside className="studio-inspector" aria-label="Harness">{inspectorContent}</aside>
      </>}
      {narrow && activeSheet === "sidebar" && <nav className="studio-sheet studio-sheet-left studio-sidebar-sheet" data-studio-sheet="sidebar" aria-label="Projects and chats">{sidebarContent}</nav>}
      {layout.inspector.mode === "sheet" && activeSheet === "inspector" && <aside className="studio-sheet studio-sheet-right studio-harness-sheet" data-studio-sheet="inspector" aria-label="Harness">{inspectorContent}</aside>}
      {layout.editor.mode === "sheet" && activeSheet === "editor" && <section className="studio-sheet studio-sheet-right" data-studio-sheet="editor" aria-label="Editor">{editorContent}</section>}
    </div>
  );
}

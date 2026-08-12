export interface LayoutInput {
  readonly viewport: number;
  readonly sidebar: Readonly<{ open: boolean; preferred: number }>;
  readonly inspector: Readonly<{ open: boolean; preferred: number }>;
  readonly editor: Readonly<{ open: boolean; preferred: number }>;
}

export interface LayoutResult {
  readonly sidebar: Readonly<{ mode: "pane" | "rail" | "sheet"; width: number }>;
  readonly inspector: Readonly<{ mode: "pane" | "sheet" | "closed"; width: number }>;
  readonly editor: Readonly<{ mode: "pane" | "sheet" | "closed"; width: number }>;
  readonly centerWidth: number;
}

export const layoutBounds = Object.freeze({
  centerMinimum: 340,
  handle: 8,
  rail: 56,
  sidebar: { minimum: 210, maximum: 380, default: 264 },
  inspector: { minimum: 280, maximum: 520, default: 384 },
  editor: { minimum: 280, maximum: 600, default: 400 },
  sheetBreakpoint: 760,
});

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

export function solveLayout(input: LayoutInput): LayoutResult {
  const viewport = Math.max(0, finite(input.viewport, 0));
  const sidebarPreferred = clamp(input.sidebar.preferred, 210, 380, 264);
  const inspectorPreferred = clamp(input.inspector.preferred, layoutBounds.inspector.minimum, layoutBounds.inspector.maximum, layoutBounds.inspector.default);
  const editorPreferred = clamp(input.editor.preferred, 280, Math.min(600, Math.max(280, viewport * 0.46)), 400);

  if (viewport < layoutBounds.sheetBreakpoint) {
    return {
      sidebar: input.sidebar.open
        ? { mode: "sheet", width: Math.min(viewport, Math.max(320, sidebarPreferred)) }
        : { mode: "rail", width: Math.min(viewport, layoutBounds.rail) },
      inspector: input.inspector.open
        ? { mode: "sheet", width: Math.min(viewport, inspectorPreferred) }
        : { mode: "closed", width: 0 },
      editor: input.editor.open
        ? { mode: "sheet", width: Math.min(viewport, editorPreferred) }
        : { mode: "closed", width: 0 },
      centerWidth: viewport,
    };
  }

  let sidebar: LayoutResult["sidebar"] = input.sidebar.open
    ? { mode: "pane", width: sidebarPreferred }
    : { mode: "rail", width: layoutBounds.rail };
  let inspector: LayoutResult["inspector"] = input.inspector.open
    ? { mode: "pane", width: inspectorPreferred }
    : { mode: "closed", width: 0 };
  let editor: LayoutResult["editor"] = input.editor.open
    ? { mode: "pane", width: editorPreferred }
    : { mode: "closed", width: 0 };

  const occupied = () => {
    const widths = (sidebar.mode === "sheet" ? 0 : sidebar.width)
      + (inspector.mode === "pane" ? inspector.width : 0)
      + (editor.mode === "pane" ? editor.width : 0);
    const attached = 1 + Number(inspector.mode === "pane") + Number(editor.mode === "pane");
    return widths + attached * layoutBounds.handle;
  };
  const hasCenter = () => viewport - occupied() >= layoutBounds.centerMinimum;

  if (!hasCenter() && sidebar.mode === "pane") sidebar = { mode: "rail", width: layoutBounds.rail };
  if (!hasCenter() && inspector.mode === "pane" && editor.mode === "pane") inspector = { mode: "sheet", width: inspector.width };
  if (!hasCenter() && inspector.mode === "pane") inspector = { mode: "sheet", width: inspector.width };
  if (!hasCenter() && editor.mode === "pane") editor = { mode: "sheet", width: editor.width };

  let centerWidth = Math.max(0, viewport - occupied());
  if (centerWidth < layoutBounds.centerMinimum && editor.mode === "pane") {
    const reduction = layoutBounds.centerMinimum - centerWidth;
    const nextWidth = Math.max(layoutBounds.editor.minimum, editor.width - reduction);
    editor = { mode: "pane", width: nextWidth };
    centerWidth = Math.max(0, viewport - occupied());
  }

  return { sidebar, inspector, editor, centerWidth };
}

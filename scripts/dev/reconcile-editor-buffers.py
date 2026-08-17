from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

BASE = "0cf372430c5bb18a07f86a34e4d9079a0733cc27"
REVIEWED = "c8531df121a7bb9b0429f2b912756faaed36e0ca"
MERGE_PATHS = (
    "app/src/app/StudioApp.tsx",
    "app/src/features/editor/EditorPane.tsx",
    "app/src/features/editor/EditorPane.test.tsx",
    "app/e2e/acceptance-matrix.spec.ts",
)


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git_show(ref: str, path: str) -> str:
    result = run("git", "show", f"{ref}:{path}")
    if not result.stdout:
        raise SystemExit(f"{ref}:{path} is empty")
    return result.stdout


def merge_reviewed_path(path: str) -> None:
    target = Path(path)
    with tempfile.TemporaryDirectory(prefix="prime-editor-merge-") as directory:
        root = Path(directory)
        current = root / "current"
        base = root / "base"
        reviewed = root / "reviewed"
        current.write_text(target.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
        base.write_text(git_show(BASE, path), encoding="utf-8", newline="\n")
        reviewed.write_text(git_show(REVIEWED, path), encoding="utf-8", newline="\n")
        result = run(
            "git",
            "merge-file",
            "-p",
            str(current),
            str(base),
            str(reviewed),
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(
                f"three-way merge failed for {path}\n{result.stdout}\n{result.stderr}"
            )
        target.write_text(result.stdout, encoding="utf-8", newline="\n")


def splice(
    text: str,
    start_marker: str,
    end_marker: str,
    replacement: str,
    label: str,
) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"{label}: start marker unavailable")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"{label}: end marker unavailable")
    return text[:start] + replacement + text[end:]


def harden_studio_app() -> None:
    path = Path("app/src/app/StudioApp.tsx")
    text = path.read_text(encoding="utf-8")

    mode_block = '''      case "editor.mode.select": {
        const visibleArtifact = editorArtifact?.ref.rootSessionId === selectedSession?.sessionId ? editorArtifact : null;
        const visibleCanvas = canvas?.chatId === navigation.selectedChatId && canvas.sessionId === selectedSession?.sessionId ? canvas : null;
        const activeDocumentId = visibleArtifact
          ? artifactEditorDocumentId(visibleArtifact)
          : visibleCanvas ? canvasEditorDocumentId(visibleCanvas) : null;
        if (activeDocumentId === null) return { status: "unavailable", reason: "No identity-bound editor document is selected." };
        if (operation.payload.documentId !== activeDocumentId) {
          return { status: "rejected", reason: "The editor document changed before its mode could be selected.", retryable: false };
        }
        if (operation.payload.mode === "diff" && !visibleArtifact) {
          return { status: "rejected", reason: "Diff mode requires an admitted artifact revision.", retryable: false };
        }
        setEditorMode(operation.payload.mode);
        return { status: "updated", revision: activeDocumentId };
      }
'''
    text = splice(
        text,
        '      case "editor.mode.select": {',
        '      case "conversation.suggestion.fill":',
        mode_block,
        "session-bound editor mode",
    )

    projection_marker = (
        "const visibleCanvas = canvas?.chatId === navigation.selectedChatId "
        "&& canvas.sessionId === selectedSession?.sessionId ? canvas : null;"
    )
    projection_start = text.rfind(projection_marker)
    projection_end = text.find('  return <div className="studio-application">', projection_start)
    if projection_start < 0 or projection_end < 0:
        raise SystemExit("active editor projection range unavailable")
    projection_line_start = text.rfind("\n", 0, projection_start) + 1
    projection = '''  const visibleArtifact = editorArtifact?.ref.rootSessionId === selectedSession?.sessionId ? editorArtifact : null;
  const visibleCanvas = canvas?.chatId === navigation.selectedChatId && canvas.sessionId === selectedSession?.sessionId ? canvas : null;
  const activeEditorDocumentId = visibleArtifact
    ? artifactEditorDocumentId(visibleArtifact)
    : visibleCanvas ? canvasEditorDocumentId(visibleCanvas) : null;
  const activeEditorBaseline = visibleArtifact?.content ?? visibleCanvas?.content;
  const activeEditorDraftContent = activeEditorDocumentId ? readEditorBuffer(editorBuffers, activeEditorDocumentId) : undefined;
  const onActiveEditorDraftChange = activeEditorDocumentId && activeEditorBaseline !== undefined ? (content: string) => {
    setEditorBuffers((current) => content === activeEditorBaseline
      ? removeEditorBuffer(current, activeEditorDocumentId)
      : writeEditorBuffer(current, activeEditorDocumentId, content));
  } : undefined;

'''
    text = text[:projection_line_start] + projection + text[projection_end:]

    render_start = text.find("editorContent={<EditorPane")
    render_end = text.find('    />\n    <RuntimeStatusBar', render_start)
    if render_start < 0 or render_end < 0:
        raise SystemExit("EditorPane render range unavailable")
    render_line_start = text.rfind("\n", 0, render_start) + 1
    editor_render = '''      editorContent={<EditorPane
        onClose={() => { void dispatchOperation({ action: "layout.editor.close", payload: {} }); }}
        documentId={activeEditorDocumentId}
        mode={visibleArtifact || visibleCanvas ? editorMode : "edit"}
        onExecute={dispatchOperation}
        artifact={visibleArtifact}
        admissionRevision={editorAdmissionRevision}
        draftContent={activeEditorDraftContent}
        onDraftChange={onActiveEditorDraftChange}
        unsupportedReason="Open an identity-bound candidate from Harness Outputs, Sources, Activity, or a subagent file list."
        canvas={visibleCanvas}
      />}
'''
    text = text[:render_line_start] + editor_render + text[render_end:]

    for stale in (
        "artifactModeDocumentId",
        "canvasModeDocumentId",
        "artifactDraftKey",
        "artifactDrafts",
        "setArtifactDrafts",
    ):
        if stale in text:
            raise SystemExit(f"stale editor draft authority survived integration: {stale}")
    if "const [editorBuffers, setEditorBuffers] = useState(createEditorBufferState);" not in text:
        raise SystemExit("editor buffer state integration is missing")
    path.write_text(text, encoding="utf-8", newline="\n")


def repair_editor_tests() -> None:
    path = Path("app/src/features/editor/EditorPane.test.tsx")
    text = path.read_text(encoding="utf-8")

    start = text.find("const documentId = paneProps.artifact")
    end = text.find("  return <EditorPane", start)
    if start < 0 or end < 0:
        raise SystemExit("controlled editor identity range unavailable")
    line_start = text.rfind("\n", 0, start) + 1
    document_block = '''  const documentId = paneProps.artifact
    ? artifactEditorDocumentId(paneProps.artifact)
    : paneProps.canvas ? canvasEditorDocumentId(paneProps.canvas) : null;
'''
    text = text[:line_start] + document_block + text[end:]
    text = text.replace(
        'JSON.stringify(["b", "s", "a", 7, "sha256:exact"])',
        'JSON.stringify(["artifact", "b", "s", "a", 7, "sha256:exact"])',
    )
    text = text.replace(
        'JSON.stringify(["broker", "root", "artifact", 7, "sha256:old"])',
        'JSON.stringify(["artifact", "broker", "root", "artifact", 7, "sha256:old"])',
    )

    canvas_start = text.find(
        'it("restores a Canvas draft only for the same session and source identity"'
    )
    canvas_end = text.find(
        '  it("uses a newly reconciled native revision and identity for the next exact save"',
        canvas_start,
    )
    if canvas_start < 0 or canvas_end < 0:
        raise SystemExit("Canvas draft test range unavailable")
    canvas_line_start = text.rfind("\n", 0, canvas_start) + 1
    canvas_test = '''  it("restores a Canvas draft only for the same session and source identity", async () => {
    const drafts = new Map<string, string>();
    const firstCanvas: CanvasDocument = { sessionId: "session-one", chatId: "chat-1", messageId: "message-1", sourceVersion: 0, displayRevision: 1, content: "original" };
    const otherSession: CanvasDocument = { ...firstCanvas, sessionId: "session-two" };
    const renderCanvas = (canvas: CanvasDocument) => {
      const key = canvasEditorDocumentId(canvas);
      return render(<ControlledEditorPane onClose={() => undefined} canvas={canvas} draftContent={drafts.get(key)} onDraftChange={(content) => drafts.set(key, content)} />);
    };

    const first = renderCanvas(firstCanvas);
    await userEvent.clear(screen.getByRole("textbox", { name: "Canvas content" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Canvas content" }), "session one draft");
    first.unmount();

    const second = renderCanvas(otherSession);
    expect(screen.getByRole("textbox", { name: "Canvas content" })).toHaveValue("original");
    second.unmount();

    renderCanvas(firstCanvas);
    expect(screen.getByRole("textbox", { name: "Canvas content" })).toHaveValue("session one draft");
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2);
  });

'''
    text = text[:canvas_line_start] + canvas_test + text[canvas_end:]
    path.write_text(text, encoding="utf-8", newline="\n")


def strengthen_e2e_isolation() -> None:
    path = Path("app/e2e/acceptance-matrix.spec.ts")
    text = path.read_text(encoding="utf-8")
    anchor = '''  await editor.getByRole("textbox", { name: "File content" }).fill("Unapplied file draft.");
  await editor.getByRole("button", { name: "Close editor" }).click();

  await harness.locator("summary").filter({ hasText: /^Sources/u }).click();
'''
    replacement = '''  await editor.getByRole("textbox", { name: "File content" }).fill("Unapplied file draft.");
  await editor.getByRole("button", { name: "Close editor" }).click();

  await sidebar.getByRole("button", { name: /Inactive planning notes.*status: Idle/i }).click();
  await expect(shellPage.getByRole("region", { name: "Inactive planning notes" })).toBeVisible();
  await shellPage.getByRole("button", { name: "Open editor" }).click();
  await expect(editor.getByText("No verified file or Canvas revision")).toBeVisible();
  await editor.getByRole("button", { name: "Close editor" }).click();
  await sidebar.getByRole("button", { name: /Prime Harness architecture.*status: Working/i }).first().click();
  await expect(shellPage.getByRole("main", { name: "Prime Harness architecture" })).toBeVisible();
  await shellPage.getByRole("button", { name: "Open editor" }).click();
  await expect(editor.getByRole("textbox", { name: "File content" })).toHaveValue("Unapplied file draft.");
  await editor.getByRole("button", { name: "Close editor" }).click();

  await harness.locator("summary").filter({ hasText: /^Sources/u }).click();
'''
    if text.count(anchor) != 1:
        raise SystemExit(
            f"cross-session artifact isolation anchor count was {text.count(anchor)}"
        )
    path.write_text(text.replace(anchor, replacement), encoding="utf-8", newline="\n")


def validate_source_boundaries() -> None:
    studio = Path("app/src/app/StudioApp.tsx").read_text(encoding="utf-8")
    e2e = Path("app/e2e/acceptance-matrix.spec.ts").read_text(encoding="utf-8")
    store = Path("app/src/features/editor/editorBufferStore.ts").read_text(
        encoding="utf-8"
    )
    required = (
        "const [editorBuffers, setEditorBuffers] = useState(createEditorBufferState);",
        "const visibleArtifact = editorArtifact?.ref.rootSessionId === selectedSession?.sessionId",
        "draftContent={activeEditorDraftContent}",
        "onDraftChange={onActiveEditorDraftChange}",
    )
    missing = [value for value in required if value not in studio]
    if missing:
        raise SystemExit(f"Studio editor integration is incomplete: {missing}")
    if "file and Canvas drafts persist without crossing editor identities" not in e2e:
        raise SystemExit("editor draft end-to-end evidence is missing")
    if "MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS" not in store:
        raise SystemExit("editor buffer total budget is missing")


for merge_path in MERGE_PATHS:
    merge_reviewed_path(merge_path)

harden_studio_app()
repair_editor_tests()
strengthen_e2e_isolation()
validate_source_boundaries()
Path(__file__).unlink()

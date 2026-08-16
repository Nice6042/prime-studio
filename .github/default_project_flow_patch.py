from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{path}: expected one patch anchor, found {count}")
    target.write_text(text.replace(before, after), encoding="utf-8", newline="\n")


replace_once(
    "app/src/features/navigation/ProjectSidebar.tsx",
    'export function CreateProjectDialog({ onCreate, onCancel, restoreFocusTo }: {\n  readonly onCreate: (name: string, folderPath: string) => void;\n  readonly onCancel: () => void;\n  readonly restoreFocusTo?: HTMLElement | null;\n}) {\n  const [projectName, setProjectName] = useState("");\n  const [folderPath, setFolderPath] = useState("");',
    'export function CreateProjectDialog({ onCreate, onCancel, restoreFocusTo, initialFolderPath = "" }: {\n  readonly onCreate: (name: string, folderPath: string) => void;\n  readonly onCancel: () => void;\n  readonly restoreFocusTo?: HTMLElement | null;\n  readonly initialFolderPath?: string;\n}) {\n  const [projectName, setProjectName] = useState("");\n  const [folderPath, setFolderPath] = useState(initialFolderPath);',
)
replace_once(
    "app/src/features/navigation/ProjectSidebar.tsx",
    '  onExecuteWorkspaceOperation,\n  onCollapse,\n  newChatDisabledReason,\n}: {',
    '  onExecuteWorkspaceOperation,\n  onCollapse,\n  newChatDisabledReason,\n  defaultProjectFolder = "",\n}: {',
)
replace_once(
    "app/src/features/navigation/ProjectSidebar.tsx",
    '  readonly newChatDisabledReason?: string;\n}) {',
    '  readonly newChatDisabledReason?: string;\n  readonly defaultProjectFolder?: string;\n}) {',
)
replace_once(
    "app/src/features/navigation/ProjectSidebar.tsx",
    '{creatingProject && <CreateProjectDialog restoreFocusTo={newProjectRef.current} onCancel={() => setCreatingProject(false)} onCreate={(name, path) => { onNewProject?.(name, path); setCreatingProject(false); }} />}',
    '{creatingProject && <CreateProjectDialog initialFolderPath={defaultProjectFolder} restoreFocusTo={newProjectRef.current} onCancel={() => setCreatingProject(false)} onCreate={(name, path) => { onNewProject?.(name, path); setCreatingProject(false); }} />}',
)

replace_once(
    "app/src/app/StudioApp.tsx",
    '        onNewProject={createProject}\n        newChatDisabledReason={newChatDisabledReason}',
    '        onNewProject={createProject}\n        defaultProjectFolder={settings.defaultCwd ?? ""}\n        newChatDisabledReason={newChatDisabledReason}',
)
create_dialog = '{createProjectOpen && <CreateProjectDialog restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}'
replacement = '{createProjectOpen && <CreateProjectDialog initialFolderPath={settings.defaultCwd ?? ""} restoreFocusTo={createProjectOpener} onCancel={() => { void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} onCreate={(name, folderPath) => { createProject(name, folderPath); void dispatchOperation({ action: "surface.popover.toggle", payload: { popoverId: null } }); }} />}'
studio = Path("app/src/app/StudioApp.tsx")
studio_text = studio.read_text(encoding="utf-8")
if studio_text.count(create_dialog) != 2:
    raise SystemExit(f"StudioApp.tsx: expected two create-project overlays, found {studio_text.count(create_dialog)}")
studio.write_text(studio_text.replace(create_dialog, replacement), encoding="utf-8", newline="\n")

replace_once(
    "app/src/features/settings/SettingsPages.tsx",
    '<Row label="Default project" description="New resident chats use this user-selected working directory; clearing it asks each time.">',
    '<Row label="Default project" description="New folder-project dialogs start from this user-selected working directory; clearing it requires choosing a folder each time.">',
)
replace_once(
    "app/src/features/settings/SettingsPages.tsx",
    '<span className="studio-setting-value studio-setting-path">{settings.defaultCwd || "Ask each time"}</span>',
    '<span className="studio-setting-value studio-setting-path">{settings.defaultCwd || "Choose each time"}</span>',
)
replace_once(
    "app/src/features/settings/SettingsPages.tsx",
    '>Ask each time</button>',
    '>Choose each time</button>',
)

project_test = Path("app/src/features/navigation/ProjectSidebar.test.tsx")
project_text = project_test.read_text(encoding="utf-8")
anchor = '  it("collects a project name and folder before requesting durable creation", async () => {\n'
evidence = '''  it("prefills a new folder project from the configured default without silently creating it", async () => {
    const onNewProject = vi.fn();
    render(<ProjectSidebar {...workspaceProps} projects={projects} defaultProjectFolder="D:\\\\work\\\\prime" onSelectChat={() => undefined} onToggleProject={() => undefined}
      onNewChat={() => undefined} onOpenSettings={() => undefined} onNewProject={onNewProject} />);

    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByRole("textbox", { name: "Folder path" })).toHaveValue("D:\\\\work\\\\prime");
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    expect(onNewProject).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "Default-root project");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(onNewProject).toHaveBeenCalledWith("Default-root project", "D:\\\\work\\\\prime");
  });

'''
if project_text.count(anchor) != 1:
    raise SystemExit("ProjectSidebar.test.tsx: creation test anchor is not unique")
project_test.write_text(project_text.replace(anchor, evidence + anchor), encoding="utf-8", newline="\n")

replace_once(
    "app/src/features/settings/SettingsShell.test.tsx",
    'screen.getByRole("button", { name: "Ask each time" })',
    'screen.getByRole("button", { name: "Choose each time" })',
)

replace_once(
    "app/e2e/browser-shell.spec.ts",
    '  await shellPage.getByRole("button", { name: "Browse default workspace" }).click();\n  await expect(shellPage.getByText("D:\\\\fixture\\\\Selected Workspace", { exact: true })).toBeVisible();\n\n  const setRange',
    '  await shellPage.getByRole("button", { name: "Browse default workspace" }).click();\n  await expect(shellPage.getByText("D:\\\\fixture\\\\Selected Workspace", { exact: true })).toBeVisible();\n  await shellPage.getByRole("button", { name: "Back to chat" }).click();\n  await shellPage.getByRole("button", { name: "New project" }).click();\n  await expect(shellPage.getByRole("textbox", { name: "Folder path" })).toHaveValue("D:\\\\fixture\\\\Selected Workspace");\n  await expect(shellPage.getByRole("button", { name: "Create project" })).toBeDisabled();\n  await shellPage.keyboard.press("Escape");\n  await shellPage.keyboard.press("Control+,");\n  await shellPage.getByRole("button", { name: /^General/ }).click();\n\n  const setRange',
)

for temporary in (
    ".github/workflows/apply-default-project-flow.yml",
    ".github/workflows/repair-default-project-workflow.yml",
    ".github/default_project_flow_patch.py",
):
    path = Path(temporary)
    if path.exists():
        path.unlink()

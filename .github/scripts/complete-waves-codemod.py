from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


replace_once(
    "app/src-tauri/src/commands/harness.rs",
    ".find(|chat| chat.id == request.source_chat_id && !chat.archived)\n                    .ok_or_else(|| \"Source catalog chat is unavailable\".to_owned())?;",
    ".find(|chat| chat.id == request.source_chat_id)\n                    .ok_or_else(|| \"Source catalog chat is unavailable\".to_owned())?;",
)
replace_once(
    "app/src-tauri/src/commands/harness.rs",
    ".find(|chat| chat.id == source.id && !chat.archived)\n                    .ok_or_else(|| \"Source catalog chat changed during branch\".to_owned())?;",
    ".find(|chat| chat.id == source.id)\n                    .ok_or_else(|| \"Source catalog chat changed during branch\".to_owned())?;",
)

replace_once(
    "app/src/app/StudioApp.tsx",
    '''  const branchResidentChat = async (sessionId: string, messageId: string): Promise<StudioOperationOutcome> => {
    const current = store.getSnapshot();
    const revision = current.catalogRevision;
    if (revision === null) return { status: "unavailable", reason: "Branching failed because the project catalog is unavailable." };
    const sourceSession = current.sessions[sessionId];
    const matches = current.projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({ project, chat }))).filter(({ chat }) => (
      !chat.archived
      && chat.binding?.sessionId === sessionId
      && chat.id === current.navigation.selectedChatId
    ));''',
    '''  const branchResidentChat = async (
    sessionId: string,
    messageId: string,
    sourceChatId: string | null = null,
    allowArchivedSource = false,
  ): Promise<StudioOperationOutcome> => {
    const current = store.getSnapshot();
    const revision = current.catalogRevision;
    if (revision === null) return { status: "unavailable", reason: "Branching failed because the project catalog is unavailable." };
    const sourceSession = current.sessions[sessionId];
    const requestedChatId = sourceChatId ?? current.navigation.selectedChatId;
    const matches = current.projectCatalog.projects.flatMap((project) => project.chats.map((chat) => ({ project, chat }))).filter(({ chat }) => (
      chat.archived === allowArchivedSource
      && chat.binding?.sessionId === sessionId
      && chat.id === requestedChatId
    ));''',
)

replace_once(
    "app/src/app/StudioApp.tsx",
    '''      return { status: "rejected", reason, retryable: true };
    }
  };

  const harnessExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {''',
    '''      return { status: "rejected", reason, retryable: true };
    }
  };

  const forkArchivedChat = async (chatId: string): Promise<void> => {
    const current = store.getSnapshot();
    const matches = current.projectCatalog.projects
      .filter((project) => !project.archived)
      .flatMap((project) => project.chats.map((chat) => ({ project, chat })))
      .filter(({ chat }) => chat.id === chatId && chat.archived);
    const source = matches.length === 1 ? matches[0] : null;
    const binding = source?.chat.binding ?? null;
    const session = binding ? current.sessions[binding.sessionId] ?? null : null;
    const message = session?.parentMessages[session.parentMessages.length - 1] ?? null;
    if (
      !source
      || !binding
      || !session
      || binding.accountId !== session.accountId
      || (binding.agentId !== null && binding.agentId !== session.chatId)
      || !message
    ) {
      setCatalogOperation({ phase: "error", message: "The archived chat has no authoritative resident message to branch." });
      return;
    }
    const outcome = await branchResidentChat(session.sessionId, message.id, chatId, true);
    if (operationAccepted(outcome.status)) store.dispatch({ type: "route/workspace" });
  };

  const harnessExecutor = async (operation: StudioOperation): Promise<StudioOperationOutcome> => {''',
)

replace_once(
    "app/src/app/StudioApp.tsx",
    '''          <ArchivedCatalogSettings catalog={projectCatalog} operation={catalogOperation} onRestoreProject={(projectId) => { void dispatchOperation({ action: "catalog.project.restore", payload: { projectId } }); }} onRestoreChat={(_projectId, chatId) => { void dispatchOperation({ action: "catalog.chat.restore", payload: { chatId } }); }} />''',
    '''          <ArchivedCatalogSettings catalog={projectCatalog} operation={catalogOperation} onRestoreProject={(projectId) => { void dispatchOperation({ action: "catalog.project.restore", payload: { projectId } }); }} onRestoreChat={(_projectId, chatId) => { void dispatchOperation({ action: "catalog.chat.restore", payload: { chatId } }); }} onForkChat={(chatId) => { void forkArchivedChat(chatId); }} />''',
)

replace_once(
    "app/src/contracts/packageAcceptance.ts",
    'row("CV-15", "archived transcripts are read-only and may fork to continue", "partial", ["conversation.archive-fork"])',
    'row("CV-15", "archived transcripts are read-only and may fork to continue", "complete", ["conversation.archive-fork"])',
)
replace_once(
    "app/src/contracts/packageAcceptance.test.ts",
    "      complete: 71,\n      partial: 42,",
    "      complete: 72,\n      partial: 41,",
)
replace_once(
    "app/src/contracts/packageAcceptance.test.ts",
    '    expect(status("CV-15")).toBe("partial");',
    '    expect(status("CV-15")).toBe("complete");',
)

replace_once(
    "app/src/features/settings/ArchivedCatalogSettings.test.tsx",
    '''  it("keeps archive fork visible but disabled when the verified Harness has no atomic archive-fork authority", () => {''',
    '''  it("invokes the admitted archive-fork handler without restoring the source chat", async () => {
    const onForkChat = vi.fn();
    render(<ArchivedCatalogSettings catalog={archivedCatalog()} operation={{ phase: "idle" }}
      onRestoreProject={vi.fn()} onRestoreChat={vi.fn()} onForkChat={onForkChat} />);

    await userEvent.click(screen.getByRole("button", { name: "Fork archived chat Old chat" }));

    expect(onForkChat).toHaveBeenCalledWith("chat:old");
  });

  it("keeps archive fork visible but disabled when the verified Harness has no atomic archive-fork authority", () => {''',
)

Path(".github/workflows/complete-waves-codemod.yml").unlink()
Path(".github/scripts/complete-waves-codemod.py").unlink()

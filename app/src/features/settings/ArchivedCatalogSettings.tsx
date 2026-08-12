import { createControlBinding } from "../../contracts/studioOperations";
import type { ProjectChatState } from "../../domain/projectChats";
import type { WorkspaceOperationState } from "../conversation/workspacePresentation";

export function ArchivedCatalogSettings({ catalog, operation, onRestoreProject, onRestoreChat }: {
  readonly catalog: ProjectChatState;
  readonly operation: WorkspaceOperationState;
  readonly onRestoreProject: (projectId: string) => void;
  readonly onRestoreChat: (projectId: string, chatId: string) => void;
}) {
  const projects = catalog.projects.filter((project) => project.archived);
  const chats = catalog.projects.filter((project) => !project.archived).flatMap((project) =>
    project.chats.filter((chat) => chat.archived).map((chat) => ({ ...chat, projectName: project.name })),
  );
  const busy = operation.phase === "pending";

  return <div className="studio-archived-catalog">
    {projects.length === 0 && chats.length === 0 && <p className="studio-archived-empty">No archived projects or chats.</p>}
    {projects.length > 0 && <section aria-labelledby="archived-projects-title">
      <h2 id="archived-projects-title">Archived projects</h2>
      <div className="studio-archived-list">{projects.map((project) => <article key={project.id}>
        <span><strong>{project.name}</strong><small>{project.root.kind === "folder" ? project.root.path : "Personal"}</small></span>
        <button type="button" {...createControlBinding(`archived-project-${project.id}`, "catalog.project.restore")} disabled={busy} aria-label={`Restore project ${project.name}`} onClick={() => onRestoreProject(project.id)}>Restore</button>
      </article>)}</div>
    </section>}
    {chats.length > 0 && <section aria-labelledby="archived-chats-title">
      <h2 id="archived-chats-title">Archived chats</h2>
      <div className="studio-archived-list">{chats.map((chat) => <article key={chat.id}>
        <span><strong>{chat.title}</strong><small>{chat.projectName}</small></span>
        <button type="button" {...createControlBinding(`archived-chat-${chat.id}`, "catalog.chat.restore")} disabled={busy} aria-label={`Restore chat ${chat.title}`} onClick={() => onRestoreChat(chat.projectId, chat.id)}>Restore</button>
      </article>)}</div>
    </section>}
    {operation.phase === "pending" && <p role="status">{operation.label}</p>}
    {operation.phase === "success" && <p role="status">{operation.message}</p>}
    {operation.phase === "error" && <p role="alert">{operation.message}</p>}
  </div>;
}

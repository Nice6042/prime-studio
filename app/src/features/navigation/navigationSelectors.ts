import type { ProjectChatState } from "../../domain/projectChats";
import type { SessionEntities } from "../../entities/sessions/sessionStore";
import { projectChatLifecycle, type ChatLifecycleProjection } from "./chatLifecycle";

export interface NavigationChat {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly unread: boolean;
  readonly lifecycle: ChatLifecycleProjection;
  readonly lastActivityMs: number;
}

export interface NavigationProject {
  readonly id: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly expanded: boolean;
  readonly chats: readonly NavigationChat[];
}

export interface NavigationSelectorInput {
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly activityMs: Readonly<Record<string, number>>;
  readonly unreadChatIds: ReadonlySet<string>;
  readonly sessions: SessionEntities;
  readonly query: string;
}

export function selectNavigationProjects(
  state: ProjectChatState,
  input: NavigationSelectorInput,
): readonly NavigationProject[] {
  const query = Array.from(input.query.trim().toLocaleLowerCase()).slice(0, 200).join("");
  return state.projects
    .map((project, projectIndex) => ({ project, projectIndex }))
    .filter(({ project }) => !project.archived)
    .map(({ project, projectIndex }) => {
      const projectMatches = project.name.toLocaleLowerCase().includes(query);
      const chats = project.chats
        .map((chat, chatIndex) => ({ chat, chatIndex }))
        .filter(({ chat }) => !chat.archived && (!query || projectMatches || chat.title.toLocaleLowerCase().includes(query)))
        .sort((left, right) => Number(right.chat.pinned) - Number(left.chat.pinned)
          || (input.activityMs[right.chat.id] ?? 0) - (input.activityMs[left.chat.id] ?? 0)
          || left.chatIndex - right.chatIndex)
        .map(({ chat }) => ({
          id: chat.id,
          projectId: project.id,
          title: chat.title,
          pinned: chat.pinned,
          selected: state.selectedProjectId === project.id && project.selectedChatId === chat.id,
          unread: input.unreadChatIds.has(chat.id),
          lifecycle: projectChatLifecycle(chat, input.sessions),
          lastActivityMs: input.activityMs[chat.id] ?? 0,
        }));
      return {
        projectIndex,
        view: {
          id: project.id,
          name: project.name,
          pinned: project.pinned,
          expanded: Boolean(query) || input.expandedProjectIds.has(project.id),
          chats,
        } satisfies NavigationProject,
      };
    })
    .filter(({ view }) => !query || view.name.toLocaleLowerCase().includes(query) || view.chats.length > 0)
    .sort((left, right) => Number(right.view.pinned) - Number(left.view.pinned) || left.projectIndex - right.projectIndex)
    .map(({ view }) => view);
}

import { describe, expect, it } from "vitest";

import type { ProjectChatState } from "../../domain/projectChats";
import { selectNavigationProjects } from "./navigationSelectors";

const state: ProjectChatState = {
  schemaVersion: 2,
  selectedProjectId: "project-a",
  projects: [
    {
      id: "project:personal",
      kind: "personal",
      name: "Personal",
      root: { kind: "studio-managed-empty" },
      pinned: false,
      archived: false,
      selectedChatId: null,
      chats: [],
    },
    {
      id: "project-a",
      kind: "folder",
      name: "Prime Studio",
      root: { kind: "folder", path: "C:\\work\\prime-studio" },
      pinned: true,
      archived: false,
      selectedChatId: "chat-recent",
      chats: [
        { id: "chat-old", projectId: "project-a", title: "Architecture", pinned: true, archived: false, binding: null },
        { id: "chat-recent", projectId: "project-a", title: "Harness integration", pinned: false, archived: false, binding: null },
        { id: "chat-hidden", projectId: "project-a", title: "Archived", pinned: false, archived: true, binding: null },
      ],
    },
  ],
};

describe("navigation selectors", () => {
  it("sorts pinned projects and chats while preserving selected and unread truth", () => {
    const projects = selectNavigationProjects(state, {
      expandedProjectIds: new Set(["project-a"]),
      activityMs: { "chat-old": 1, "chat-recent": 20 },
      unreadChatIds: new Set(["chat-old"]),
      sessionStates: { "chat-recent": "working" },
      query: "",
    });

    expect(projects.map((project) => project.id)).toEqual(["project-a", "project:personal"]);
    expect(projects[0].chats.map((chat) => chat.id)).toEqual(["chat-old", "chat-recent"]);
    expect(projects[0].chats[0]).toMatchObject({ unread: true, selected: false });
    expect(projects[0].chats[1]).toMatchObject({ selected: true, status: "working" });
  });

  it("filters case-insensitively without revealing archived chats", () => {
    const projects = selectNavigationProjects(state, {
      expandedProjectIds: new Set(["project-a"]),
      activityMs: {},
      unreadChatIds: new Set(),
      sessionStates: {},
      query: "HARNESS",
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].chats.map((chat) => chat.title)).toEqual(["Harness integration"]);
  });
});

import { describe, expect, it } from "vitest";

import type { ProjectChatState } from "../../domain/projectChats";
import type { RootSessionProjection } from "../../entities/harness/types";
import { selectNavigationProjects } from "./navigationSelectors";

const session: RootSessionProjection = {
  sessionId: "session-recent", accountId: "account-a", projectId: "project-a", chatId: "agent-recent",
  cursor: { runtimeGeneration: "generation-a", sequence: 2 }, state: "working", freshness: "live",
  parentMessages: [], children: [], queue: [], tools: [], resources: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
};

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
        { id: "chat-recent", projectId: "project-a", title: "Harness integration", pinned: false, archived: false, binding: { kind: "prime-session", accountId: "account-a", sessionId: "session-recent", sessionFile: "recent.jsonl", agentId: "agent-recent" } },
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
      sessions: { "session-recent": session },
      query: "",
    });

    expect(projects.map((project) => project.id)).toEqual(["project-a", "project:personal"]);
    expect(projects[0].chats.map((chat) => chat.id)).toEqual(["chat-old", "chat-recent"]);
    expect(projects[0].chats[0]).toMatchObject({ unread: true, selected: false });
    expect(projects[0].chats[1]).toMatchObject({ selected: true, lifecycle: { status: "working", label: "Working" } });
  });

  it("filters case-insensitively without revealing archived chats", () => {
    const projects = selectNavigationProjects(state, {
      expandedProjectIds: new Set(["project-a"]),
      activityMs: {},
      unreadChatIds: new Set(),
      sessions: {},
      query: "HARNESS",
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].chats.map((chat) => chat.title)).toEqual(["Harness integration"]);
  });
});

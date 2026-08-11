import { describe, expect, it } from "vitest";

import {
  PERSONAL_PROJECT_ID,
  PROJECT_CHAT_SCHEMA_VERSION,
  createInitialProjectChatState,
  resolveProjectChatSelection,
  serializeProjectChatState,
  transitionProjectChatState,
} from "./index";
import type { Project, ProjectChatCommand, ProjectChatState } from "./index";
import {
  MAX_PROJECT_CHAT_SNAPSHOT_NODES,
} from "./strictSnapshot";

function snapshotContainerNodes(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return 1 + Reflect.ownKeys(value).reduce((total, key) => {
    if (typeof key !== "string" || (Array.isArray(value) && key === "length")) {
      return total;
    }
    return (
      total +
      snapshotContainerNodes(Object.getOwnPropertyDescriptor(value, key)?.value)
    );
  }, 0);
}

function apply(
  state: ProjectChatState,
  command: ProjectChatCommand,
): ProjectChatState {
  const result = transitionProjectChatState(state, command);
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error(`Expected applied, got ${result.status}`);
  return result.state;
}

function project(state: ProjectChatState, projectId: string) {
  const found = state.projects.find((candidate) => candidate.id === projectId);
  if (!found) throw new Error(`Missing project ${projectId}`);
  return found;
}

function chat(state: ProjectChatState, projectId: string, chatId: string) {
  const found = project(state, projectId).chats.find(
    (candidate) => candidate.id === chatId,
  );
  if (!found) throw new Error(`Missing chat ${chatId}`);
  return found;
}

function commandFixtures(): Array<[string, Record<string, unknown>]> {
  return [
    ["project.create", {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    }],
    ["chat.create", {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      title: "Inbox",
    }],
    ["chat.bind-prime-session", {
      type: "chat.bind-prime-session",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      binding: {
        kind: "prime-session",
        accountId: null,
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
        agentId: null,
      },
    }],
    ["project.rename", {
      type: "project.rename",
      projectId: PERSONAL_PROJECT_ID,
      name: "Personal",
    }],
    ["project.archive", {
      type: "project.archive",
      projectId: PERSONAL_PROJECT_ID,
    }],
    ["project.restore", {
      type: "project.restore",
      projectId: PERSONAL_PROJECT_ID,
    }],
    ["project.set-pinned", {
      type: "project.set-pinned",
      projectId: PERSONAL_PROJECT_ID,
      pinned: true,
    }],
    ["chat.rename", {
      type: "chat.rename",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      title: "Inbox",
    }],
    ["chat.archive", {
      type: "chat.archive",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
    }],
    ["chat.restore", {
      type: "chat.restore",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
    }],
    ["chat.set-pinned", {
      type: "chat.set-pinned",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      pinned: true,
    }],
    ["chat.duplicate", {
      type: "chat.duplicate",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      newChatId: "chat:copy",
      title: "Inbox copy",
    }],
    ["chat.move", {
      type: "chat.move",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
      targetProjectId: "project:alpha",
    }],
    ["chat.delete", {
      type: "chat.delete",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
    }],
    ["selection.select-project", {
      type: "selection.select-project",
      projectId: PERSONAL_PROJECT_ID,
    }],
    ["selection.select-chat", {
      type: "selection.select-chat",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:inbox",
    }],
  ];
}

function addEnumerableSymbol(value: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(value, Symbol("unexpected"), {
    configurable: true,
    enumerable: true,
    value: true,
  });
  return value;
}

function addNonEnumerableProperty(
  value: Record<string, unknown>,
): Record<string, unknown> {
  Object.defineProperty(value, "unexpected", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return value;
}

describe("project chat domain", () => {
  it("duplicates without copying runtime authority, moves across projects, and deletes deterministically", () => {
    let state = createInitialProjectChatState();
    state = apply(state, { type: "project.create", projectId: "project:target", name: "Target", folderPath: "D:\\work\\target" });
    state = apply(state, { type: "chat.create", projectId: PERSONAL_PROJECT_ID, chatId: "chat:source", title: "Source" });
    state = apply(state, { type: "chat.bind-prime-session", projectId: PERSONAL_PROJECT_ID, chatId: "chat:source", binding: { kind: "prime-session", accountId: "account-1", sessionId: "session-1", sessionFile: "session-1.jsonl", agentId: null } });
    state = apply(state, { type: "chat.duplicate", projectId: PERSONAL_PROJECT_ID, chatId: "chat:source", newChatId: "chat:copy", title: "Source copy" });
    expect(chat(state, PERSONAL_PROJECT_ID, "chat:copy").binding).toBeNull();

    state = apply(state, { type: "chat.move", projectId: PERSONAL_PROJECT_ID, chatId: "chat:copy", targetProjectId: "project:target" });
    expect(project(state, PERSONAL_PROJECT_ID).chats.map((item) => item.id)).toEqual(["chat:source"]);
    expect(chat(state, "project:target", "chat:copy").projectId).toBe("project:target");
    expect(resolveProjectChatSelection(state)).toEqual({ status: "resolved", projectId: "project:target", chatId: "chat:copy" });

    state = apply(state, { type: "chat.delete", projectId: "project:target", chatId: "chat:copy" });
    expect(project(state, "project:target").chats).toEqual([]);
    expect(resolveProjectChatSelection(state)).toEqual({ status: "resolved", projectId: "project:target", chatId: null });
  });
  it("binds a chat to one immutable Prime session identity", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:bound",
      title: "Bound chat",
    });
    const binding = {
      kind: "prime-session" as const,
      accountId: "account-1",
      sessionId: "session-1",
      sessionFile: "session-1.jsonl",
      agentId: "agent-1",
    };
    const command = {
      type: "chat.bind-prime-session",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:bound",
      binding,
    } as unknown as ProjectChatCommand;

    const bound = transitionProjectChatState(state, command);
    expect(bound.status).toBe("applied");
    if (bound.status !== "applied") throw new Error("Expected binding to apply");
    expect(chat(bound.state, PERSONAL_PROJECT_ID, "chat:bound")).toMatchObject({ binding });
    expect(transitionProjectChatState(bound.state, command)).toMatchObject({
      status: "unchanged",
      reason: "same-binding",
    });
    expect(transitionProjectChatState(bound.state, {
      ...command,
      binding: { ...binding, sessionId: "session-2" },
    } as unknown as ProjectChatCommand)).toMatchObject({
      status: "rejected",
      reason: "chat-already-bound",
    });
  });

  it.each([
    ["non-ASCII", "project:\u00e9"],
    ["129-byte", "p".repeat(129)],
    ["emoji", "project:\ud83d\ude00"],
    ["leading-space", " project:alpha"],
    ["trailing-space", "project:alpha "],
  ])("rejects a %s project identity at the command boundary", (_label, projectId) => {
    const state = createInitialProjectChatState();

    expect(transitionProjectChatState(state, {
      type: "project.create",
      projectId,
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    })).toMatchObject({ status: "rejected", reason: "invalid-id" });
  });

  it("accepts the full printable-ASCII identity boundary without path semantics", () => {
    const atByteLimit = `project:${"x".repeat(120)}`;
    expect(atByteLimit.length).toBe(128);
    const state = createInitialProjectChatState();

    expect(transitionProjectChatState(state, {
      type: "project.create",
      projectId: atByteLimit,
      name: "ASCII boundary",
      folderPath: "D:\\work\\ascii-boundary",
    }).status).toBe("applied");
    expect(transitionProjectChatState(state, {
      type: "project.create",
      projectId: "project:alpha / \\ beta",
      name: "Identity punctuation",
      folderPath: "D:\\work\\identity-punctuation",
    }).status).toBe("applied");
  });

  it("validates every command project and chat identity before lookup", () => {
    const state = createInitialProjectChatState();
    for (const [type, fixture] of commandFixtures()) {
      expect(
        transitionProjectChatState(state, {
          ...fixture,
          projectId: "project:\u00e9",
        }),
        `${type} projectId`,
      ).toMatchObject({ status: "rejected", reason: "invalid-id" });

      if ("chatId" in fixture) {
        expect(
          transitionProjectChatState(state, {
            ...fixture,
            chatId: "chat:\ud83d\ude00",
          }),
          `${type} chatId`,
        ).toMatchObject({ status: "rejected", reason: "invalid-id" });
      }
    }
  });

  it("counts labels by Unicode scalar value and rejects unsafe text categories", () => {
    const state = createInitialProjectChatState();
    const atScalarLimit = transitionProjectChatState(state, {
      type: "project.create",
      projectId: "project:emoji-label",
      name: "\ud83d\ude00".repeat(200),
      folderPath: "D:\\work\\emoji-label",
    });
    expect(atScalarLimit.status).toBe("applied");

    for (const [label, name] of [
      ["201 ASCII scalars", "x".repeat(201)],
      ["201 astral scalars", "\ud83d\ude00".repeat(201)],
      ["C0 control", "safe\u0001text"],
      ["DEL control", "safe\u007ftext"],
      ["C1 control", "safe\u0085text"],
      ["format control", "safe\u200dtext"],
      ["line separator", "safe\u2028text"],
      ["paragraph separator", "safe\u2029text"],
      ["lone high surrogate", "safe\ud800text"],
      ["lone low surrogate", "safe\udc00text"],
      ["leading whitespace", " Alpha"],
      ["trailing whitespace", "Alpha "],
    ] as const) {
      expect(
        transitionProjectChatState(state, {
          type: "project.create",
          projectId: `project:${label.split(" ").join("-")}`,
          name,
          folderPath: "D:\\work\\label",
        }),
        label,
      ).toMatchObject({ status: "rejected", reason: "invalid-name" });
    }
  });

  it("accepts only a bounded Prime session basename in an immutable binding", () => {
    const state = apply(createInitialProjectChatState(), {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:binding-path",
      title: "Binding path",
    });
    const bind = (sessionFile: string) => transitionProjectChatState(state, {
      type: "chat.bind-prime-session",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:binding-path",
      binding: {
        kind: "prime-session",
        accountId: "account-1",
        sessionId: "session-1",
        sessionFile,
        agentId: "agent-1",
      },
    });

    expect(bind(`${"a".repeat(249)}.jsonl`)).toMatchObject({ status: "applied" });
    for (const [label, sessionFile] of [
      ["one-megabyte control-bearing value", `${"a".repeat(1024 * 1024 - 1)}\u0001`],
      ["256-byte basename", `${"a".repeat(250)}.jsonl`],
      ["absolute Windows path", "C:\\Users\\a\\.prime\\agent\\sessions\\s.jsonl"],
      ["forward separator", "sessions/s.jsonl"],
      ["back separator", "sessions\\s.jsonl"],
      ["dot", "."],
      ["dot-dot", ".."],
      ["empty", ""],
    ] as const) {
      expect(bind(sessionFile), label).toMatchObject({
        status: "rejected",
        reason: "invalid-command",
      });
    }
  });

  it("applies the canonical identity contract to every Prime binding identity", () => {
    const state = apply(createInitialProjectChatState(), {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:binding-ids",
      title: "Binding ids",
    });
    const binding = {
      kind: "prime-session" as const,
      accountId: "account-1",
      sessionId: "session-1",
      sessionFile: "session-1.jsonl",
      agentId: "agent-1",
    };

    for (const [field, value] of [
      ["accountId", "account:\u00e9"],
      ["sessionId", "s".repeat(129)],
      ["agentId", "agent:\ud83d\ude00"],
    ] as const) {
      expect(transitionProjectChatState(state, {
        type: "chat.bind-prime-session",
        projectId: PERSONAL_PROJECT_ID,
        chatId: "chat:binding-ids",
        binding: { ...binding, [field]: value },
      }), field).toMatchObject({ status: "rejected", reason: "invalid-command" });
    }
  });

  it("seeds the immutable Personal project with an empty Studio-managed root", () => {
    expect(createInitialProjectChatState()).toEqual({
      schemaVersion: PROJECT_CHAT_SCHEMA_VERSION,
      selectedProjectId: PERSONAL_PROJECT_ID,
      projects: [
        {
          id: PERSONAL_PROJECT_ID,
          kind: "personal",
          name: "Personal",
          root: { kind: "studio-managed-empty" },
          pinned: false,
          archived: false,
          selectedChatId: null,
          chats: [],
        },
      ],
    });
  });

  it("creates folder projects and chats with caller-supplied stable identities", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      title: "Plan release",
    });

    expect(state.projects[1]).toEqual({
      id: "project:alpha",
      kind: "folder",
      name: "Alpha",
      root: { kind: "folder", path: "D:\\work\\alpha" },
      pinned: false,
      archived: false,
      selectedChatId: "chat:alpha-1",
      chats: [
        {
          id: "chat:alpha-1",
          projectId: "project:alpha",
          title: "Plan release",
          pinned: false,
          archived: false,
          binding: null,
        },
      ],
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
    });
  });

  it("remembers an independent selected chat for every project", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:personal",
      title: "Inbox",
    });
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      title: "First",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-2",
      title: "Second",
    });
    state = apply(state, {
      type: "selection.select-chat",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
    });
    state = apply(state, {
      type: "selection.select-project",
      projectId: PERSONAL_PROJECT_ID,
    });

    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:personal",
    });

    state = apply(state, {
      type: "selection.select-project",
      projectId: "project:alpha",
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
    });
  });

  it("renames and pins projects and chats without changing their identities or roots", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      title: "Draft",
    });
    state = apply(state, {
      type: "project.rename",
      projectId: "project:alpha",
      name: "Alpha renamed",
    });
    state = apply(state, {
      type: "chat.rename",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      title: "Final",
    });
    state = apply(state, {
      type: "project.set-pinned",
      projectId: "project:alpha",
      pinned: true,
    });
    state = apply(state, {
      type: "chat.set-pinned",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      pinned: true,
    });

    expect(project(state, "project:alpha")).toMatchObject({
      id: "project:alpha",
      name: "Alpha renamed",
      root: { kind: "folder", path: "D:\\work\\alpha" },
      pinned: true,
    });
    expect(chat(state, "project:alpha", "chat:alpha-1")).toEqual({
      id: "chat:alpha-1",
      projectId: "project:alpha",
      title: "Final",
      pinned: true,
      archived: false,
      binding: null,
    });

    state = apply(state, {
      type: "project.set-pinned",
      projectId: "project:alpha",
      pinned: false,
    });
    state = apply(state, {
      type: "chat.set-pinned",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      pinned: false,
    });
    expect(project(state, "project:alpha").pinned).toBe(false);
    expect(chat(state, "project:alpha", "chat:alpha-1").pinned).toBe(false);
  });

  it("archives chats with deterministic same-project selection fallback and restores them", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    for (const [chatId, title] of [
      ["chat:alpha-1", "First"],
      ["chat:alpha-2", "Second"],
      ["chat:alpha-3", "Third"],
    ] as const) {
      state = apply(state, {
        type: "chat.create",
        projectId: "project:alpha",
        chatId,
        title,
      });
    }
    state = apply(state, {
      type: "selection.select-chat",
      projectId: "project:alpha",
      chatId: "chat:alpha-2",
    });

    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-2",
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: "chat:alpha-3",
    });

    state = apply(state, {
      type: "chat.restore",
      projectId: "project:alpha",
      chatId: "chat:alpha-2",
    });
    expect(chat(state, "project:alpha", "chat:alpha-2").archived).toBe(false);
    expect(resolveProjectChatSelection(state)).toMatchObject({
      status: "resolved",
      chatId: "chat:alpha-3",
    });

    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-3",
    });
    expect(resolveProjectChatSelection(state)).toMatchObject({
      status: "resolved",
      chatId: "chat:alpha-2",
    });
    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-2",
    });
    expect(resolveProjectChatSelection(state)).toMatchObject({
      status: "resolved",
      chatId: "chat:alpha-1",
    });
    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: null,
    });
  });

  it("persists the first restored chat when no active selection remains", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-a",
      title: "A",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-b",
      title: "B",
    });
    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-b",
    });
    state = apply(state, {
      type: "chat.archive",
      projectId: "project:alpha",
      chatId: "chat:alpha-a",
    });

    state = apply(state, {
      type: "chat.restore",
      projectId: "project:alpha",
      chatId: "chat:alpha-b",
    });
    expect(project(state, "project:alpha").selectedChatId).toBe("chat:alpha-b");

    state = apply(state, {
      type: "chat.restore",
      projectId: "project:alpha",
      chatId: "chat:alpha-a",
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: "chat:alpha-b",
    });
  });

  it("archives projects without archiving their chats and restores remembered selection", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:personal",
      title: "Inbox",
    });
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    state = apply(state, {
      type: "chat.create",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
      title: "Alpha chat",
    });

    state = apply(state, {
      type: "project.archive",
      projectId: "project:alpha",
    });
    expect(project(state, "project:alpha").archived).toBe(true);
    expect(chat(state, "project:alpha", "chat:alpha-1").archived).toBe(false);
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:personal",
    });

    state = apply(state, {
      type: "project.restore",
      projectId: "project:alpha",
    });
    expect(resolveProjectChatSelection(state)).toMatchObject({
      status: "resolved",
      projectId: PERSONAL_PROJECT_ID,
    });

    state = apply(state, {
      type: "selection.select-project",
      projectId: "project:alpha",
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:alpha",
      chatId: "chat:alpha-1",
    });
  });

  it("returns explicit unchanged and rejected results without replacing valid state", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });

    const unchanged = transitionProjectChatState(state, {
      type: "project.rename",
      projectId: "project:alpha",
      name: "Alpha",
    });
    expect(unchanged).toMatchObject({ status: "unchanged", reason: "same-name" });
    expect(unchanged.state).toBe(state);

    const missing = transitionProjectChatState(state, {
      type: "project.rename",
      projectId: "project:missing",
      name: "Missing",
    });
    expect(missing).toMatchObject({ status: "rejected", reason: "project-not-found" });
    expect(missing.state).toBe(state);

    const protectedPersonal = transitionProjectChatState(state, {
      type: "project.archive",
      projectId: PERSONAL_PROJECT_ID,
    });
    expect(protectedPersonal).toMatchObject({
      status: "rejected",
      reason: "personal-project-immutable",
    });
    expect(protectedPersonal.state).toBe(state);
  });

  it("rejects cross-project chat commands without leaking changes or selection", () => {
    let state = createInitialProjectChatState();
    for (const suffix of ["alpha", "beta"] as const) {
      state = apply(state, {
        type: "project.create",
        projectId: `project:${suffix}`,
        name: suffix,
        folderPath: `D:\\work\\${suffix}`,
      });
      state = apply(state, {
        type: "chat.create",
        projectId: `project:${suffix}`,
        chatId: `chat:${suffix}`,
        title: `${suffix} chat`,
      });
    }
    const before = state;

    for (const command of [
      {
        type: "chat.rename",
        projectId: "project:beta",
        chatId: "chat:alpha",
        title: "leaked rename",
      },
      {
        type: "chat.archive",
        projectId: "project:beta",
        chatId: "chat:alpha",
      },
      {
        type: "chat.set-pinned",
        projectId: "project:beta",
        chatId: "chat:alpha",
        pinned: true,
      },
      {
        type: "selection.select-chat",
        projectId: "project:beta",
        chatId: "chat:alpha",
      },
    ] as const) {
      const result = transitionProjectChatState(state, command);
      expect(result).toMatchObject({
        status: "rejected",
        reason: "chat-project-mismatch",
      });
      expect(result.state).toBe(before);
    }

    expect(chat(state, "project:alpha", "chat:alpha")).toMatchObject({
      title: "alpha chat",
      archived: false,
      pinned: false,
    });
    expect(resolveProjectChatSelection(state)).toEqual({
      status: "resolved",
      projectId: "project:beta",
      chatId: "chat:beta",
    });

    const duplicate = transitionProjectChatState(state, {
      type: "chat.create",
      projectId: "project:beta",
      chatId: "chat:alpha",
      title: "Duplicate identity",
    });
    expect(duplicate).toMatchObject({
      status: "rejected",
      reason: "duplicate-chat-id",
    });
    expect(duplicate.state).toBe(state);
  });

  it("rejects unknown runtime commands rather than returning an ambiguous state", () => {
    const state = createInitialProjectChatState();
    const result = transitionProjectChatState(
      state,
      { type: "project.future-delete" } as unknown as ProjectChatCommand,
    );

    expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
    expect(result.state).toBe(state);
  });

  it.each([
    ["null", null],
    ["a primitive", "project.create"],
    ["missing fields", { type: "project.create" }],
    [
      "a wrong field type",
      {
        type: "project.set-pinned",
        projectId: PERSONAL_PROJECT_ID,
        pinned: "yes",
      },
    ],
    [
      "unknown extra fields",
      {
        type: "selection.select-project",
        projectId: PERSONAL_PROJECT_ID,
        unexpected: true,
      },
    ],
  ])("rejects %s at the command boundary without mutating state", (_label, command) => {
    const state = createInitialProjectChatState();
    const result = transitionProjectChatState(state, command);

    expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
    expect(result.state).toBe(state);
    expect(state).toEqual(createInitialProjectChatState());
  });

  it.each(commandFixtures())(
    "rejects %s when it has an own symbol without mutating state",
    (_label, command) => {
      const state = createInitialProjectChatState();
      const result = transitionProjectChatState(state, addEnumerableSymbol(command));

      expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
      expect(result.state).toBe(state);
    },
  );

  it.each(commandFixtures())(
    "rejects %s when it has a non-enumerable extra without mutating state",
    (_label, command) => {
      const state = createInitialProjectChatState();
      const result = transitionProjectChatState(state, addNonEnumerableProperty(command));

      expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
      expect(result.state).toBe(state);
    },
  );

  it("rejects an accessor command without reading it twice or applying its second value", () => {
    const state = createInitialProjectChatState();
    let reads = 0;
    const command = {
      type: "project.set-pinned",
      projectId: PERSONAL_PROJECT_ID,
      pinned: true,
    } as Record<string, unknown>;
    Object.defineProperty(command, "pinned", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? true : false;
      },
    });

    const result = transitionProjectChatState(state, command);

    expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
    expect(result.state).toBe(state);
    expect(reads).toBe(0);
  });

  it("rejects a proxy command whose descriptor view is an accessor without throwing", () => {
    const state = createInitialProjectChatState();
    const command = new Proxy(
      {
        type: "project.set-pinned",
        projectId: PERSONAL_PROJECT_ID,
        pinned: true,
      },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "pinned") {
            return {
              configurable: true,
              enumerable: true,
              get: () => true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    let result: ReturnType<typeof transitionProjectChatState> | undefined;
    expect(() => {
      result = transitionProjectChatState(state, command);
    }).not.toThrow();

    expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
    expect(result?.state).toBe(state);
  });

  it("rejects a command with a non-standard prototype without mutating state", () => {
    const state = createInitialProjectChatState();
    const command = Object.assign(Object.create({ pinned: true }), {
      type: "project.set-pinned",
      projectId: PERSONAL_PROJECT_ID,
    });

    const result = transitionProjectChatState(state, command);

    expect(result).toMatchObject({ status: "rejected", reason: "invalid-command" });
    expect(result.state).toBe(state);
  });

  it("accepts a candidate at the native JSON cap and rejects cap plus one", () => {
    const initial = createInitialProjectChatState();
    const personal = initial.projects[0];
    const folder = {
      id: "project:json-boundary",
      kind: "folder" as const,
      name: "JSON boundary",
      root: { kind: "folder" as const, path: "" },
      pinned: false,
      archived: false,
      selectedChatId: null,
      chats: [],
    };
    const state: ProjectChatState = {
      ...initial,
      projects: [...initial.projects, folder],
    };
    const createdChat = {
      id: "chat:bounded",
      projectId: PERSONAL_PROJECT_ID,
      title: "Bounded",
      pinned: false,
      archived: false,
      binding: null,
    };
    const candidate = {
      ...state,
      projects: [
        {
          ...personal,
          selectedChatId: createdChat.id,
          chats: [createdChat],
        },
        folder,
      ],
    };
    const baseCommand = {
      type: "chat.create",
      projectId: PERSONAL_PROJECT_ID,
      chatId: "chat:bounded",
      title: "Bounded",
    };
    folder.root.path = "x".repeat(
      8 * 1024 * 1024 - JSON.stringify(candidate).length,
    );
    expect(JSON.stringify(candidate).length).toBe(8 * 1024 * 1024);

    const atCap = transitionProjectChatState(state, baseCommand);
    expect(atCap.status).toBe("applied");
    const serialized = serializeProjectChatState(atCap.state);
    expect(serialized.status).toBe("serialized");
    if (serialized.status !== "serialized") throw new Error("Expected serialization");
    expect(serialized.json.length).toBe(8 * 1024 * 1024);

    folder.root.path += "x";
    expect(JSON.stringify(candidate).length).toBe(8 * 1024 * 1024 + 1);
    const overCap = transitionProjectChatState(state, baseCommand);
    expect(overCap).toMatchObject({
      status: "rejected",
      reason: "state-limit-exceeded",
    });
    expect(overCap.state).toBe(state);
  });

  it("rejects the small create that would exceed the candidate node cap", () => {
    const projects: Project[] = [...createInitialProjectChatState().projects];
    const folderCount = (MAX_PROJECT_CHAT_SNAPSHOT_NODES - 7) / 3;
    expect(Number.isInteger(folderCount)).toBe(true);
    for (let index = 0; index < folderCount; index += 1) {
      projects.push({
        id: `project:${index}`,
        kind: "folder",
        name: `P${index}`,
        root: { kind: "folder", path: `D:\\work\\${index}` },
        pinned: false,
        archived: false,
        selectedChatId: null,
        chats: [],
      });
    }
    const lastProject = projects[projects.length - 1];
    if (lastProject.kind !== "folder") throw new Error("Expected folder project");
    const firstChat = {
      id: "chat:first-boundary",
      projectId: lastProject.id,
      title: "First boundary",
      pinned: false,
      archived: false,
      binding: null,
    };
    projects[projects.length - 1] = {
      ...lastProject,
      selectedChatId: firstChat.id,
      chats: [firstChat],
    };
    const state: ProjectChatState = {
      schemaVersion: PROJECT_CHAT_SCHEMA_VERSION,
      selectedProjectId: PERSONAL_PROJECT_ID,
      projects,
    };
    expect(snapshotContainerNodes(state)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_NODES - 1,
    );

    const atCap = transitionProjectChatState(state, {
      type: "chat.create",
      projectId: lastProject.id,
      chatId: "chat:at-node-cap",
      title: "At node cap",
    });
    expect(atCap.status).toBe("applied");
    expect(snapshotContainerNodes(atCap.state)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_NODES,
    );
    expect(serializeProjectChatState(atCap.state).status).toBe("serialized");

    const overCap = transitionProjectChatState(atCap.state, {
      type: "chat.create",
      projectId: lastProject.id,
      chatId: "chat:over-node-cap",
      title: "Over node cap",
    });
    expect(overCap).toMatchObject({
      status: "rejected",
      reason: "state-limit-exceeded",
    });
    expect(overCap.state).toBe(atCap.state);
  });
});

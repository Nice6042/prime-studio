import { describe, expect, it } from "vitest";

import {
  PERSONAL_PROJECT_ID,
  PROJECT_CHAT_SCHEMA_VERSION,
  createInitialProjectChatState,
  deserializeProjectChatState,
  resolveProjectChatSelection,
  serializeProjectChatState,
  transitionProjectChatState,
} from "./index";
import type {
  ProjectChatCommand,
  ProjectChatMigration,
  ProjectChatState,
} from "./index";
import {
  MAX_PROJECT_CHAT_SNAPSHOT_DEPTH,
  MAX_PROJECT_CHAT_SNAPSHOT_NODES,
  MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES,
  MAX_PROJECT_CHAT_SNAPSHOT_WORK,
} from "./strictSnapshot";

const initialJson =
  '{"schemaVersion":2,"selectedProjectId":"project:personal","projects":[{"id":"project:personal","kind":"personal","name":"Personal","root":{"kind":"studio-managed-empty"},"pinned":false,"archived":false,"selectedChatId":null,"chats":[]}]}';
const MAX_NATIVE_PROJECT_CHAT_JSON_BYTES = 8 * 1024 * 1024;

function asciiSnapshotScalarBytes(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 0;
  return Reflect.ownKeys(value).reduce((total, key) => {
    if (typeof key !== "string" || (Array.isArray(value) && key === "length")) {
      return total;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      total +
      key.length +
      asciiSnapshotScalarBytes(descriptor?.value)
    );
  }, 0);
}

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

function snapshotWork(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return Reflect.ownKeys(value).reduce((total, key) => {
    if (typeof key !== "string") return total;
    const childWork =
      Array.isArray(value) && key === "length"
        ? 0
        : snapshotWork(Object.getOwnPropertyDescriptor(value, key)?.value);
    return total + 1 + childWork;
  }, 0);
}

function nested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.next = child;
    cursor = child;
  }
  return root;
}

function validSnapshot(): Record<string, unknown> {
  return {
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
  };
}

function legacyV1Snapshot(): Record<string, unknown> {
  const snapshot = validSnapshot();
  snapshot.schemaVersion = 1;
  const projects = snapshot.projects as Record<string, unknown>[];
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const chats = projects[projectIndex].chats as Record<string, unknown>[];
    for (let chatIndex = 0; chatIndex < chats.length; chatIndex += 1) {
      delete chats[chatIndex].binding;
    }
  }
  return snapshot;
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

function personalProject(snapshot: Record<string, unknown>): Record<string, unknown> {
  const projects = snapshot.projects as Record<string, unknown>[];
  return projects[0];
}

function personalRoot(snapshot: Record<string, unknown>): Record<string, unknown> {
  return personalProject(snapshot).root as Record<string, unknown>;
}

function personalChat(snapshot: Record<string, unknown>): Record<string, unknown> {
  const project = personalProject(snapshot);
  const chats = project.chats as Record<string, unknown>[];
  const chat = {
    id: "chat:inbox",
    projectId: PERSONAL_PROJECT_ID,
    title: "Inbox",
    pinned: false,
    archived: false,
    binding: null,
  };
  chats.push(chat);
  return chat;
}

function folderProject(
  snapshot: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const project = {
    id: "project:alpha",
    kind: "folder",
    name: "Alpha",
    root: { kind: "folder", path: "D:\\work\\alpha" },
    pinned: false,
    archived: false,
    selectedChatId: null,
    chats: [],
    ...overrides,
  };
  (snapshot.projects as Record<string, unknown>[]).push(project);
  return project;
}

function expectInvalidStateAtBothBoundaries(snapshot: Record<string, unknown>): void {
  expect(serializeProjectChatState(snapshot)).toEqual({
    status: "rejected",
    reason: "invalid-state",
  });
  expect(deserializeProjectChatState(JSON.stringify(snapshot))).toEqual({
    status: "rejected",
    reason: "invalid-state",
  });
}

function apply(state: ProjectChatState, command: ProjectChatCommand): ProjectChatState {
  const result = transitionProjectChatState(state, command);
  if (result.status !== "applied") throw new Error(`Expected applied, got ${result.status}`);
  return result.state;
}

describe("project chat serialization", () => {
  it("migrates schema v1 chats to schema v2 with an explicit null binding", () => {
    const legacy = validSnapshot();
    const chat = personalChat(legacy);
    legacy.schemaVersion = 1;
    delete chat.binding;
    const loaded = deserializeProjectChatState(JSON.stringify(legacy));

    expect(loaded).toMatchObject({
      status: "migrated",
      fromVersion: 1,
      state: {
        schemaVersion: 2,
        projects: [{ chats: [{ ...chat, binding: null }] }],
      },
    });
  });

  it("emits a canonical schema-v2 representation with stable key order", () => {
    const first = serializeProjectChatState(createInitialProjectChatState());
    const second = serializeProjectChatState(createInitialProjectChatState());

    expect(first).toEqual({ status: "serialized", json: initialJson });
    expect(second).toEqual(first);
  });

  it.each([
    ["non-ASCII", "project:\u00e9"],
    ["129-byte", "p".repeat(129)],
    ["emoji", "project:\ud83d\ude00"],
    ["leading-space", " project:alpha"],
    ["trailing-space", "project:alpha "],
  ])("rejects a %s identity in existing durable state", (_label, id) => {
    const snapshot = validSnapshot();
    folderProject(snapshot, { id });

    expectInvalidStateAtBothBoundaries(snapshot);
  });

  it("rejects unsafe or overlong existing project and chat labels", () => {
    for (const label of [
      "x".repeat(201),
      "\ud83d\ude00".repeat(201),
      "safe\u0001text",
      "safe\u007ftext",
      "safe\u0085text",
      "safe\u200dtext",
      "safe\u2028text",
      "safe\u2029text",
      "safe\ud800text",
      "safe\udc00text",
      " leading",
      "trailing ",
    ]) {
      const projectSnapshot = validSnapshot();
      folderProject(projectSnapshot, { name: label });
      expectInvalidStateAtBothBoundaries(projectSnapshot);

      const chatSnapshot = validSnapshot();
      personalChat(chatSnapshot).title = label;
      expectInvalidStateAtBothBoundaries(chatSnapshot);
    }
  });

  it("rejects invalid existing chat and Prime binding identities", () => {
    for (const [field, value] of [
      ["chatId", "chat:\u00e9"],
      ["accountId", "a".repeat(129)],
      ["sessionId", "session:\ud83d\ude00"],
      ["agentId", " agent-1"],
    ] as const) {
      const snapshot = validSnapshot();
      const chat = personalChat(snapshot);
      if (field === "chatId") {
        chat.id = value;
      } else {
        chat.binding = {
          kind: "prime-session",
          accountId: "account-1",
          sessionId: "session-1",
          sessionFile: "session-1.jsonl",
          agentId: "agent-1",
          [field]: value,
        };
      }
      expectInvalidStateAtBothBoundaries(snapshot);
    }
  });

  it("rejects invalid existing Prime session basenames", () => {
    for (const sessionFile of [
      `${"a".repeat(1024 * 1024 - 1)}\u0001`,
      `${"a".repeat(250)}.jsonl`,
      "C:\\Users\\a\\.prime\\agent\\sessions\\s.jsonl",
      "sessions/s.jsonl",
      "sessions\\s.jsonl",
      ".",
      "..",
      "",
    ]) {
      const snapshot = validSnapshot();
      personalChat(snapshot).binding = {
        kind: "prime-session",
        accountId: "account-1",
        sessionId: "session-1",
        sessionFile,
        agentId: "agent-1",
      };
      expectInvalidStateAtBothBoundaries(snapshot);
    }
  });

  it("enforces the native eight-MiB UTF-8 ceiling on canonical output", () => {
    const atLimit = validSnapshot();
    const atLimitProject = folderProject(atLimit);
    const atLimitRoot = atLimitProject.root as Record<string, unknown>;
    atLimitRoot.path = "";
    const baseLength = JSON.stringify(atLimit).length;
    atLimitRoot.path = "x".repeat(MAX_NATIVE_PROJECT_CHAT_JSON_BYTES - baseLength);
    const atLimitJson = JSON.stringify(atLimit);
    expect(atLimitJson.length).toBe(MAX_NATIVE_PROJECT_CHAT_JSON_BYTES);
    expect(serializeProjectChatState(atLimit)).toEqual({
      status: "serialized",
      json: atLimitJson,
    });
    expect(deserializeProjectChatState(atLimitJson).status).toBe("loaded");

    atLimitRoot.path += "x";
    const overLimitJson = JSON.stringify(atLimit);
    expect(overLimitJson.length).toBe(MAX_NATIVE_PROJECT_CHAT_JSON_BYTES + 1);
    expect(serializeProjectChatState(atLimit)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
    expect(deserializeProjectChatState(overLimitJson)).toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
  });

  it("measures the native ceiling in UTF-8 bytes rather than UTF-16 code units", () => {
    const atLimit = validSnapshot();
    const project = folderProject(atLimit);
    const root = project.root as Record<string, unknown>;
    root.path = "";
    const baseJson = JSON.stringify(atLimit);
    const remainingBytes = MAX_NATIVE_PROJECT_CHAT_JSON_BYTES - baseJson.length;
    root.path = `${"\u00e9".repeat(Math.floor(remainingBytes / 2))}${
      remainingBytes % 2 === 0 ? "" : "x"
    }`;
    const atLimitJson = JSON.stringify(atLimit);
    expect(new TextEncoder().encode(atLimitJson).byteLength).toBe(
      MAX_NATIVE_PROJECT_CHAT_JSON_BYTES,
    );
    expect(atLimitJson.length).toBeLessThan(MAX_NATIVE_PROJECT_CHAT_JSON_BYTES);
    expect(serializeProjectChatState(atLimit).status).toBe("serialized");
    expect(deserializeProjectChatState(atLimitJson).status).toBe("loaded");

    root.path += "\u00e9";
    const overLimitJson = JSON.stringify(atLimit);
    expect(new TextEncoder().encode(overLimitJson).byteLength).toBe(
      MAX_NATIVE_PROJECT_CHAT_JSON_BYTES + 2,
    );
    expect(serializeProjectChatState(atLimit)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
    expect(deserializeProjectChatState(overLimitJson)).toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
  });

  it("rejects an eight-MiB scalar snapshot whose JSON overhead is 121 bytes", () => {
    const snapshot = validSnapshot();
    const project = personalProject(snapshot);
    const chat = personalChat(snapshot);
    project.selectedChatId = chat.id;
    chat.title = "";
    chat.title = "x".repeat(
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES - asciiSnapshotScalarBytes(snapshot),
    );

    expect(asciiSnapshotScalarBytes(snapshot)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES,
    );
    expect(JSON.stringify(snapshot).length).toBe(
      MAX_NATIVE_PROJECT_CHAT_JSON_BYTES + 121,
    );
    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it("round-trips folder projects and chats without losing ownership or selection", () => {
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
      chatId: "chat:alpha",
      title: "Release",
    });
    state = apply(state, {
      type: "chat.set-pinned",
      projectId: "project:alpha",
      chatId: "chat:alpha",
      pinned: true,
    });

    const encoded = serializeProjectChatState(state);
    expect(encoded.status).toBe("serialized");
    if (encoded.status !== "serialized") throw new Error("Expected serialization");

    expect(deserializeProjectChatState(encoded.json)).toEqual({
      status: "loaded",
      state,
    });
  });

  it("round-trips a restored fallback without later selection drift", () => {
    let state = createInitialProjectChatState();
    state = apply(state, {
      type: "project.create",
      projectId: "project:alpha",
      name: "Alpha",
      folderPath: "D:\\work\\alpha",
    });
    for (const chatId of ["chat:alpha-a", "chat:alpha-b"] as const) {
      state = apply(state, {
        type: "chat.create",
        projectId: "project:alpha",
        chatId,
        title: chatId,
      });
    }
    for (const chatId of ["chat:alpha-b", "chat:alpha-a"] as const) {
      state = apply(state, {
        type: "chat.archive",
        projectId: "project:alpha",
        chatId,
      });
    }
    state = apply(state, {
      type: "chat.restore",
      projectId: "project:alpha",
      chatId: "chat:alpha-b",
    });

    const encoded = serializeProjectChatState(state);
    if (encoded.status !== "serialized") throw new Error("Expected serialization");
    const loaded = deserializeProjectChatState(encoded.json);
    if (loaded.status !== "loaded") throw new Error("Expected loaded state");
    state = apply(loaded.state, {
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

  it.each([
    ["invalid JSON", "{", "invalid-json"],
    [
      "a missing version",
      JSON.stringify({ selectedProjectId: PERSONAL_PROJECT_ID, projects: [] }),
      "invalid-snapshot",
    ],
    [
      "an unknown future version",
      JSON.stringify({ ...validSnapshot(), schemaVersion: 99 }),
      "unsupported-version",
    ],
    [
      "unknown fields",
      JSON.stringify({ ...validSnapshot(), unexpected: true }),
      "invalid-state",
    ],
    [
      "a mutated Personal project",
      JSON.stringify({
        ...validSnapshot(),
        projects: [
          {
            ...(validSnapshot().projects as Record<string, unknown>[])[0],
            archived: true,
          },
        ],
      }),
      "invalid-state",
    ],
    [
      "a chat whose parent identity disagrees with its container",
      JSON.stringify({
        ...validSnapshot(),
        projects: [
          (validSnapshot().projects as Record<string, unknown>[])[0],
          {
            id: "project:alpha",
            kind: "folder",
            name: "Alpha",
            root: { kind: "folder", path: "D:\\work\\alpha" },
            pinned: false,
            archived: false,
            selectedChatId: null,
            chats: [
              {
                id: "chat:alpha",
                projectId: "project:other",
                title: "Wrong owner",
                pinned: false,
                archived: false,
              },
            ],
          },
        ],
      }),
      "invalid-state",
    ],
  ])("rejects %s without manufacturing replacement state", (_label, json, reason) => {
    const result = deserializeProjectChatState(json);

    expect(result).toMatchObject({ status: "rejected", reason });
    expect(result).not.toHaveProperty("state");
  });

  it("rejects duplicate chat identities across project boundaries", () => {
    const personal = (validSnapshot().projects as Record<string, unknown>[])[0];
    const project = (id: string) => ({
      id,
      kind: "folder",
      name: id,
      root: { kind: "folder", path: `D:\\work\\${id}` },
      pinned: false,
      archived: false,
      selectedChatId: "chat:shared",
      chats: [
        {
          id: "chat:shared",
          projectId: id,
          title: "Shared id",
          pinned: false,
          archived: false,
        },
      ],
    });
    const json = JSON.stringify({
      schemaVersion: 1,
      selectedProjectId: PERSONAL_PROJECT_ID,
      projects: [personal, project("project:alpha"), project("project:beta")],
    });

    expect(deserializeProjectChatState(json)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it("rejects corrupt in-memory state instead of serializing it", () => {
    const result = serializeProjectChatState({
      ...createInitialProjectChatState(),
      schemaVersion: PROJECT_CHAT_SCHEMA_VERSION,
      unexpected: true,
    });

    expect(result).toEqual({ status: "rejected", reason: "invalid-state" });
  });

  it.each([
    ["the state root", (snapshot: Record<string, unknown>) => snapshot],
    ["a project", (snapshot: Record<string, unknown>) => personalProject(snapshot)],
    ["a project root", (snapshot: Record<string, unknown>) => personalRoot(snapshot)],
    ["a chat", (snapshot: Record<string, unknown>) => personalChat(snapshot)],
  ])("rejects an own symbol on %s instead of serializing it", (_label, select) => {
    const snapshot = validSnapshot();
    const result = serializeProjectChatState(addEnumerableSymbol(select(snapshot)));

    expect(result).toEqual({ status: "rejected", reason: "invalid-state" });
  });

  it.each([
    ["the state root", (snapshot: Record<string, unknown>) => snapshot],
    ["a project", (snapshot: Record<string, unknown>) => personalProject(snapshot)],
    ["a project root", (snapshot: Record<string, unknown>) => personalRoot(snapshot)],
    ["a chat", (snapshot: Record<string, unknown>) => personalChat(snapshot)],
  ])(
    "rejects a non-enumerable extra on %s instead of serializing it",
    (_label, select) => {
      const snapshot = validSnapshot();
      const result = serializeProjectChatState(addNonEnumerableProperty(select(snapshot)));

      expect(result).toEqual({ status: "rejected", reason: "invalid-state" });
    },
  );

  it("rejects an accessor state without reading it or serializing a later value", () => {
    const snapshot = validSnapshot();
    const project = personalProject(snapshot);
    let reads = 0;
    Object.defineProperty(project, "pinned", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1;
      },
    });

    const result = serializeProjectChatState(snapshot);

    expect(result).toEqual({ status: "rejected", reason: "invalid-state" });
    expect(reads).toBe(0);
  });

  it("rejects a proxy state whose own-key trap throws instead of throwing", () => {
    const snapshot = validSnapshot();
    const projects = snapshot.projects as Record<string, unknown>[];
    projects[0] = new Proxy(projects[0], {
      ownKeys() {
        throw new Error("hostile ownKeys trap");
      },
    });

    let result: ReturnType<typeof serializeProjectChatState> | undefined;
    expect(() => {
      result = serializeProjectChatState(snapshot);
    }).not.toThrow();

    expect(result).toEqual({ status: "rejected", reason: "invalid-state" });
  });

  it("rejects a state with a non-standard prototype instead of serializing inherited data", () => {
    const snapshot = validSnapshot();
    Object.setPrototypeOf(snapshot, { selectedProjectId: PERSONAL_PROJECT_ID });

    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it("rejects a canonical state larger than the strict JSON load limit", () => {
    const snapshot = validSnapshot();
    const projects = snapshot.projects as Record<string, unknown>[];
    projects.push({
      id: "project:large",
      kind: "folder",
      name: "x".repeat(16 * 1024 * 1024),
      root: { kind: "folder", path: "D:\\work\\large" },
      pinned: false,
      archived: false,
      selectedChatId: null,
      chats: [],
    });

    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it("accepts the state container-node cap and rejects cap plus one", () => {
    const snapshot = validSnapshot();
    const projects = snapshot.projects as Record<string, unknown>[];
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
    const chats = lastProject.chats as Record<string, unknown>[];
    for (let chatIndex = 0; chatIndex < 2; chatIndex += 1) {
      chats.push({
        id: `chat:boundary-${chatIndex}`,
        projectId: lastProject.id,
        title: `Boundary ${chatIndex}`,
        pinned: false,
        archived: false,
        binding: null,
      });
    }
    expect(snapshotContainerNodes(snapshot)).toBe(MAX_PROJECT_CHAT_SNAPSHOT_NODES);
    expect(serializeProjectChatState(snapshot).status).toBe("serialized");

    chats.push({
      id: "chat:over-node-cap",
      projectId: lastProject.id,
      title: "Over node cap",
      pinned: false,
      archived: false,
      binding: null,
    });
    expect(snapshotContainerNodes(snapshot)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_NODES + 1,
    );
    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it("rejects the state scalar-byte cap when JSON overhead crosses the native cap", () => {
    const snapshot = validSnapshot();
    const folder = {
      id: "project:scalar-boundary",
      kind: "folder",
      name: "Scalar boundary",
      root: { kind: "folder", path: "" },
      pinned: false,
      archived: false,
      selectedChatId: null,
      chats: [],
    };
    (snapshot.projects as Record<string, unknown>[]).push(folder);
    folder.root.path = "x".repeat(
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES -
        asciiSnapshotScalarBytes(snapshot),
    );

    expect(asciiSnapshotScalarBytes(snapshot)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES,
    );
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(
      MAX_NATIVE_PROJECT_CHAT_JSON_BYTES,
    );
    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });

    folder.root.path += "x";
    expect(asciiSnapshotScalarBytes(snapshot)).toBe(
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES + 1,
    );
    expect(serializeProjectChatState(snapshot)).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });

  it.each([
    [
      "a duplicate root key",
      initialJson.replace(
        '"schemaVersion":2,',
        '"schemaVersion":2,"schemaVersion":2,',
      ),
    ],
    [
      "a duplicate nested key",
      initialJson.replace(
        '"root":{"kind":"studio-managed-empty"}',
        '"root":{"kind":"studio-managed-empty","kind":"studio-managed-empty"}',
      ),
    ],
    [
      "a duplicate escaped key",
      initialJson.replace(
        '"schemaVersion":2,',
        '"schemaVersion":2,"\\u0073chemaVersion":2,',
      ),
    ],
  ])("rejects %s before native JSON parsing", (_label, json) => {
    expect(deserializeProjectChatState(json)).toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
  });

  it("runs an explicit contiguous migration hook and validates its output", () => {
    const legacy = { schemaVersion: 0, personalLabel: "Personal" };
    let observedInput: unknown;
    const migration: ProjectChatMigration = {
      fromVersion: 0,
      toVersion: 1,
      migrate(snapshot) {
        observedInput = snapshot;
        return legacyV1Snapshot();
      },
    };

    expect(deserializeProjectChatState(JSON.stringify(legacy), [migration])).toEqual({
      status: "migrated",
      fromVersion: 0,
      state: createInitialProjectChatState(),
    });
    expect(observedInput).toEqual(legacy);
    expect(Object.getPrototypeOf(observedInput as object)).toBeNull();
  });

  it.each([
    ["an own symbol", (snapshot: Record<string, unknown>) => addEnumerableSymbol(snapshot)],
    [
      "a non-enumerable extra",
      (snapshot: Record<string, unknown>) => addNonEnumerableProperty(snapshot),
    ],
    [
      "an accessor",
      (snapshot: Record<string, unknown>) => {
        Object.defineProperty(snapshot, "schemaVersion", {
          configurable: true,
          enumerable: true,
          get: () => 1,
        });
        return snapshot;
      },
    ],
    [
      "a throwing proxy trap",
      (snapshot: Record<string, unknown>) =>
        new Proxy(snapshot, {
          ownKeys() {
            throw new Error("hostile migration proxy");
          },
        }),
    ],
  ])("rejects %s from a migration without throwing", (_label, makeHostile) => {
    const legacy = JSON.stringify({ schemaVersion: 0, personalLabel: "Personal" });
    const migration: ProjectChatMigration = {
      fromVersion: 0,
      toVersion: 1,
      migrate: () => makeHostile(legacyV1Snapshot()),
    };

    let result: ReturnType<typeof deserializeProjectChatState> | undefined;
    expect(() => {
      result = deserializeProjectChatState(legacy, [migration]);
    }).not.toThrow();

    expect(result).toMatchObject({ status: "rejected", reason: "migration-failed" });
  });

  it("captures migration metadata once before executing the migration", () => {
    const legacy = JSON.stringify({ schemaVersion: 0, personalLabel: "Personal" });
    let toVersionReads = 0;
    const migration: ProjectChatMigration = {
      fromVersion: 0,
      get toVersion() {
        toVersionReads += 1;
        if (toVersionReads > 1) throw new Error("migration metadata changed");
        return 1;
      },
      migrate: () => legacyV1Snapshot(),
    };

    expect(deserializeProjectChatState(legacy, [migration])).toEqual({
      status: "migrated",
      fromVersion: 0,
      state: createInitialProjectChatState(),
    });
    expect(toVersionReads).toBe(1);
  });

  it("accepts the migration-output depth cap and rejects cap plus one", () => {
    const legacy = JSON.stringify({ schemaVersion: 0 });
    const migrate = (depth: number): ProjectChatMigration => ({
      fromVersion: 0,
      toVersion: 1,
      migrate: () => ({ ...legacyV1Snapshot(), unexpected: nested(depth - 1) }),
    });

    expect(
      deserializeProjectChatState(legacy, [
        migrate(MAX_PROJECT_CHAT_SNAPSHOT_DEPTH),
      ]),
    ).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
    expect(
      deserializeProjectChatState(legacy, [
        migrate(MAX_PROJECT_CHAT_SNAPSHOT_DEPTH + 1),
      ]),
    ).toEqual({
      status: "rejected",
      reason: "migration-failed",
      version: 0,
    });
  });

  it("accepts the migration-output work cap and rejects cap plus one", () => {
    const legacy = JSON.stringify({ schemaVersion: 0 });
    const output = { ...legacyV1Snapshot(), unexpected: [] as null[] };
    output.unexpected = Array.from(
      { length: MAX_PROJECT_CHAT_SNAPSHOT_WORK - snapshotWork(output) },
      () => null,
    );
    const migration = (): ProjectChatMigration => ({
      fromVersion: 0,
      toVersion: 1,
      migrate: () => output,
    });

    expect(snapshotWork(output)).toBe(MAX_PROJECT_CHAT_SNAPSHOT_WORK);
    expect(deserializeProjectChatState(legacy, [migration()])).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
    output.unexpected.push(null);
    expect(snapshotWork(output)).toBe(MAX_PROJECT_CHAT_SNAPSHOT_WORK + 1);
    expect(deserializeProjectChatState(legacy, [migration()])).toEqual({
      status: "rejected",
      reason: "migration-failed",
      version: 0,
    });
  });

  it("rejects a migration list whose hostile length exceeds the bounded input", () => {
    const legacy = JSON.stringify({ schemaVersion: 0, personalLabel: "Personal" });
    let lengthReads = 0;
    let indexReads = 0;
    const migrations = new Proxy([] as ProjectChatMigration[], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return 10_000;
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexReads += 1;
          const fromVersion = Number(property);
          return {
            fromVersion,
            toVersion: fromVersion + 1,
            migrate: () => validSnapshot(),
          } satisfies ProjectChatMigration;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    let result: ReturnType<typeof deserializeProjectChatState> | undefined;
    expect(() => {
      result = deserializeProjectChatState(legacy, migrations);
    }).not.toThrow();

    expect(result).toEqual({
      status: "rejected",
      reason: "migration-invalid",
      version: 0,
    });
    expect(lengthReads).toBe(1);
    expect(indexReads).toBe(0);
  });

  it("fails closed when a migration is absent, throws, or emits an invalid state", () => {
    const legacy = JSON.stringify({ schemaVersion: 0, personalLabel: "Personal" });

    expect(deserializeProjectChatState(legacy)).toEqual({
      status: "rejected",
      reason: "migration-missing",
      version: 0,
    });

    const throwing: ProjectChatMigration = {
      fromVersion: 0,
      toVersion: 1,
      migrate() {
        throw new Error("hostile migration detail");
      },
    };
    expect(deserializeProjectChatState(legacy, [throwing])).toEqual({
      status: "rejected",
      reason: "migration-failed",
      version: 0,
    });

    const corrupt: ProjectChatMigration = {
      fromVersion: 0,
      toVersion: 1,
      migrate: () => ({ schemaVersion: 1, projects: [] }),
    };
    expect(deserializeProjectChatState(legacy, [corrupt])).toEqual({
      status: "rejected",
      reason: "invalid-state",
    });
  });
});

import {
  PERSONAL_PROJECT_ID,
  PROJECT_CHAT_SCHEMA_VERSION,
  type FolderProject,
  type PersonalProject,
  type Project,
  type ProjectChat,
  type ProjectChatState,
  type PrimeChatBinding,
} from "./contract";
import {
  hasStrictJsonObjectKeys,
} from "./strictJson";
import { snapshotUntrusted } from "./strictSnapshot";
import {
  isPrimeSessionFile,
  isProjectChatId,
  isProjectChatLabel,
  MAX_PROJECT_CHAT_JSON_BYTES,
  utf8ByteLengthWithin,
} from "./validation";

type UnknownRecord = Record<string, unknown>;
const MAX_PROJECT_CHAT_MIGRATIONS = 1024;

export interface ProjectChatMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (snapshot: Readonly<UnknownRecord>) => unknown;
}

interface PreparedProjectChatMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: ProjectChatMigration["migrate"];
}

export type ProjectChatSerializationResult =
  | Readonly<{ status: "serialized"; json: string }>
  | Readonly<{ status: "rejected"; reason: "invalid-state" }>;

export type ProjectChatLoadRejectionReason =
  | "invalid-json"
  | "invalid-snapshot"
  | "unsupported-version"
  | "migration-missing"
  | "migration-invalid"
  | "migration-failed"
  | "invalid-state";

export type ProjectChatLoadResult =
  | Readonly<{ status: "loaded"; state: ProjectChatState }>
  | Readonly<{
      status: "migrated";
      fromVersion: number;
      state: ProjectChatState;
    }>
  | Readonly<{
      status: "rejected";
      reason: ProjectChatLoadRejectionReason;
      version?: number;
    }>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every(
      (key): key is string => typeof key === "string" && keys.includes(key),
    )
  );
}

function validFolderPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function decodePrimeChatBinding(value: unknown): PrimeChatBinding | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "accountId", "sessionId", "sessionFile", "agentId"]) ||
    value.kind !== "prime-session" ||
    (value.accountId !== null && !isProjectChatId(value.accountId)) ||
    !isProjectChatId(value.sessionId) ||
    !isPrimeSessionFile(value.sessionFile) ||
    (value.agentId !== null && !isProjectChatId(value.agentId))
  ) {
    return undefined;
  }
  return {
    kind: "prime-session",
    accountId: value.accountId,
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    agentId: value.agentId,
  };
}

function decodeChat(
  value: unknown,
  ownerId: string,
  knownChatIds: Set<string>,
): ProjectChat | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "projectId", "title", "pinned", "archived", "binding"]) ||
    !isProjectChatId(value.id) ||
    value.projectId !== ownerId ||
    !isProjectChatLabel(value.title) ||
    typeof value.pinned !== "boolean" ||
    typeof value.archived !== "boolean" ||
    knownChatIds.has(value.id)
  ) {
    return undefined;
  }

  const binding = decodePrimeChatBinding(value.binding);
  if (binding === undefined) return undefined;

  knownChatIds.add(value.id);
  return {
    id: value.id,
    projectId: ownerId,
    title: value.title,
    pinned: value.pinned,
    archived: value.archived,
    binding,
  };
}

function decodeProject(
  value: unknown,
  knownProjectIds: Set<string>,
  knownChatIds: Set<string>,
): Project | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "kind",
      "name",
      "root",
      "pinned",
      "archived",
      "selectedChatId",
      "chats",
    ]) ||
    !isProjectChatId(value.id) ||
    knownProjectIds.has(value.id) ||
    !isProjectChatLabel(value.name) ||
    typeof value.pinned !== "boolean" ||
    typeof value.archived !== "boolean" ||
    (value.selectedChatId !== null && !isProjectChatId(value.selectedChatId)) ||
    !Array.isArray(value.chats)
  ) {
    return undefined;
  }

  let projectIdentity:
    | Pick<PersonalProject, "id" | "kind" | "name" | "root" | "archived">
    | Pick<FolderProject, "id" | "kind" | "name" | "root" | "archived">;

  if (value.kind === "personal") {
    if (
      value.id !== PERSONAL_PROJECT_ID ||
      value.name !== "Personal" ||
      value.archived !== false ||
      !isRecord(value.root) ||
      !hasExactKeys(value.root, ["kind"]) ||
      value.root.kind !== "studio-managed-empty"
    ) {
      return undefined;
    }
    projectIdentity = {
      id: PERSONAL_PROJECT_ID,
      kind: "personal",
      name: "Personal",
      root: { kind: "studio-managed-empty" },
      archived: false,
    };
  } else if (value.kind === "folder") {
    if (
      value.id === PERSONAL_PROJECT_ID ||
      !isRecord(value.root) ||
      !hasExactKeys(value.root, ["kind", "path"]) ||
      value.root.kind !== "folder" ||
      !validFolderPath(value.root.path)
    ) {
      return undefined;
    }
    projectIdentity = {
      id: value.id,
      kind: "folder",
      name: value.name,
      root: { kind: "folder", path: value.root.path },
      archived: value.archived,
    };
  } else {
    return undefined;
  }

  knownProjectIds.add(value.id);
  const chats: ProjectChat[] = [];
  for (let index = 0; index < value.chats.length; index += 1) {
    const chat = decodeChat(value.chats[index], value.id, knownChatIds);
    if (!chat) return undefined;
    chats.push(chat);
  }

  const selectedChat =
    value.selectedChatId === null
      ? undefined
      : chats.find((chat) => chat.id === value.selectedChatId);
  if (value.selectedChatId !== null && (!selectedChat || selectedChat.archived)) {
    return undefined;
  }

  if (projectIdentity.kind === "personal") {
    return {
      id: PERSONAL_PROJECT_ID,
      kind: "personal",
      name: "Personal",
      root: { kind: "studio-managed-empty" },
      pinned: value.pinned,
      archived: false,
      selectedChatId: value.selectedChatId,
      chats,
    };
  }
  return {
    id: projectIdentity.id,
    kind: "folder",
    name: projectIdentity.name,
    root: projectIdentity.root,
    pinned: value.pinned,
    archived: projectIdentity.archived,
    selectedChatId: value.selectedChatId,
    chats,
  };
}

function decodeCurrentState(value: unknown): ProjectChatState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "selectedProjectId", "projects"]) ||
    value.schemaVersion !== PROJECT_CHAT_SCHEMA_VERSION ||
    !isProjectChatId(value.selectedProjectId) ||
    !Array.isArray(value.projects)
  ) {
    return undefined;
  }

  const projectIds = new Set<string>();
  const chatIds = new Set<string>();
  const projects: Project[] = [];
  for (let index = 0; index < value.projects.length; index += 1) {
    const project = decodeProject(value.projects[index], projectIds, chatIds);
    if (!project) return undefined;
    projects.push(project);
  }

  const personalProjects = projects.filter(
    (project) => project.id === PERSONAL_PROJECT_ID && project.kind === "personal",
  );
  const selectedProject = projects.find(
    (project) => project.id === value.selectedProjectId,
  );
  if (
    personalProjects.length !== 1 ||
    !selectedProject ||
    selectedProject.archived
  ) {
    return undefined;
  }

  return {
    schemaVersion: PROJECT_CHAT_SCHEMA_VERSION,
    selectedProjectId: value.selectedProjectId,
    projects,
  };
}

export function serializeProjectChatState(
  value: unknown,
): ProjectChatSerializationResult {
  try {
    const snapshot = snapshotUntrusted(value);
    if (snapshot.status === "rejected") {
      return { status: "rejected", reason: "invalid-state" };
    }
    const state = decodeCurrentState(snapshot.value);
    if (!state) return { status: "rejected", reason: "invalid-state" };
    try {
      const json = JSON.stringify(state);
      return utf8ByteLengthWithin(json, MAX_PROJECT_CHAT_JSON_BYTES) !== undefined
        ? { status: "serialized", json }
        : { status: "rejected", reason: "invalid-state" };
    } catch {
      return { status: "rejected", reason: "invalid-state" };
    }
  } catch {
    return { status: "rejected", reason: "invalid-state" };
  }
}

function snapshotVersion(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const version = value.schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : undefined;
}

const V1_STATE_KEYS = ["schemaVersion", "selectedProjectId", "projects"] as const;
const V1_PROJECT_KEYS = [
  "id", "kind", "name", "root", "pinned", "archived", "selectedChatId", "chats",
] as const;
const V1_CHAT_KEYS = ["id", "projectId", "title", "pinned", "archived"] as const;

function invalidMigratedState(): UnknownRecord {
  return { schemaVersion: PROJECT_CHAT_SCHEMA_VERSION, selectedProjectId: "", projects: [] };
}

function migrateSchemaV1ToV2(snapshot: Readonly<UnknownRecord>): unknown {
  if (
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== 1 ||
    !hasExactKeys(snapshot, V1_STATE_KEYS) ||
    !Array.isArray(snapshot.projects)
  ) {
    return invalidMigratedState();
  }
  const projects: unknown[] = [];
  for (let projectIndex = 0; projectIndex < snapshot.projects.length; projectIndex += 1) {
    const project = snapshot.projects[projectIndex];
    if (!isRecord(project) || !hasExactKeys(project, V1_PROJECT_KEYS) || !Array.isArray(project.chats)) {
      return invalidMigratedState();
    }
    const chats: unknown[] = [];
    for (let chatIndex = 0; chatIndex < project.chats.length; chatIndex += 1) {
      const chat = project.chats[chatIndex];
      if (!isRecord(chat) || !hasExactKeys(chat, V1_CHAT_KEYS)) return invalidMigratedState();
      chats.push({ ...chat, binding: null });
    }
    projects.push({ ...project, chats });
  }
  return { ...snapshot, schemaVersion: PROJECT_CHAT_SCHEMA_VERSION, projects };
}

function migrationMap(
  migrations: readonly ProjectChatMigration[],
): Map<number, PreparedProjectChatMigration> | undefined {
  try {
    if (!Array.isArray(migrations)) return undefined;
    const migrationCount = migrations.length;
    if (
      !Number.isSafeInteger(migrationCount) ||
      migrationCount < 0 ||
      migrationCount > MAX_PROJECT_CHAT_MIGRATIONS
    ) {
      return undefined;
    }
    const byVersion = new Map<number, PreparedProjectChatMigration>([
      [1, { fromVersion: 1, toVersion: 2, migrate: migrateSchemaV1ToV2 }],
    ]);
    for (let index = 0; index < migrationCount; index += 1) {
      const migration = migrations[index];
      if (typeof migration !== "object" || migration === null) return undefined;
      const fromVersion = migration.fromVersion;
      const toVersion = migration.toVersion;
      const migrate = migration.migrate;
      if (
        !Number.isInteger(fromVersion) ||
        fromVersion < 0 ||
        toVersion !== fromVersion + 1 ||
        typeof migrate !== "function" ||
        byVersion.has(fromVersion)
      ) {
        return undefined;
      }
      byVersion.set(fromVersion, {
        fromVersion,
        toVersion,
        migrate,
      });
    }
    return byVersion;
  } catch {
    return undefined;
  }
}

export function deserializeProjectChatState(
  serialized: string,
  migrations: readonly ProjectChatMigration[] = [],
): ProjectChatLoadResult {
  try {
    if (typeof serialized !== "string" || !hasStrictJsonObjectKeys(serialized)) {
      return { status: "rejected", reason: "invalid-json" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      return { status: "rejected", reason: "invalid-json" };
    }

    const initialSnapshot = snapshotUntrusted(parsed);
    if (initialSnapshot.status === "rejected") {
      return { status: "rejected", reason: "invalid-snapshot" };
    }
    let snapshot: unknown = initialSnapshot.value;
    const version = snapshotVersion(snapshot);
    if (version === undefined) {
      return { status: "rejected", reason: "invalid-snapshot" };
    }
    if (version > PROJECT_CHAT_SCHEMA_VERSION) {
      return { status: "rejected", reason: "unsupported-version", version };
    }

    const startVersion = version;
    if (version < PROJECT_CHAT_SCHEMA_VERSION) {
      const byVersion = migrationMap(migrations);
      if (!byVersion) {
        return { status: "rejected", reason: "migration-invalid", version };
      }

      let currentVersion = version;
      while (currentVersion < PROJECT_CHAT_SCHEMA_VERSION) {
        const migration = byVersion.get(currentVersion);
        if (!migration) {
          return {
            status: "rejected",
            reason: "migration-missing",
            version: currentVersion,
          };
        }
        try {
          const migrated = migration.migrate(snapshot as Readonly<UnknownRecord>);
          const migratedSnapshot = snapshotUntrusted(migrated);
          if (migratedSnapshot.status === "rejected") {
            return {
              status: "rejected",
              reason: "migration-failed",
              version: currentVersion,
            };
          }
          snapshot = migratedSnapshot.value;
        } catch {
          return {
            status: "rejected",
            reason: "migration-failed",
            version: currentVersion,
          };
        }
        if (snapshotVersion(snapshot) !== migration.toVersion) {
          return {
            status: "rejected",
            reason: "migration-failed",
            version: currentVersion,
          };
        }
        currentVersion = migration.toVersion;
      }
    }

    const state = decodeCurrentState(snapshot);
    if (!state) return { status: "rejected", reason: "invalid-state" };
    return startVersion === PROJECT_CHAT_SCHEMA_VERSION
      ? { status: "loaded", state }
      : { status: "migrated", fromVersion: startVersion, state };
  } catch {
    return { status: "rejected", reason: "invalid-snapshot" };
  }
}

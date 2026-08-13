export type WorkspaceIdentityProjection =
  | Readonly<{
      status: "configured";
      workspaceId: string;
      name: string;
      detail: string;
      initials: string;
    }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type WorkspaceIdentitySource =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "ready"; defaultCwd: string | null | undefined }>;

function displayName(path: string): string {
  const withoutTrailingSeparators = path.replace(/[\\/]+$/u, "");
  const segments = withoutTrailingSeparators.split(/[\\/]+/u).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const characters = words.length > 1
    ? [Array.from(words[0] ?? "")[0], Array.from(words[1] ?? "")[0]]
    : Array.from(words[0] ?? "").slice(0, 2);
  return characters.filter(Boolean).join("").toLocaleUpperCase() || "?";
}

export function deriveWorkspaceIdentity(source: WorkspaceIdentitySource): WorkspaceIdentityProjection {
  if (source.status !== "ready") return source;
  const configuredPath = source.defaultCwd?.trim();
  if (!configuredPath) return { status: "unavailable", reason: "No default workspace is configured." };
  const name = displayName(configuredPath);
  return {
    status: "configured",
    workspaceId: configuredPath,
    name,
    detail: configuredPath,
    initials: initials(name),
  };
}

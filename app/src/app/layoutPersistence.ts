import type { LayoutPreferencesV1 } from "../types";

export type LayoutPersistenceResult =
  | Readonly<{ status: "updated"; value: LayoutPreferencesV1 }>
  | Readonly<{ status: "rejected"; reason: string }>;

function sameLayout(left: LayoutPreferencesV1, right: LayoutPreferencesV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.sidebarOpen === right.sidebarOpen
    && left.sidebarWidth === right.sidebarWidth
    && left.inspectorOpen === right.inspectorOpen
    && left.inspectorWidth === right.inspectorWidth
    && left.editorOpen === right.editorOpen
    && left.editorWidth === right.editorWidth
    && left.expandedProjectIds.length === right.expandedProjectIds.length
    && left.expandedProjectIds.every((id, index) => id === right.expandedProjectIds[index]);
}

type LayoutPatch = {
  -readonly [Key in Exclude<keyof LayoutPreferencesV1, "expandedProjectIds">]?: LayoutPreferencesV1[Key]
};

function changedFields(before: LayoutPreferencesV1, after: LayoutPreferencesV1): LayoutPatch {
  const patch: LayoutPatch = {};
  if (before.sidebarOpen !== after.sidebarOpen) patch.sidebarOpen = after.sidebarOpen;
  if (before.sidebarWidth !== after.sidebarWidth) patch.sidebarWidth = after.sidebarWidth;
  if (before.inspectorOpen !== after.inspectorOpen) patch.inspectorOpen = after.inspectorOpen;
  if (before.inspectorWidth !== after.inspectorWidth) patch.inspectorWidth = after.inspectorWidth;
  if (before.editorOpen !== after.editorOpen) patch.editorOpen = after.editorOpen;
  if (before.editorWidth !== after.editorWidth) patch.editorWidth = after.editorWidth;
  return patch;
}

type ProjectExpansionChanges = ReadonlyMap<string, boolean>;

function changedProjectExpansions(before: LayoutPreferencesV1, after: LayoutPreferencesV1): ProjectExpansionChanges {
  const beforeIds = new Set(before.expandedProjectIds);
  const afterIds = new Set(after.expandedProjectIds);
  const changes = new Map<string, boolean>();
  for (const id of beforeIds) if (!afterIds.has(id)) changes.set(id, false);
  for (const id of afterIds) if (!beforeIds.has(id)) changes.set(id, true);
  return changes;
}

function applyProjectExpansionChanges(value: LayoutPreferencesV1, changes: ProjectExpansionChanges): LayoutPreferencesV1 {
  if (changes.size === 0) return value;
  const expanded = new Set(value.expandedProjectIds);
  for (const [projectId, isExpanded] of changes) {
    if (isExpanded) expanded.add(projectId); else expanded.delete(projectId);
  }
  return { ...value, expandedProjectIds: [...expanded].sort() };
}

/** Serializes native full-snapshot writes while keeping the renderer optimistic. */
export class LayoutPersistenceCoordinator {
  private current: LayoutPreferencesV1;
  private localRevision = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private hydrated = false;
  private hydrationFailed = false;
  private readonly hydration: Promise<void>;
  private resolveHydration!: () => void;
  private readonly pendingHydration: Array<{
    readonly patch: LayoutPatch;
    readonly projectExpansionChanges: ProjectExpansionChanges;
    snapshot: LayoutPreferencesV1 | null;
  }> = [];

  constructor(
    initial: LayoutPreferencesV1,
    private readonly persist: (value: LayoutPreferencesV1) => Promise<LayoutPreferencesV1>,
    private readonly apply: (value: LayoutPreferencesV1) => void,
  ) {
    this.current = initial;
    this.hydration = new Promise<void>((resolve) => { this.resolveHydration = resolve; });
  }

  snapshot(): LayoutPreferencesV1 {
    return this.current;
  }

  adoptInitial(value: LayoutPreferencesV1): boolean {
    if (this.hydrated) return false;
    let merged = value;
    for (const pending of this.pendingHydration) {
      merged = { ...merged, ...pending.patch };
      merged = applyProjectExpansionChanges(merged, pending.projectExpansionChanges);
      pending.snapshot = merged;
    }
    this.pendingHydration.length = 0;
    this.current = merged;
    this.hydrated = true;
    this.apply(merged);
    this.resolveHydration();
    return true;
  }

  failInitial(): void {
    if (this.hydrated || this.hydrationFailed) return;
    this.hydrationFailed = true;
    this.pendingHydration.length = 0;
    this.resolveHydration();
  }

  update(transform: (current: LayoutPreferencesV1) => LayoutPreferencesV1): Promise<LayoutPersistenceResult> {
    const revision = ++this.localRevision;
    const next = transform(this.current);
    const pending = {
      patch: changedFields(this.current, next),
      projectExpansionChanges: changedProjectExpansions(this.current, next),
      snapshot: this.hydrated ? next : null,
    };
    if (!this.hydrated) this.pendingHydration.push(pending);
    this.current = next;
    this.apply(next);

    const operation = this.writeTail.then(async () => {
      await this.hydration;
      if (this.hydrationFailed) {
        return { status: "rejected", reason: "Layout preferences could not be loaded, so this local change was not saved." } as const;
      }
      try {
        const persisted = await this.persist(pending.snapshot!);
        if (revision === this.localRevision) {
          const changed = !sameLayout(this.current, persisted);
          this.current = persisted;
          if (changed) this.apply(persisted);
        }
        return { status: "updated", value: persisted } as const;
      } catch {
        return { status: "rejected", reason: "The layout changed for this session but could not be saved." } as const;
      }
    });
    this.writeTail = operation.then(() => undefined);
    return operation;
  }
}

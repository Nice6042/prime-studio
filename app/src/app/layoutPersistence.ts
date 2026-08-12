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

/** Serializes native full-snapshot writes while keeping the renderer optimistic. */
export class LayoutPersistenceCoordinator {
  private current: LayoutPreferencesV1;
  private localRevision = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private hydrated = false;
  private readonly hydration: Promise<void>;
  private resolveHydration!: () => void;
  private readonly pendingHydration: Array<{
    readonly transform: (current: LayoutPreferencesV1) => LayoutPreferencesV1;
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
      merged = pending.transform(merged);
      pending.snapshot = merged;
    }
    this.pendingHydration.length = 0;
    this.current = merged;
    this.hydrated = true;
    this.apply(merged);
    this.resolveHydration();
    return true;
  }

  update(transform: (current: LayoutPreferencesV1) => LayoutPreferencesV1): Promise<LayoutPersistenceResult> {
    const revision = ++this.localRevision;
    const next = transform(this.current);
    const pending = { transform, snapshot: this.hydrated ? next : null };
    if (!this.hydrated) this.pendingHydration.push(pending);
    this.current = next;
    this.apply(next);

    const operation = this.writeTail.then(async () => {
      await this.hydration;
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

import { describe, expect, it } from "vitest";

import { LayoutPersistenceCoordinator } from "./layoutPersistence";
import type { LayoutPreferencesV1 } from "../types";

const initial: LayoutPreferencesV1 = {
  schemaVersion: 1,
  sidebarOpen: true,
  sidebarWidth: 264,
  inspectorOpen: true,
  inspectorWidth: 384,
  editorOpen: false,
  editorWidth: 400,
  expandedProjectIds: ["project-a"],
};

describe("LayoutPersistenceCoordinator", () => {
  it("serializes full-snapshot writes and preserves rapid updates", async () => {
    const writes: LayoutPreferencesV1[] = [];
    const releases: Array<() => void> = [];
    const applied: LayoutPreferencesV1[] = [];
    const coordinator = new LayoutPersistenceCoordinator(initial, async (value) => {
      writes.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
      return value;
    }, (value) => applied.push(value));

    const collapse = coordinator.update((current) => ({ ...current, expandedProjectIds: [] }));
    const resize = coordinator.update((current) => ({ ...current, inspectorWidth: 520 }));

    await Promise.resolve();
    expect(writes).toEqual([{ ...initial, expandedProjectIds: [] }]);
    releases.shift()?.();
    await collapse;
    await Promise.resolve();
    expect(writes).toEqual([
      { ...initial, expandedProjectIds: [] },
      { ...initial, expandedProjectIds: [], inspectorWidth: 520 },
    ]);
    releases.shift()?.();
    await expect(resize).resolves.toEqual(
      { status: "updated", value: { ...initial, expandedProjectIds: [], inspectorWidth: 520 } },
    );
    expect(await collapse).toEqual(
      { status: "updated", value: { ...initial, expandedProjectIds: [] } },
    );
    expect(coordinator.snapshot()).toEqual({ ...initial, expandedProjectIds: [], inspectorWidth: 520 });
    expect(applied[applied.length - 1]).toEqual({ ...initial, expandedProjectIds: [], inspectorWidth: 520 });
  });

  it("does not let an older persisted response replace a newer optimistic snapshot", async () => {
    let releaseFirst!: () => void;
    const applied: LayoutPreferencesV1[] = [];
    let calls = 0;
    const coordinator = new LayoutPersistenceCoordinator(initial, async (value) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return value;
    }, (value) => applied.push(value));

    const first = coordinator.update((current) => ({ ...current, sidebarWidth: 300 }));
    const second = coordinator.update((current) => ({ ...current, sidebarWidth: 340 }));
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    expect(applied.map((value) => value.sidebarWidth)).toEqual([300, 340]);
    expect(coordinator.snapshot().sidebarWidth).toBe(340);
  });

  it("does not let late initial hydration erase a local change", () => {
    const applied: LayoutPreferencesV1[] = [];
    const coordinator = new LayoutPersistenceCoordinator(initial, async (value) => value, (value) => applied.push(value));

    void coordinator.update((current) => ({ ...current, sidebarOpen: false }));
    const adopted = coordinator.adoptInitial({ ...initial, inspectorWidth: 600 });

    expect(adopted).toBe(false);
    expect(coordinator.snapshot()).toEqual({ ...initial, sidebarOpen: false });
  });
});

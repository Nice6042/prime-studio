import { describe, expect, it } from "vitest";

import {
  commandPlacements,
  createStudioCommandExecutor,
  operationForStudioCommand,
  shortcutStudioCommand,
  studioCommand,
  studioCommands,
  validateStudioCommands,
  type StudioCommand,
} from "./commandRegistry";

describe("studio command registry", () => {
  it("has unique IDs and shortcuts", () => {
    expect(new Set(studioCommands.map((command) => command.id)).size).toBe(studioCommands.length);
    const shortcuts = studioCommands.flatMap((command) => command.shortcuts);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("owns every executable title menu and window control through a unique placement", () => {
    expect(new Set(commandPlacements("title-menu").map((placement) => placement.id))).toEqual(new Set([
      "title.file.new-chat",
      "title.file.settings",
      "title.edit.undo",
      "title.edit.redo",
      "title.view.sidebar",
      "title.view.inspector",
      "title.window.minimize",
      "title.window.maximize",
      "title.help.prime-agent",
      "title.help.support",
    ]));
    expect(commandPlacements("window-control").map((placement) => placement.id)).toEqual([
      "window-control.minimize",
      "window-control.maximize",
      "window-control.close",
    ]);
    expect(commandPlacements("title-menu").every((placement) => studioCommand(placement.commandId))).toBe(true);
  });

  it("owns every executable title action and expanded-sidebar collapse presentation", () => {
    expect(new Set(commandPlacements("title-action").map((placement) => placement.commandId))).toEqual(new Set([
      "sidebar.toggle",
      "inspector.toggle",
      "editor.open",
      "editor.close",
      "palette.open",
    ]));
    expect(commandPlacements("sidebar").find((placement) => placement.id === "sidebar.collapse")?.commandId).toBe("sidebar.toggle");
  });

  it("does not advertise menu-only commands in the palette or shortcut settings", () => {
    expect(commandPlacements("palette").some((placement) => placement.commandId === "history.undo")).toBe(false);
    expect(commandPlacements("settings-shortcut").some((placement) => placement.commandId === "history.undo")).toBe(false);
    expect(commandPlacements("palette").some((placement) => placement.commandId === "help.support")).toBe(false);
  });

  it("rejects duplicate chords and placement IDs before consumers can drift", () => {
    const base = studioCommands[0]!;
    const duplicateChord: StudioCommand = { ...base, id: "history.undo", placements: [] };
    expect(() => validateStudioCommands([base, duplicateChord])).toThrow(/duplicate shortcut Ctrl\+N/i);

    const duplicatePlacement: StudioCommand = {
      ...base,
      id: "history.undo",
      shortcuts: [],
      placements: [{ id: base.placements[0]!.id, surface: "title-menu", menu: "Edit" }],
    };
    expect(() => validateStudioCommands([base, duplicatePlacement])).toThrow(/duplicate placement/i);
  });

  it("keeps durable chat creation available without a live Harness session", () => {
    const create = studioCommands.find((command) => command.id === "chat.new")!;
    expect(create.availability({ admissionConnected: false })).toEqual({ enabled: true });
  });

  it("derives the menu, palette, and shortcut operation from one command definition", () => {
    const command = shortcutStudioCommand({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "n" });
    expect(command?.id).toBe("chat.new");
    expect(operationForStudioCommand(command!, "project-current")).toEqual({
      action: "catalog.chat.create",
      payload: { projectId: "project-current" },
    });
  });

  it("builds and dispatches one identical operation per menu, keyboard, and palette invocation", async () => {
    const operations: unknown[] = [];
    const dispatch = async (operation: unknown) => { operations.push(operation); return { status: "updated" as const, revision: 1 }; };
    const run = createStudioCommandExecutor(() => ({ projectId: "project-current", availability: { admissionConnected: true } }), dispatch);
    await run("chat.new");
    await run(shortcutStudioCommand({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "n" })!.id);
    await run("chat.new");
    expect(operations).toEqual([
      { action: "catalog.chat.create", payload: { projectId: "project-current" } },
      { action: "catalog.chat.create", payload: { projectId: "project-current" } },
      { action: "catalog.chat.create", payload: { projectId: "project-current" } },
    ]);
  });

  it("keeps the shortcut consumer parity table on one label, chord, action and availability", () => {
    const expected = [
      ["chat.new", "New chat", "Ctrl+N", "catalog.chat.create", "title-menu,settings-shortcut,sidebar,rail,palette"],
      ["palette.open", "Open command palette", "Ctrl+K", "palette.open", "settings-shortcut,sidebar,rail,palette,title-action"],
      ["sidebar.toggle", "Toggle projects", "Ctrl+B", "layout.sidebar.toggle", "title-menu,title-action,settings-shortcut,sidebar,rail,palette"],
      ["inspector.toggle", "Toggle Harness", "Ctrl+J", "layout.inspector.toggle", "title-menu,title-action,settings-shortcut,palette"],
      ["settings.open", "Open settings", "Ctrl+,", "route.settings.open", "title-menu,settings-shortcut,sidebar,rail,palette"],
    ] as const;
    expect(studioCommands.filter((command) => command.shortcuts.length > 0).map((command) => [
      command.id,
      command.label,
      command.shortcuts[0],
      command.action,
      command.placements.map((placement) => placement.surface).sort().join(","),
    ])).toEqual(expected.map(([id, label, chord, action, surfaces]) => [id, label, chord, action, surfaces.split(",").sort().join(",")]));
    for (const command of studioCommands.filter((candidate) => candidate.shortcuts.length > 0)) {
      expect(command.availability({ admissionConnected: false })).toEqual({ enabled: true });
    }
  });

  it("labels New project as the presentation command that opens its verified creation dialog", () => {
    const command = studioCommands.find((candidate) => candidate.id === "project.new")!;
    expect(command.action).toBe("surface.popover.toggle");
    expect(operationForStudioCommand(command, "project-current")).toEqual({
      action: "surface.popover.toggle",
      payload: { popoverId: "create-project" },
    });
  });
});

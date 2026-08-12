import { describe, expect, it } from "vitest";

import { operationForStudioCommand, shortcutStudioCommand, studioCommands } from "./commandRegistry";

describe("studio command registry", () => {
  it("has unique IDs and shortcuts", () => {
    expect(new Set(studioCommands.map((command) => command.id)).size).toBe(studioCommands.length);
    const shortcuts = studioCommands.flatMap((command) => command.shortcuts);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
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

  it("labels New project as the presentation command that opens its verified creation dialog", () => {
    const command = studioCommands.find((candidate) => candidate.id === "project.new")!;
    expect(command.action).toBe("surface.popover.toggle");
    expect(operationForStudioCommand(command, "project-current")).toEqual({
      action: "surface.popover.toggle",
      payload: { popoverId: "create-project" },
    });
  });
});

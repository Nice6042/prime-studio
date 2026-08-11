import { describe, expect, it } from "vitest";

import { studioCommands } from "./commandRegistry";

describe("studio command registry", () => {
  it("has unique IDs and shortcuts", () => {
    expect(new Set(studioCommands.map((command) => command.id)).size).toBe(studioCommands.length);
    const shortcuts = studioCommands.flatMap((command) => command.shortcuts);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("keeps unavailable effects visible with exact reasons", () => {
    const create = studioCommands.find((command) => command.id === "chat.new")!;
    expect(create.availability({ admissionConnected: false })).toEqual({ enabled: false, reason: "New chat activation is not connected yet." });
  });
});

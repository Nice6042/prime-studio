import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { loadHarnessComposerProjection } from "./composerProjectionClient";

describe("Harness composer projection client", () => {
  beforeEach(() => invoke.mockReset());

  it("decodes only a bounded verified native projection", async () => {
    invoke.mockResolvedValue(JSON.stringify({
      models: [{ id: "openai/gpt-real", label: "GPT Real", shortLabel: "GPT", enabled: true }],
      selectedModel: "openai/gpt-real",
      thinkingLevels: ["low", "high"],
      selectedThinking: "high",
      supportedCommands: ["model", "effort", "compact", "fork", "export"],
    }));

    await expect(loadHarnessComposerProjection("session-1")).resolves.toEqual({
      models: [{ id: "openai/gpt-real", label: "GPT Real", shortLabel: "GPT", enabled: true }],
      selectedModel: "openai/gpt-real",
      thinkingLevels: ["low", "high"],
      selectedThinking: "high",
      supportedCommands: ["model", "effort", "compact", "fork", "export"],
    });
    expect(invoke).toHaveBeenCalledWith("harness_composer_projection", { request: { sessionId: "session-1" } });
  });

  it.each([
    { models: [], selectedModel: null, thinkingLevels: [], selectedThinking: null, supportedCommands: ["model"] },
    { models: [{ id: "duplicate", label: "One", shortLabel: "One", enabled: true }, { id: "duplicate", label: "Two", shortLabel: "Two", enabled: true }], selectedModel: "duplicate", thinkingLevels: [], selectedThinking: null, supportedCommands: [] },
    { models: [], selectedModel: null, thinkingLevels: ["invented"], selectedThinking: null, supportedCommands: [] },
  ])("rejects an unverified or inconsistent projection", async (projection) => {
    invoke.mockResolvedValue(JSON.stringify(projection));
    await expect(loadHarnessComposerProjection("session-1")).rejects.toThrow("Harness composer projection unavailable");
  });
});

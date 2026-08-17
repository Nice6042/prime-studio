import { describe, expect, it } from "vitest";

import { STUDIO_ACTIONS } from "./studioOperations";

describe("General settings operation ownership", () => {
  it("keeps default workspace selection at the cancellable native dialog boundary", () => {
    expect(STUDIO_ACTIONS["settings.default-workspace.pick"]).toEqual({
      owner: { kind: "native", boundary: "dialog" },
      outcomes: ["updated", "cancelled", "unavailable", "rejected"],
    });
  });

  it("persists whole-panel restoration through layout preferences", () => {
    expect(STUDIO_ACTIONS["layout.panels.reset"]).toEqual({
      owner: { kind: "renderer", persistence: "layout_preferences" },
      outcomes: ["updated", "unavailable", "rejected"],
    });
  });
});

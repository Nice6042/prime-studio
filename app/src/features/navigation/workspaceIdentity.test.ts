import { describe, expect, it } from "vitest";

import { deriveWorkspaceIdentity } from "./workspaceIdentity";

describe("deriveWorkspaceIdentity", () => {
  it("projects only the configured workspace path into a display identity", () => {
    expect(deriveWorkspaceIdentity({ status: "ready", defaultCwd: "D:\\Clients\\Prime Studio" })).toEqual({
      status: "configured",
      workspaceId: "D:\\Clients\\Prime Studio",
      name: "Prime Studio",
      detail: "D:\\Clients\\Prime Studio",
      initials: "PS",
    });
  });

  it("fails closed when settings have no configured workspace", () => {
    expect(deriveWorkspaceIdentity({ status: "ready", defaultCwd: null })).toEqual({
      status: "unavailable",
      reason: "No default workspace is configured.",
    });
  });

  it("distinguishes loading from a settings read failure", () => {
    expect(deriveWorkspaceIdentity({ status: "loading" })).toEqual({ status: "loading" });
    expect(deriveWorkspaceIdentity({ status: "unavailable", reason: "Settings could not be loaded." })).toEqual({
      status: "unavailable",
      reason: "Settings could not be loaded.",
    });
  });
});

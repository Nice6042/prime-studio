import { describe, expect, it } from "vitest";

import { residentCreationDisabledReason } from "./residentCreationPolicy";

describe("resident creation preference policy", () => {
  it("allows creation only when every unsupported selection is at Harness default", () => {
    expect(residentCreationDisabledReason({})).toBeNull();
    expect(residentCreationDisabledReason({ defaultAccount: null, defaultModel: null, defaultThinking: null })).toBeNull();
  });

  it.each([
    [{ defaultAccount: "account-1" }, "account"],
    [{ defaultModel: "gpt-real" }, "model"],
    [{ defaultThinking: "high" }, "thinking"],
  ] as const)("gives a precise disabled reason for an unverifiable selection", (settings, selection) => {
    expect(residentCreationDisabledReason(settings)).toContain(selection);
    expect(residentCreationDisabledReason(settings)).toContain("Harness default");
  });
});

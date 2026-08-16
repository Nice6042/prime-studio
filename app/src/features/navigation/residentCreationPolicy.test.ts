import { describe, expect, it } from "vitest";

import {
  RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON,
  residentCreationDisabledReason,
} from "./residentCreationPolicy";

describe("resident creation preference policy", () => {
  it("allows creation only when every unsupported selection is at Harness default", () => {
    expect(residentCreationDisabledReason({})).toBeNull();
    expect(residentCreationDisabledReason({ defaultAccount: null, defaultModel: null, defaultThinking: null })).toBeNull();
  });

  it("names the exact upstream account-selection boundary", () => {
    const reason = residentCreationDisabledReason({ defaultAccount: "account-1" });
    expect(reason).toContain(RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON);
    expect(reason).toContain("Harness default");
  });

  it.each([
    [{ defaultProvider: "openai-codex" }, "provider"],
    [{ defaultModel: "gpt-real" }, "model"],
    [{ defaultThinking: "high" }, "thinking"],
  ] as const)("gives a precise disabled reason for an unverifiable selection", (settings, selection) => {
    expect(residentCreationDisabledReason(settings)).toContain(selection);
    expect(residentCreationDisabledReason(settings)).toContain("Harness default");
  });
});

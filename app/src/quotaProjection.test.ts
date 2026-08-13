import { describe, expect, it } from "vitest";

import { projectSubscriptionQuota } from "./quotaProjection";
import type { Account, CodexSubscription, RateLimits } from "./types";

const account = (id: string, provider: string): Account => ({
  id,
  label: id,
  provider,
  agentDir: `D:\\fixture\\${id}`,
  createdAt: 1,
});

const codex: CodexSubscription = {
  usedPercent: 42.5,
  windowMinutes: 300,
  resetsAt: 1_800_000_000_000,
  secondary: { usedPercent: 70, windowMinutes: 10_080, resetsAt: 1_800_600_000_000 },
  planType: "pro",
  staleAsOf: 1_799_999_000_000,
};

describe("projectSubscriptionQuota", () => {
  it("attributes one Codex CLI snapshot to the only Codex account without projecting cost", () => {
    const result = projectSubscriptionQuota([account("codex-one", "openai-codex")], codex, new Map());

    expect(result.accountFacts).toEqual([{
      scope: "account",
      accountId: "codex-one",
      provider: "openai-codex",
      source: "codex_cli_snapshot",
      availability: "available",
      percent: 42.5,
      windowMinutes: 300,
      resetsAt: 1_800_000_000_000,
      secondary: { percent: 70, windowMinutes: 10_080, resetsAt: 1_800_600_000_000 },
      planType: "pro",
      observedAt: 1_799_999_000_000,
    }]);
    expect(result.providerFacts).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/cost|spend/iu);
  });

  it("projects one unattributed provider fact for multiple Codex accounts", () => {
    const result = projectSubscriptionQuota([
      account("codex-one", "openai-codex"),
      account("codex-two", "openai-codex"),
    ], codex, new Map());

    expect(result.accountFacts).toEqual([]);
    expect(result.providerFacts).toEqual([expect.objectContaining({
      scope: "provider",
      provider: "openai-codex",
      availability: "available",
      percent: 42.5,
      ambiguousAccountIds: ["codex-one", "codex-two"],
    })]);
  });

  it("keeps a missing Codex log explicitly unavailable instead of projecting zero", () => {
    const result = projectSubscriptionQuota([account("codex-one", "openai-codex")], null, new Map());

    expect(result.accountFacts).toEqual([expect.objectContaining({
      accountId: "codex-one",
      availability: "unavailable",
      reason: "codex_snapshot_missing",
    })]);
    expect(result.accountFacts[0]).not.toHaveProperty("percent");
  });

  it("uses attributable Anthropic utilization, window, reset, and observation exactly when valid", () => {
    const limits: RateLimits = {
      utilization: 0.84,
      representativeWindow: "seven_day",
      windows: { seven_day: { utilization: 0.84, resetsAt: 1_800_000_000 } },
      seenAt: 1_799_000_000_000,
    };
    const result = projectSubscriptionQuota(
      [account("claude", "anthropic")],
      null,
      new Map([["claude", limits]]),
    );

    expect(result.accountFacts).toEqual([expect.objectContaining({
      source: "anthropic_rate_limits",
      availability: "available",
      percent: 84,
      windowLabel: "seven_day",
      resetsAt: 1_800_000_000_000,
      observedAt: 1_799_000_000_000,
    })]);
  });

  it("treats absent or invalid Anthropic evidence as unavailable, never zero", () => {
    const missing = projectSubscriptionQuota([account("missing", "anthropic")], null, new Map());
    const invalid = projectSubscriptionQuota(
      [account("invalid", "anthropic")],
      null,
      new Map([["invalid", { utilization: 1.2, seenAt: 1 }]]),
    );

    for (const result of [missing, invalid]) {
      expect(result.accountFacts[0]).toEqual(expect.objectContaining({
        availability: "unavailable",
        reason: "anthropic_not_reported",
      }));
      expect(result.accountFacts[0]).not.toHaveProperty("percent");
    }
  });

  it("marks Prime and unknown providers unsupported without a quota percentage", () => {
    const result = projectSubscriptionQuota([
      account("prime", "prime-inference"),
      account("other", "extension-provider"),
    ], codex, new Map());

    expect(result.accountFacts).toHaveLength(2);
    expect(result.accountFacts.every((fact) => fact.availability === "unavailable" && fact.reason === "provider_unsupported")).toBe(true);
    expect(result.accountFacts.every((fact) => !("percent" in fact))).toBe(true);
  });
});

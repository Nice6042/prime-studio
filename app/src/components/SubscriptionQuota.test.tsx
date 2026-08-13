import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SubscriptionQuotaProjection } from "../quotaProjection";
import { SubscriptionQuota } from "./SubscriptionQuota";

describe("SubscriptionQuota", () => {
  it("renders stale Codex primary/secondary windows and group ambiguity without attaching an account", () => {
    const projection: SubscriptionQuotaProjection = { accountFacts: [], providerFacts: [{
      scope: "provider",
      provider: "openai-codex",
      source: "codex_cli_snapshot",
      availability: "available",
      percent: 42.5,
      windowMinutes: 300,
      resetsAt: 1_800_000_000_000,
      secondary: { percent: 70, windowMinutes: 10_080, resetsAt: 1_800_600_000_000 },
      planType: "pro",
      observedAt: 1_799_999_000_000,
      ambiguousAccountIds: ["one", "two"],
    }] };

    render(<SubscriptionQuota projection={projection} accountLabels={new Map([["one", "Work"], ["two", "Personal"]])} />);

    expect(screen.getByText(/Codex CLI snapshot/)).toBeVisible();
    expect(screen.getByText("42.5%")).toBeVisible();
    expect(screen.getByText("70.0%")).toBeVisible();
    expect(screen.getByText(/As of/)).toBeVisible();
    expect(screen.getByText(/cannot tell which account/i)).toBeVisible();
    expect(screen.queryByText(/API-equivalent/i)).not.toBeInTheDocument();
  });

  it("renders Anthropic exact evidence and explicit unsupported/missing states without zero bars", () => {
    const projection: SubscriptionQuotaProjection = { accountFacts: [{
      scope: "account", accountId: "claude", provider: "anthropic", source: "anthropic_rate_limits",
      availability: "available", percent: 84, windowLabel: "seven_day", resetsAt: 1_800_000_000_000,
      observedAt: 1_799_000_000_000,
    }, {
      scope: "account", accountId: "prime", provider: "prime-inference", source: "unsupported",
      availability: "unavailable", reason: "provider_unsupported",
    }, {
      scope: "account", accountId: "codex", provider: "openai-codex", source: "codex_cli_snapshot",
      availability: "unavailable", reason: "codex_snapshot_missing",
    }], providerFacts: [] };

    const { container } = render(<SubscriptionQuota projection={projection} accountLabels={new Map([["claude", "Claude"], ["prime", "Prime"], ["codex", "Codex"]])} />);

    expect(screen.getByText("84.0%")).toBeVisible();
    expect(screen.getByText(/seven_day/)).toBeVisible();
    expect(screen.getByText(/no quota reported by provider/i)).toBeVisible();
    expect(screen.getByText(/no Codex CLI snapshot/i)).toBeVisible();
    expect(container.querySelectorAll(".meter-fill")).toHaveLength(1);
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("visibly escapes untrusted Codex plan copy", () => {
    const hostile = "pro\u202Ecod.exe\nline";
    const projection: SubscriptionQuotaProjection = { accountFacts: [{
      scope: "account", accountId: "codex", provider: "openai-codex", source: "codex_cli_snapshot",
      availability: "available", percent: 10, windowMinutes: 300, planType: hostile, observedAt: 1,
    }], providerFacts: [] };

    render(<SubscriptionQuota projection={projection} accountLabels={new Map([["codex", "Codex"]])} />);
    expect(document.body.textContent).not.toContain(hostile);
    expect(screen.getByText(/\[escaped\].*\\u\{202E\}.*\\n/u)).toBeVisible();
  });
});

import { describe, expect, it } from "vitest";

import type { AccountRemovalPlan } from "../types";
import {
  deletionErrorMessage,
  formatRemovalEstimate,
  isRemovalPlanExpired,
  removalBlockerRows,
  visualizeUntrustedText,
} from "./delete";

const plan = (overrides: Partial<AccountRemovalPlan> = {}): AccountRemovalPlan => ({
  planId: "plan-7",
  accountLabel: "Claude work",
  targetPath: "C:\\Users\\operator\\.prime\\profiles\\claude-work",
  deleteData: true,
  expiresAtMs: 60_000,
  registryGeneration: "generation",
  targetIdentity: { volume: 4, file: 7 },
  estimate: { items: 12, bytes: 34_000, truncated: false },
  checks: {
    activeSession: false,
    sharedProfile: false,
    defaultOrMigrated: false,
    storedPathMatches: true,
    directChild: true,
    reparsePoint: false,
    dataDeletionAllowed: true,
  },
  blockers: [],
  ...overrides,
});

describe("account deletion view model", () => {
  it("derives every visible blocker from the prepared plan, not the stored account path", () => {
    const rows = removalBlockerRows(
      plan({
        checks: {
          activeSession: true,
          sharedProfile: true,
          defaultOrMigrated: true,
          storedPathMatches: false,
          directChild: false,
          reparsePoint: true,
          dataDeletionAllowed: false,
        },
        blockers: [
          "activeSession",
          "sharedProfile",
          "defaultOrMigrated",
          "storedPathMismatch",
          "unsafeTarget",
          "reparsePoint",
        ],
      }),
    );

    expect(rows.map(({ key, blocked }) => [key, blocked])).toEqual([
      ["activeSession", true],
      ["sharedProfile", true],
      ["defaultOrMigrated", true],
      ["path", true],
      ["reparsePoint", true],
    ]);
    expect(rows.every((row) => !row.detail.includes("agentDir"))).toBe(true);
  });

  it("shows blocker codes even if an accompanying check flag is absent", () => {
    const rows = removalBlockerRows(
      plan({ blockers: ["activeSession", "sharedProfile", "defaultOrMigrated"] }),
    );

    expect(rows.slice(0, 3).map(({ blocked }) => blocked)).toEqual([true, true, true]);
  });

  it("explains that profile-data removal is Windows-only while entry-only remains available", () => {
    const rows = removalBlockerRows(
      plan({
        checks: {
          activeSession: false,
          sharedProfile: false,
          defaultOrMigrated: false,
          storedPathMatches: true,
          directChild: true,
          reparsePoint: false,
          dataDeletionAllowed: false,
        },
        blockers: ["unsupportedPlatform"],
      }),
    );

    const platform = rows.find((row) => row.key === "platform");
    expect(platform).toMatchObject({ blocked: true, label: "Operating system" });
    expect(platform?.detail).toMatch(/profile-data removal.*Windows/i);
    expect(platform?.detail).toMatch(/remove the account entry/i);
  });

  it("labels a bounded estimate honestly", () => {
    const estimate = formatRemovalEstimate({ items: 12, bytes: 34_000, truncated: false });
    expect(estimate.toLowerCase()).toContain("12 items");
    expect(estimate).toContain(" / ");
    expect(estimate).toMatch(/^[\x20-\x7e]+$/);
    expect(
      formatRemovalEstimate({ items: 10_000, bytes: 10_737_418_240, truncated: true }).toLowerCase(),
    ).toContain("at least");
  });

  it("expires at the exact backend deadline", () => {
    expect(isRemovalPlanExpired(plan(), 59_999)).toBe(false);
    expect(isRemovalPlanExpired(plan(), 60_000)).toBe(true);
  });

  it("keeps ordinary labels, emoji, and normal Windows paths readable", () => {
    expect(visualizeUntrustedText("Claude work 🚀")).toBe("Claude work 🚀");
    expect(visualizeUntrustedText("C:\\Users\\operator\\.prime\\profiles\\claude-work")).toBe(
      "C:\\Users\\operator\\.prime\\profiles\\claude-work",
    );
  });

  it("maps typed failures to actionable copy without reflecting hostile backend text", () => {
    const hostile = "token=secret C:\\outside\\victim";
    const message = deletionErrorMessage("targetChanged");

    expect(message).toMatch(/prepare again/i);
    expect(message).not.toContain(hostile);
    expect(deletionErrorMessage("outcomeUnknown")).toMatch(/restart/i);
    expect(deletionErrorMessage("cleanupPending")).toMatch(/cleanup/i);
  });
});

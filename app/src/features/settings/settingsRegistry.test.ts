import { describe, expect, it } from "vitest";

import { settingsSections, searchSettingsSections } from "./settingsRegistry";

describe("settings registry", () => {
  it("has unique routes and searchable labels and keywords", () => {
    expect(new Set(settingsSections.map((section) => section.id)).size).toBe(settingsSections.length);
    expect(searchSettingsSections("billing").map((section) => section.id)).toEqual(["usage"]);
    expect(searchSettingsSections("runtime identity").map((section) => section.id)).toEqual(["privacy"]);
    expect(searchSettingsSections("keyboard").map((section) => section.id)).toEqual(["shortcuts"]);
    expect(searchSettingsSections("restore conversations").map((section) => section.id)).toEqual(["archived"]);
  });

  it("keeps account usage settings-only and names unsupported surfaces truthfully", () => {
    const usage = settingsSections.find((section) => section.id === "usage");
    const harness = settingsSections.find((section) => section.id === "harness");
    expect(usage?.description.toLocaleLowerCase()).toContain("account-wide");
    expect(harness?.description).toContain("verified");
  });

  it("accounts for every destination in the supplied desktop prototype", () => {
    expect(settingsSections.map((section) => section.id)).toEqual([
      "general", "appearance", "composer", "archived", "harness", "usage", "models", "accounts",
      "tools", "git", "environments", "privacy", "shortcuts", "about",
    ]);
    expect(searchSettingsSections("repository source control").map((section) => section.id)).toEqual(["git"]);
    expect(searchSettingsSections("telemetry local-only").map((section) => section.id)).toEqual(["privacy"]);
  });
});

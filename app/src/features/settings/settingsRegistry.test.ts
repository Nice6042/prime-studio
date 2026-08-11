import { describe, expect, it } from "vitest";

import { settingsSections, searchSettingsSections } from "./settingsRegistry";

describe("settings registry", () => {
  it("has unique routes and searchable labels and keywords", () => {
    expect(new Set(settingsSections.map((section) => section.id)).size).toBe(settingsSections.length);
    expect(searchSettingsSections("billing").map((section) => section.id)).toEqual(["usage"]);
    expect(searchSettingsSections("runtime identity").map((section) => section.id)).toEqual(["security"]);
    expect(searchSettingsSections("keyboard").map((section) => section.id)).toEqual(["shortcuts"]);
  });

  it("keeps account usage settings-only and names unsupported surfaces truthfully", () => {
    const usage = settingsSections.find((section) => section.id === "usage");
    const harness = settingsSections.find((section) => section.id === "harness");
    expect(usage?.description).toContain("account-wide");
    expect(harness?.description).toContain("verified");
  });
});

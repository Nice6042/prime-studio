import { describe, expect, it } from "vitest";
import { isSection, SECTIONS } from "./settingsSections";

describe("settings section contract", () => {
  it("accepts only sections exposed by the settings navigation", () => {
    expect(SECTIONS.map((section) => section.id)).toContain("accounts");
    expect(isSection("appearance")).toBe(true);
    expect(isSection("not-a-section")).toBe(false);
    expect(isSection(null)).toBe(false);
  });
});

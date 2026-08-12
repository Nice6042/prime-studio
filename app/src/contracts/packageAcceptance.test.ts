import { describe, expect, it } from "vitest";

import { STUDIO_ACTIONS } from "./studioOperations";
import {
  DATA_REQUIREMENTS,
  FEATURE_ACCEPTANCE,
  PACKAGE_CONTROLS,
  PACKAGE_SCREENS,
  PACKAGE_SETTINGS,
  PACKAGE_STATES,
  RESPONSIVE_REQUIREMENTS,
  SHORTCUT_REQUIREMENTS,
  validatePackageAcceptance,
} from "./packageAcceptance";

describe("Prime Studio package acceptance catalog", () => {
  it("covers the literal feature ranges declared by the package contract", () => {
    expect(FEATURE_ACCEPTANCE).toHaveLength(115);
    expect(new Set(FEATURE_ACCEPTANCE.map((row) => row.id)).size).toBe(115);
    expect(FEATURE_ACCEPTANCE[0]?.id).toBe("SH-01");
    expect(FEATURE_ACCEPTANCE[FEATURE_ACCEPTANCE.length - 1]?.id).toBe("CM-06");
  });

  it("gives every interactive requirement at least one closed non-noop action", () => {
    for (const row of FEATURE_ACCEPTANCE.filter((candidate) => candidate.interactive)) {
      expect(row.actions.length, row.id).toBeGreaterThan(0);
      for (const action of row.actions) expect(STUDIO_ACTIONS[action], `${row.id}:${action}`).toBeDefined();
    }
  });

  it("uniquely maps every feature ID and package control ID", () => {
    expect(new Set(FEATURE_ACCEPTANCE.map((row) => row.id)).size).toBe(115);
    expect(PACKAGE_CONTROLS).toHaveLength(153);
    expect(new Set(PACKAGE_CONTROLS.map((control) => control.controlId)).size).toBe(PACKAGE_CONTROLS.length);
    expect(PACKAGE_CONTROLS.every((control) => FEATURE_ACCEPTANCE.some(
      (feature) => feature.id === control.featureId && feature.actions.includes(control.action),
    ))).toBe(true);
  });

  it("records the exact current implementation gap count", () => {
    const counts = FEATURE_ACCEPTANCE.reduce<Record<string, number>>((result, feature) => {
      result[feature.current] = (result[feature.current] ?? 0) + 1;
      return result;
    }, {});
    expect(counts).toEqual({ complete: 18, partial: 63, placeholder: 11, missing: 21, explicitly_unavailable: 2 });
  });

  it("records every package surface, state family, persisted setting, shortcut, responsive rule, and data authority", () => {
    expect(PACKAGE_SCREENS).toHaveLength(29);
    expect(PACKAGE_STATES).toHaveLength(58);
    expect(PACKAGE_SETTINGS).toHaveLength(30);
    expect(SHORTCUT_REQUIREMENTS).toHaveLength(7);
    expect(RESPONSIVE_REQUIREMENTS).toHaveLength(13);
    expect(DATA_REQUIREMENTS).toHaveLength(26);
    expect(validatePackageAcceptance()).toEqual({ valid: true, featureCount: 115 });
  });

  it("keeps account usage and current-chat usage as different authorities", () => {
    const current = DATA_REQUIREMENTS.find((requirement) => requirement.id === "data.current-chat-usage");
    const account = DATA_REQUIREMENTS.find((requirement) => requirement.id === "data.account-usage");
    expect(current?.scope).toBe("root_session");
    expect(account?.scope).toBe("account_ledger");
    expect(current?.source).not.toBe(account?.source);
  });
});

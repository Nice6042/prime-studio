import { describe, expect, it } from "vitest";

import { STUDIO_ACTIONS } from "./studioOperations";
import {
  DATA_REQUIREMENTS,
  FEATURE_ACCEPTANCE,
  PACKAGE_IMPLEMENTATION_SUMMARY,
  PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS,
  PACKAGE_CONTROLS,
  PACKAGE_SCREENS,
  PACKAGE_SETTINGS,
  PACKAGE_STATES,
  RESPONSIVE_REQUIREMENTS,
  SHORTCUT_REQUIREMENTS,
  isPackageReleaseReady,
  summarizePackageImplementation,
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
    expect(PACKAGE_CONTROLS).toHaveLength(154);
    expect(new Set(PACKAGE_CONTROLS.map((control) => control.controlId)).size).toBe(PACKAGE_CONTROLS.length);
    expect(PACKAGE_CONTROLS.every((control) => FEATURE_ACCEPTANCE.some(
      (feature) => feature.id === control.featureId && feature.actions.includes(control.action),
    ))).toBe(true);
  });

  it("derives the current implementation summary from the audited feature rows", () => {
    expect(PACKAGE_IMPLEMENTATION_SUMMARY).toEqual(summarizePackageImplementation(FEATURE_ACCEPTANCE));
    expect(PACKAGE_IMPLEMENTATION_SUMMARY).toEqual({
      complete: 63,
      partial: 50,
      placeholder: 0,
      missing: 0,
      explicitly_unavailable: 2,
    });
  });

  it("records merged production adapter, resident lifecycle, and artifact evidence truthfully", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(["SH-01", "NV-01", "NV-03", "NV-05", "NV-10", "CV-09", "AU-02", "PL-02", "PL-03"]
      .map(status)).toEqual(Array(9).fill("complete"));
    expect(["CV-07", "AC-04", "ED-04", "SH-04"]
      .map(status)).toEqual(Array(4).fill("complete"));
    expect(["CV-05", "CP-03", "HR-07", "HR-16", "ED-01"]
      .map(status)).toEqual(Array(5).fill("partial"));
    expect(status("CP-01")).toBe("complete");
    expect(status("CV-15")).toBe("partial");
  });

  it("keeps the current development snapshot outside the release-ready state", () => {
    expect(isPackageReleaseReady()).toBe(false);
    const complete = FEATURE_ACCEPTANCE[0]!;
    for (const current of ["partial", "placeholder", "missing"] as const) {
      expect(isPackageReleaseReady([{ ...complete, current }])).toBe(false);
    }
    expect(isPackageReleaseReady([
      { ...complete, current: "complete" },
      { ...complete, id: "EX-01", current: "explicitly_unavailable" },
    ])).toBe(true);
  });

  it("keeps every remaining production bridge re-audit row nonterminal", () => {
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS.length).toBeGreaterThan(0);
    expect(new Set(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).size).toBe(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS.length);
    for (const id of PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS) {
      const feature = FEATURE_ACCEPTANCE.find((candidate) => candidate.id === id);
      expect(feature, id).toBeDefined();
      expect(feature?.current, id).not.toBe("complete");
    }
  });

  it("records production worker recovery and turn-usage evidence as complete", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(status("HR-11")).toBe("complete");
    expect(status("CU-04")).toBe("complete");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("HR-11");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("CU-04");
  });

  it("records the reviewed workspace footer, parent paging, and truthful child paging limit", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(status("NV-08")).toBe("complete");
    expect(status("CV-14")).toBe("complete");
    expect(status("HR-14")).toBe("partial");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("CV-14");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).toContain("HR-14");
  });

  it("records authoritative chat lifecycle and verified extension prompts as complete", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(status("NV-07")).toBe("complete");
    expect(status("HR-18")).toBe("complete");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("NV-07");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("HR-18");
  });

  it("records the reviewed composer growth, locked child composer, and collapsed rail as complete", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(status("CP-01")).toBe("complete");
    expect(status("HR-15")).toBe("complete");
    expect(status("NV-09")).toBe("complete");
  });

  it("records reviewed project expansion, runtime identity, and editor modes while keeping the toast queue nonterminal", () => {
    const status = (id: string) => FEATURE_ACCEPTANCE.find((feature) => feature.id === id)?.current;

    expect(status("NV-04")).toBe("complete");
    expect(status("SH-08")).toBe("complete");
    expect(status("ED-02")).toBe("complete");
    expect(status("CM-02")).toBe("partial");
    expect(PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS).not.toContain("ED-02");
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

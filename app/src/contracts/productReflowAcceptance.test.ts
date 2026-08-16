import { describe, expect, it } from "vitest";

import { PACKAGE_SCREENS } from "./packageAcceptance";
import {
  PRODUCT_REFLOW_ALL_GEOMETRY_IDS,
  PRODUCT_REFLOW_GEOMETRIES,
  PRODUCT_REFLOW_SCENARIOS,
  validateProductReflowAcceptance,
} from "./productReflowAcceptance";

describe("Prime Studio product reflow evidence matrix", () => {
  it("covers every applicable package-screen and geometry cell", () => {
    const validation = validateProductReflowAcceptance();

    expect(validation).toEqual({
      valid: true,
      packageScreenCount: 29,
      coveredScreenCount: 29,
      geometryCount: 5,
      evidenceCellCount: 140,
      errors: [],
    });
    expect(new Set(PRODUCT_REFLOW_SCENARIOS.flatMap((scenario) => scenario.screenIds)))
      .toEqual(new Set(PACKAGE_SCREENS.map((screen) => screen.id)));
  });

  it("pins the required desktop, compact, and 200-percent-equivalent geometry", () => {
    expect(PRODUCT_REFLOW_GEOMETRIES.map(({ id, width, height, evidence }) => ({ id, width, height, evidence }))).toEqual([
      { id: "desktop-1280", width: 1280, height: 800, evidence: "browser_shell_css_viewport" },
      { id: "desktop-1600", width: 1600, height: 900, evidence: "browser_shell_css_viewport" },
      { id: "compact-820", width: 820, height: 640, evidence: "browser_shell_css_viewport" },
      { id: "compact-640", width: 640, height: 400, evidence: "browser_shell_css_viewport" },
      { id: "zoom-200-equivalent", width: 320, height: 200, evidence: "browser_shell_200_percent_equivalent" },
    ]);
    expect(PRODUCT_REFLOW_GEOMETRIES.find((geometry) => geometry.id === "zoom-200-equivalent")?.description)
      .toContain("not Windows/WebView2 host-zoom attestation");
  });

  it("runs every non-shell-variant screen at every required geometry", () => {
    for (const scenarioId of ["settings-all", "overlays-all"] as const) {
      expect(PRODUCT_REFLOW_SCENARIOS.find((scenario) => scenario.id === scenarioId)?.geometryIds)
        .toEqual(PRODUCT_REFLOW_ALL_GEOMETRY_IDS);
    }
    const wide = PRODUCT_REFLOW_SCENARIOS.find((scenario) => scenario.id === "workspace-wide")!;
    const compact = PRODUCT_REFLOW_SCENARIOS.find((scenario) => scenario.id === "workspace-compact")!;
    for (const screenId of wide.screenIds.filter((id) => id !== "workspace.sidebar-expanded")) {
      expect(compact.screenIds).toContain(screenId);
    }
  });

  it("fails closed for missing, repeated, unknown, and inapplicable evidence", () => {
    const screen = PACKAGE_SCREENS[0]!;
    const geometry = PRODUCT_REFLOW_GEOMETRIES[0]!;
    const scenario = PRODUCT_REFLOW_SCENARIOS[0]!;

    expect(validateProductReflowAcceptance([screen], [geometry], []).errors)
      .toContain(`Package screen ${screen.id} is missing reflow evidence at ${geometry.id}.`);
    expect(validateProductReflowAcceptance([screen, screen], [geometry], [{ ...scenario, geometryIds: [geometry.id], screenIds: [screen.id] }]).errors)
      .toContain("Package screen IDs are not unique.");
    expect(validateProductReflowAcceptance([screen], [geometry], [{ ...scenario, geometryIds: [geometry.id], screenIds: [screen.id, screen.id] }]).errors)
      .toContain("Reflow scenario workspace-wide repeats a package screen.");
    expect(validateProductReflowAcceptance([screen], [geometry], [{ ...scenario, geometryIds: [geometry.id, geometry.id], screenIds: [screen.id] }]).errors)
      .toContain("Reflow scenario workspace-wide repeats a geometry.");
      const duplicateCellScenario = { ...scenario, id: "workspace-compact" as const, geometryIds: [geometry.id], screenIds: [screen.id] };
      expect(validateProductReflowAcceptance(
        [screen],
        [geometry],
        [
          { ...scenario, geometryIds: [geometry.id], screenIds: [screen.id] },
          duplicateCellScenario,
        ],
      ).errors).toContain(
        `Reflow evidence cell ${screen.id} at ${geometry.id} is assigned to both workspace-wide and workspace-compact.`,
      );
    expect(validateProductReflowAcceptance([screen], [geometry], [{ ...scenario, geometryIds: ["desktop-1600"], screenIds: [screen.id] }]).errors)
      .toContain("Reflow scenario workspace-wide references unknown geometry desktop-1600.");
    expect(validateProductReflowAcceptance([screen], [geometry], [{ ...scenario, geometryIds: [geometry.id], screenIds: ["unknown.screen"] }]).errors)
      .toContain("Reflow scenario references unknown package screen unknown.screen.");
    const compact = PRODUCT_REFLOW_GEOMETRIES.find((candidate) => candidate.id === "compact-820")!;
    expect(validateProductReflowAcceptance([screen], [compact], [{ ...scenario, geometryIds: [compact.id], screenIds: [screen.id] }]).errors)
      .toContain(`Package screen ${screen.id} has inapplicable reflow evidence at ${compact.id}.`);
  });
});

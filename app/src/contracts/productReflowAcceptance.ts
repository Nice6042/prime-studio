import { PACKAGE_SCREENS, type PackageScreen } from "./packageAcceptance";

export type ProductReflowGeometryId =
  | "desktop-1280"
  | "desktop-1600"
  | "compact-820"
  | "compact-640"
  | "zoom-200-equivalent";

export type ProductReflowScenarioId =
  | "workspace-wide"
  | "workspace-compact"
  | "settings-all"
  | "overlays-all";

export interface ProductReflowGeometry {
  readonly id: ProductReflowGeometryId;
  readonly width: number;
  readonly height: number;
  readonly evidence: "browser_shell_css_viewport" | "browser_shell_200_percent_equivalent";
  readonly description: string;
}

export interface ProductReflowScenario {
  readonly id: ProductReflowScenarioId;
  readonly geometryIds: readonly ProductReflowGeometryId[];
  readonly screenIds: readonly string[];
}

const freezeGeometryIds = (...ids: ProductReflowGeometryId[]): readonly ProductReflowGeometryId[] => Object.freeze(ids);
const freezeScreenIds = (...ids: string[]): readonly string[] => Object.freeze(ids);
const freezeScenario = (
  id: ProductReflowScenarioId,
  geometryIds: readonly ProductReflowGeometryId[],
  screenIds: readonly string[],
): ProductReflowScenario => Object.freeze({ id, geometryIds, screenIds });

export const PRODUCT_REFLOW_GEOMETRIES: readonly ProductReflowGeometry[] = Object.freeze([
  Object.freeze({
    id: "desktop-1280",
    width: 1280,
    height: 800,
    evidence: "browser_shell_css_viewport",
    description: "Required 1280px desktop layout.",
  }),
  Object.freeze({
    id: "desktop-1600",
    width: 1600,
    height: 900,
    evidence: "browser_shell_css_viewport",
    description: "Required 1600px desktop layout.",
  }),
  Object.freeze({
    id: "compact-820",
    width: 820,
    height: 640,
    evidence: "browser_shell_css_viewport",
    description: "Required 820px compact layout.",
  }),
  Object.freeze({
    id: "compact-640",
    width: 640,
    height: 400,
    evidence: "browser_shell_css_viewport",
    description: "Required 640 by 400 compact layout.",
  }),
  Object.freeze({
    id: "zoom-200-equivalent",
    width: 320,
    height: 200,
    evidence: "browser_shell_200_percent_equivalent",
    description: "CSS-viewport equivalent of a 640 by 400 physical screen at 200 percent scaling; this is not Windows/WebView2 host-zoom attestation.",
  }),
]);

export const PRODUCT_REFLOW_WIDE_GEOMETRY_IDS = freezeGeometryIds("desktop-1280", "desktop-1600");
export const PRODUCT_REFLOW_COMPACT_GEOMETRY_IDS = freezeGeometryIds("compact-820", "compact-640", "zoom-200-equivalent");
export const PRODUCT_REFLOW_ALL_GEOMETRY_IDS = freezeGeometryIds(...PRODUCT_REFLOW_GEOMETRIES.map((geometry) => geometry.id));

const SETTINGS_SCREENS = freezeScreenIds(
  "settings.general",
  "settings.appearance",
  "settings.composer",
  "settings.harness",
  "settings.usage",
  "settings.models",
  "settings.accounts",
  "settings.tools",
  "settings.git",
  "settings.environments",
  "settings.privacy",
  "settings.shortcuts",
  "settings.about",
);

const WORKSPACE_COMMON_SCREENS = freezeScreenIds(
  "workspace.conversation-empty",
  "workspace.conversation-active",
  "workspace.conversation-streaming",
  "inspector.overview",
  "inspector.current-chat-usage",
  "inspector.activity",
  "inspector.child-chat",
  "inspector.child-activity",
  "inspector.child-files",
  "editor.diff",
  "editor.edit",
  "editor.canvas",
);

export const PRODUCT_REFLOW_SCENARIOS: readonly ProductReflowScenario[] = Object.freeze([
  freezeScenario(
    "workspace-wide",
    PRODUCT_REFLOW_WIDE_GEOMETRY_IDS,
    freezeScreenIds("workspace.sidebar-expanded", ...WORKSPACE_COMMON_SCREENS),
  ),
  freezeScenario(
    "workspace-compact",
    PRODUCT_REFLOW_COMPACT_GEOMETRY_IDS,
    freezeScreenIds("workspace.sidebar-rail", ...WORKSPACE_COMMON_SCREENS),
  ),
  freezeScenario("settings-all", PRODUCT_REFLOW_ALL_GEOMETRY_IDS, SETTINGS_SCREENS),
  freezeScenario(
    "overlays-all",
    PRODUCT_REFLOW_ALL_GEOMETRY_IDS,
    freezeScreenIds(
      "overlay.command-palette",
      "overlay.menus-popovers-toasts",
    ),
  ),
]);

export interface ProductReflowValidation {
  readonly valid: boolean;
  readonly packageScreenCount: number;
  readonly coveredScreenCount: number;
  readonly geometryCount: number;
  readonly evidenceCellCount: number;
  readonly errors: readonly string[];
}

function expectedGeometryIds(screenId: string): readonly ProductReflowGeometryId[] {
  if (screenId === "workspace.sidebar-expanded") return PRODUCT_REFLOW_WIDE_GEOMETRY_IDS;
  if (screenId === "workspace.sidebar-rail") return PRODUCT_REFLOW_COMPACT_GEOMETRY_IDS;
  return PRODUCT_REFLOW_ALL_GEOMETRY_IDS;
}

function sameIdSet(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every((id) => left.has(id));
}

export function validateProductReflowAcceptance(
  packageScreens: readonly PackageScreen[] = PACKAGE_SCREENS,
  geometries: readonly ProductReflowGeometry[] = PRODUCT_REFLOW_GEOMETRIES,
  scenarios: readonly ProductReflowScenario[] = PRODUCT_REFLOW_SCENARIOS,
): ProductReflowValidation {
  const errors: string[] = [];
  const packageIds = packageScreens.map((screen) => screen.id);
  const packageSet = new Set(packageIds);
  const geometryIds = geometries.map((geometry) => geometry.id);
  const geometrySet = new Set(geometryIds);
  const scenarioIds = scenarios.map((scenario) => scenario.id);
  const evidence = new Map<string, Set<ProductReflowGeometryId>>();
  const cellOwners = new Map<string, ProductReflowScenarioId>();

  if (packageSet.size !== packageIds.length) errors.push("Package screen IDs are not unique.");
  if (geometrySet.size !== geometryIds.length) errors.push("Reflow geometry IDs are not unique.");
  if (new Set(scenarioIds).size !== scenarioIds.length) errors.push("Reflow scenario IDs are not unique.");

  for (const scenario of scenarios) {
    if (scenario.geometryIds.length === 0) errors.push(`Reflow scenario ${scenario.id} has no geometry.`);
    if (scenario.screenIds.length === 0) errors.push(`Reflow scenario ${scenario.id} has no package screen.`);
    if (new Set(scenario.geometryIds).size !== scenario.geometryIds.length) errors.push(`Reflow scenario ${scenario.id} repeats a geometry.`);
    if (new Set(scenario.screenIds).size !== scenario.screenIds.length) errors.push(`Reflow scenario ${scenario.id} repeats a package screen.`);
    for (const geometryId of scenario.geometryIds) {
      if (!geometrySet.has(geometryId)) errors.push(`Reflow scenario ${scenario.id} references unknown geometry ${geometryId}.`);
    }
    for (const screenId of new Set(scenario.screenIds)) {
      if (!packageSet.has(screenId)) {
        errors.push(`Reflow scenario references unknown package screen ${screenId}.`);
        continue;
      }
      const cells = evidence.get(screenId) ?? new Set<ProductReflowGeometryId>();
      for (const geometryId of new Set(scenario.geometryIds)) {
        if (!geometrySet.has(geometryId)) continue;
        const cellKey = JSON.stringify([screenId, geometryId]);
        const owner = cellOwners.get(cellKey);
        if (owner && owner !== scenario.id) {
          errors.push(`Reflow evidence cell ${screenId} at ${geometryId} is assigned to both ${owner} and ${scenario.id}.`);
        } else {
          cellOwners.set(cellKey, scenario.id);
        }
        cells.add(geometryId);
      }
      evidence.set(screenId, cells);
    }
  }

  for (const screenId of packageSet) {
    const actual = evidence.get(screenId) ?? new Set<ProductReflowGeometryId>();
    const expected = expectedGeometryIds(screenId).filter((geometryId) => geometrySet.has(geometryId));
    if (!sameIdSet(actual, expected)) {
      const missing = expected.filter((geometryId) => !actual.has(geometryId));
      const unexpected = [...actual].filter((geometryId) => !expected.includes(geometryId));
      if (missing.length > 0) errors.push(`Package screen ${screenId} is missing reflow evidence at ${missing.join(", ")}.`);
      if (unexpected.length > 0) errors.push(`Package screen ${screenId} has inapplicable reflow evidence at ${unexpected.join(", ")}.`);
    }
  }
  for (const geometryId of geometrySet) {
    if (!scenarios.some((scenario) => scenario.geometryIds.includes(geometryId))) {
      errors.push(`Reflow geometry ${geometryId} has no executable scenario.`);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    packageScreenCount: packageSet.size,
    coveredScreenCount: [...evidence].filter(([screenId, cells]) => packageSet.has(screenId) && cells.size > 0).length,
    geometryCount: geometrySet.size,
    evidenceCellCount: [...evidence].filter(([screenId]) => packageSet.has(screenId)).reduce((total, [, cells]) => total + cells.size, 0),
    errors: Object.freeze(errors),
  });
}

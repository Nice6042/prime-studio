import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REQUIRED_UPGRADE_CODE = "876b9e7d-e060-59f1-acc2-629b8f60957a";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be provided as --name value pairs");
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function hasValue(object, key) {
  return object != null && object[key] !== undefined && object[key] !== null;
}

function validateConfig(config, packageJson, cargoToml) {
  const bundle = config.bundle;
  const windows = bundle?.windows;
  if (bundle?.active !== true) throw new Error("bundle.active must be true");

  const targets = Array.isArray(bundle.targets) ? [...bundle.targets].sort() : [];
  if (targets.length !== 2 || targets[0] !== "msi" || targets[1] !== "nsis") {
    throw new Error("bundle.targets must contain exactly msi and nsis");
  }
  if (bundle.createUpdaterArtifacts !== false) {
    throw new Error("bundle.createUpdaterArtifacts must be explicitly false");
  }
  if (windows?.allowDowngrades !== false) {
    throw new Error("bundle.windows.allowDowngrades must be explicitly false");
  }
  const webview = windows?.webviewInstallMode;
  if (
    webview?.type !== "downloadBootstrapper"
    || webview?.silent !== true
    || Object.keys(webview).length !== 2
  ) {
    throw new Error("bundle.windows.webviewInstallMode must be the explicit silent downloadBootstrapper policy");
  }
  if (windows?.nsis?.installMode !== "currentUser") {
    throw new Error("bundle.windows.nsis.installMode must be currentUser");
  }
  if (windows?.wix?.upgradeCode !== REQUIRED_UPGRADE_CODE) {
    throw new Error(`bundle.windows.wix.upgradeCode must remain ${REQUIRED_UPGRADE_CODE}`);
  }
  if (windows?.wix?.enableElevatedUpdateTask !== false) {
    throw new Error("bundle.windows.wix.enableElevatedUpdateTask must be explicitly false");
  }

  const hasCustomInstallerCode = [
    hasValue(windows.nsis, "template"),
    hasValue(windows.nsis, "installerHooks"),
    hasValue(windows.wix, "template"),
    (windows.wix.fragmentPaths?.length ?? 0) > 0,
    (windows.wix.componentGroupRefs?.length ?? 0) > 0,
    (windows.wix.componentRefs?.length ?? 0) > 0,
    (windows.wix.featureGroupRefs?.length ?? 0) > 0,
    (windows.wix.featureRefs?.length ?? 0) > 0,
    (windows.wix.mergeRefs?.length ?? 0) > 0,
  ].some(Boolean);
  if (hasCustomInstallerCode) {
    throw new Error("custom installer templates, hooks, and fragments are forbidden by the audited uninstall policy");
  }

  for (const key of ["certificateThumbprint", "digestAlgorithm", "timestampUrl", "signCommand"]) {
    if (hasValue(windows, key)) {
      throw new Error("Windows signing configuration must remain absent from unsigned candidate builds");
    }
  }

  const npmDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
  const hasNpmUpdater = Object.entries(npmDependencies).some(([name, specifier]) => (
    name === "@tauri-apps/plugin-updater"
    || (typeof specifier === "string" && specifier.startsWith("npm:@tauri-apps/plugin-updater@"))
  ));
  if (hasNpmUpdater) {
    throw new Error("runtime updater dependency @tauri-apps/plugin-updater is forbidden while updates are disabled");
  }
  const uncommentedCargoToml = cargoToml
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
  if (/tauri-plugin-updater/u.test(uncommentedCargoToml)) {
    throw new Error("runtime updater dependency tauri-plugin-updater is forbidden while updates are disabled");
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.get("config") ?? "src-tauri/tauri.conf.json");
  const packagePath = resolve(args.get("package") ?? "package.json");
  const cargoPath = resolve(args.get("cargo") ?? "src-tauri/Cargo.toml");
  for (const name of ["tauri.windows.conf.json", "tauri.windows.conf.json5", "tauri.windows.conf.toml"]) {
    if (existsSync(join(dirname(configPath), name))) {
      throw new Error("platform-specific Tauri configuration overrides are forbidden by the audited Windows policy");
    }
  }
  validateConfig(
    readJson(configPath, "Tauri config"),
    readJson(packagePath, "package manifest"),
    readFileSync(cargoPath, "utf8"),
  );
  process.stdout.write("Windows installer policy verified.\n");
} catch (error) {
  process.stderr.write(`Windows installer policy rejected: ${error.message}\n`);
  process.exitCode = 1;
}

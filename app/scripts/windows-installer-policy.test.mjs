import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const verifier = resolve(import.meta.dirname, "verify-windows-installer-policy.mjs");
const inventoryScript = resolve(import.meta.dirname, "inspect-windows-candidate.ps1");
const appRoot = resolve(import.meta.dirname, "..");
const windowsTest = process.platform === "win32" ? test : test.skip;

function validConfig() {
  return {
    productName: "Example Product",
    version: "1.2.3",
    identifier: "example.invalid.product",
    bundle: {
      active: true,
      targets: ["msi", "nsis"],
      createUpdaterArtifacts: false,
      windows: {
        allowDowngrades: false,
        webviewInstallMode: {
          type: "downloadBootstrapper",
          silent: true,
        },
        wix: {
          upgradeCode: "876b9e7d-e060-59f1-acc2-629b8f60957a",
          enableElevatedUpdateTask: false,
        },
        nsis: {
          installMode: "currentUser",
        },
      },
    },
  };
}

function runVerifier(config, {
  packageJson = {},
  cargoToml = "[dependencies]\n",
  windowsOverride,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "prime-studio-windows-policy-"));
  const configPath = join(root, "tauri.conf.json");
  const packagePath = join(root, "package.json");
  const cargoPath = join(root, "Cargo.toml");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(cargoPath, cargoToml);
  if (windowsOverride !== undefined) {
    writeFileSync(join(root, "tauri.windows.conf.json"), `${JSON.stringify(windowsOverride, null, 2)}\n`);
  }

  try {
    return spawnSync(
      process.execPath,
      [verifier, "--config", configPath, "--package", packagePath, "--cargo", cargoPath],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runInventoryFixture({ includeFakeBinary = false, wixSilent = true } = {}) {
  const releaseRoot = mkdtempSync(join(tmpdir(), "prime-studio-installer-manifests-"));
  const bundleRoot = join(releaseRoot, "bundle");
  for (const directory of ["bundle/msi", "bundle/nsis", "nsis/x64", "wix/x64"]) {
    mkdirSync(join(releaseRoot, directory), { recursive: true });
  }
  writeFileSync(join(bundleRoot, "msi", "Example_1.0.0_x64_en-US.msi"), "not-an-msi");
  writeFileSync(join(bundleRoot, "nsis", "Example_1.0.0_x64-setup.exe"), "not-an-exe");

  const fakeNsisPayload = includeFakeBinary
    ? 'File /a "/oname=fake-prime-jsonl.exe" "C:\\build\\fake-prime-jsonl.exe"'
    : "";
  writeFileSync(join(releaseRoot, "nsis", "x64", "installer.nsi"), `
!define INSTALLMODE "currentUser"
!define ALLOWDOWNGRADES "false"
!define INSTALLWEBVIEW2MODE "downloadBootstrapper"
!define WEBVIEW2INSTALLERARGS "/silent"
; Copy external binaries
${fakeNsisPayload}
; Create file associations
`);

  const fakeWixPayload = includeFakeBinary
    ? '<File Id="Bin_fake_prime_jsonl" Source="C:\\build\\fake-prime-jsonl.exe" />'
    : "";
  const silentArguments = wixSilent ? "&apos;/silent&apos;, &apos;/install&apos;" : "&apos;/install&apos;";
  writeFileSync(join(releaseRoot, "wix", "x64", "main.wxs"), `
<Package UpgradeCode="876b9e7d-e060-59f1-acc2-629b8f60957a" InstallScope="perMachine">
  <MajorUpgrade DowngradeErrorMessage="A newer version is installed" />
  <CustomAction Id='DownloadAndInvokeBootstrapper' ExeCommand='Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703"; ${silentArguments}' />
  ${fakeWixPayload}
</Package>
`);

  try {
    return spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", inventoryScript, "-BundleRoot", bundleRoot],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true });
  }
}

test("accepts the complete fail-closed Windows installer policy", () => {
  const result = runVerifier(validConfig());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Windows installer policy verified/);
});

test("the tracked manifests satisfy the Windows installer policy", () => {
  const result = spawnSync(process.execPath, [verifier], { cwd: appRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

const configMutations = [
  ["implicit installer targets", (config) => { config.bundle.targets = "all"; }, /targets must contain exactly msi and nsis/],
  ["updater artifact generation", (config) => { delete config.bundle.createUpdaterArtifacts; }, /createUpdaterArtifacts must be explicitly false/],
  ["downgrades", (config) => { config.bundle.windows.allowDowngrades = true; }, /allowDowngrades must be explicitly false/],
  ["an implicit WebView2 policy", (config) => { delete config.bundle.windows.webviewInstallMode; }, /webviewInstallMode must be the explicit silent downloadBootstrapper policy/],
  ["an interactive WebView2 bootstrapper", (config) => { config.bundle.windows.webviewInstallMode.silent = false; }, /webviewInstallMode must be the explicit silent downloadBootstrapper policy/],
  ["an elevated NSIS install", (config) => { config.bundle.windows.nsis.installMode = "perMachine"; }, /nsis.installMode must be currentUser/],
  ["a changed MSI upgrade lineage", (config) => { config.bundle.windows.wix.upgradeCode = "00000000-0000-0000-0000-000000000000"; }, /wix.upgradeCode must remain/],
  ["an elevated updater task", (config) => { config.bundle.windows.wix.enableElevatedUpdateTask = true; }, /enableElevatedUpdateTask must be explicitly false/],
  ["a custom NSIS uninstall hook", (config) => { config.bundle.windows.nsis.installerHooks = "installer-hooks.nsh"; }, /custom installer templates, hooks, and fragments are forbidden/],
  ["a custom WiX template", (config) => { config.bundle.windows.wix.template = "main.wxs"; }, /custom installer templates, hooks, and fragments are forbidden/],
  ["a signing command", (config) => { config.bundle.windows.signCommand = "sign %1"; }, /signing configuration must remain absent/],
];

for (const [label, mutate, expectedError] of configMutations) {
  test(`rejects ${label}`, () => {
    const config = validConfig();
    mutate(config);
    const result = runVerifier(config);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  });
}

test("accepts installer targets in either JSON array order", () => {
  const config = validConfig();
  config.bundle.targets = ["nsis", "msi"];
  const result = runVerifier(config);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects npm and Cargo runtime updater dependencies", () => {
  const npmResult = runVerifier(validConfig(), {
    packageJson: { dependencies: { "@tauri-apps/plugin-updater": "2.0.0" } },
  });
  assert.notEqual(npmResult.status, 0);
  assert.match(npmResult.stderr, /runtime updater dependency @tauri-apps\/plugin-updater is forbidden/);

  const cargoResult = runVerifier(validConfig(), {
    cargoToml: '[dependencies]\ntauri-plugin-updater = "2"\n',
  });
  assert.notEqual(cargoResult.status, 0);
  assert.match(cargoResult.stderr, /runtime updater dependency tauri-plugin-updater is forbidden/);
});

test("rejects aliased and table-form runtime updater dependencies", () => {
  const npmAlias = runVerifier(validConfig(), {
    packageJson: { dependencies: { updates: "npm:@tauri-apps/plugin-updater@2" } },
  });
  assert.notEqual(npmAlias.status, 0);
  assert.match(npmAlias.stderr, /runtime updater dependency @tauri-apps\/plugin-updater is forbidden/);

  for (const cargoToml of [
    '[dependencies.tauri-plugin-updater]\nversion = "2"\n',
    '[dependencies]\nupdates = { package = "tauri-plugin-updater", version = "2" }\n',
    '[dependencies.updates]\npackage = "tauri-plugin-updater"\nversion = "2"\n',
  ]) {
    const result = runVerifier(validConfig(), { cargoToml });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime updater dependency tauri-plugin-updater is forbidden/);
  }
});

test("rejects unaudited platform configuration overrides", () => {
  const result = runVerifier(validConfig(), {
    windowsOverride: { bundle: { windows: { allowDowngrades: true } } },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /platform-specific Tauri configuration overrides are forbidden/);
});

windowsTest("candidate inventory refuses an incomplete installer bundle", () => {
  const bundleRoot = mkdtempSync(join(tmpdir(), "prime-studio-empty-bundle-"));
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", inventoryScript, "-BundleRoot", bundleRoot],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /requires exactly one MSI and one NSIS executable/);
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}, 30_000);

windowsTest("candidate inventory rejects test-support executables in installer manifests", () => {
  const result = runInventoryFixture({ includeFakeBinary: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /installer payload contains an unapproved executable/);
});

windowsTest("candidate inventory rejects an interactive MSI WebView2 bootstrapper", () => {
  const result = runInventoryFixture({ wixSilent: false });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /MSI WebView2 bootstrapper is not silent/);
});

# Windows installer policy

This policy governs local Windows packaging checks. It does not authorize a binary
release. Every MSI and NSIS executable produced by the current repository is an
**unsigned development candidate — do not publish** until the signing, provenance,
VM test, and public-source gates in [Releasing](../RELEASING.md) are complete.

## Installer matrix

| Format | Install scope | Elevation | Default location and registry | Status |
|---|---|---|---|---|
| NSIS `.exe` | Current user | No elevation | User-local application directory; uninstall metadata under HKCU | Unsigned development candidate only |
| WiX `.msi` | Per machine | Administrator approval required | Program Files; uninstall metadata under HKLM (`ALLUSERS=1`) | Unsigned development candidate only |

The scope difference is intentional and must be stated in any future download page
or release notes. The stock Tauri WiX template has no supported per-user switch. Do
not add an unsupported `wix.installMode` key or silently replace the audited template.
Cross-format migration and uninstall behavior remain mandatory VM tests before either
format can become a supported release.

## Enforced configuration

- `bundle.targets` contains only `msi` and `nsis`.
- `bundle.createUpdaterArtifacts` is explicitly `false`; runtime updater dependencies
  are absent. There is no update channel or background updater.
- `bundle.windows.allowDowngrades` is explicitly `false` for both formats.
- NSIS uses `installMode: "currentUser"`.
- WiX retains UpgradeCode `876b9e7d-e060-59f1-acc2-629b8f60957a`. This is the value
  derived by the pinned Tauri CLI for the existing product name and observed in the
  prior local MSI lineage. Changing it can create duplicate Windows installations.
- WiX's elevated update task is explicitly disabled.
- No custom WiX/NSIS template, fragment, or installer hook is allowed. Such code
  could change privilege or deletion behavior outside this reviewed policy.
- WebView2 uses the silent download bootstrapper. This keeps installers small, but a
  machine without WebView2 needs network access during installation. A blocked or
  failed download blocks the installation; it must not bypass WebView2 checks.
- Signing configuration is absent. `--no-sign` is required for local candidate builds.
- The `fake-prime-jsonl` integration-test executable requires the non-default
  `test-support-bin` Cargo feature. Test and lint commands enable it explicitly;
  production Tauri builds do not, and the payload inventory rejects any extra
  executable if this boundary regresses.

## Uninstall and retained data

The installers remove installed program files, shortcuts, and their installer
registration. They must never remove the shared Prime data under the user's `.prime`
directory. They also leave Prime Studio's application settings and account registry
under `%APPDATA%\prime-studio` in place.

The stock NSIS uninstaller offers a separate, initially unchecked “delete app data”
choice for identifier-scoped `%APPDATA%\dev.primestudio.app` and
`%LOCALAPPDATA%\dev.primestudio.app` state. Selecting it can remove embedded-webview
state only; it does not include `%APPDATA%\prime-studio` or `.prime`. The stock MSI
does not expose that NSIS choice. A future “remove all user data” feature requires a
separate design and must never infer that shared `.prime` belongs only to this app.

## Local verification

From `app`:

```powershell
node scripts/verify-windows-installer-policy.mjs
npm exec tauri inspect wix-upgrade-code
npm exec tauri build --ci --bundles msi,nsis --no-sign
powershell -NoProfile -NonInteractive -File scripts/inspect-windows-candidate.ps1 `
  -BundleRoot src-tauri/target/release/bundle
```

The final command validates generated NSIS/WiX manifests, reads MSI properties,
checks SHA-256 hashes and Authenticode status, rejects updater payloads, and copies
only renamed `*-UNSIGNED-CANDIDATE.*` files into
`src-tauri/target/release/windows-unsigned-candidate`. The adjacent inventory contains
no absolute build paths. Raw Tauri bundle output is never a distribution directory.

Before a signed release, test both formats in clean Windows VMs as a standard user and
administrator: clean install, WebView2 present and absent, blocked network, silent and
interactive downgrade attempts, same-version reinstall, newer-version upgrade,
cross-format migration, uninstall with each NSIS data choice, and verification that
`.prime` plus `%APPDATA%\prime-studio` remain unchanged.

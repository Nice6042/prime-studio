# Testing

Prime Studio uses Vitest for frontend tests, Node's test runner for repository policy
checks, Playwright with axe-core for the mocked browser shell, and Cargo for the Rust
backend. Run commands from the locations shown below.

## Prerequisites

- Windows 11;
- Node.js 22.12 or later within the 22.x LTS line;
- Rust stable with `rustfmt` and `clippy`;
- Tauri v2 native prerequisites; and
- Chromium installed through Playwright for browser-shell checks.

Install the locked JavaScript graph:

```powershell
cd app
npm ci
npm run install:browser-shell-chromium
```

## Fast frontend loop

```powershell
cd app
npm test
npm run check
npm run build
```

`npm test` runs the Vitest suite. `npm run check` replays reducer invariants.
`npm run build` performs TypeScript compilation and a production Vite build.

Run a focused test with Vitest arguments after `--`, for example:

```powershell
npm test -- src/components/Accounts.test.tsx
```

Do not document a fixed test count; it changes as coverage grows.

## Browser shell

```powershell
cd app
npm run test:browser-shell:config
npm run test:browser-shell:strict
```

The strict command builds the frontend, serves a Vite preview on a validated local
port, exercises the supported viewports, and applies the browser-shell accessibility
checks. Set `PRIME_STUDIO_BROWSER_PORT` to an unused integer from 1024 through 65535
when the default preview port is occupied:

```powershell
$env:PRIME_STUDIO_BROWSER_PORT = '43173'
npm run test:browser-shell:strict
```

This suite uses mocked IPC. Passing it provides no evidence about the Tauri backend,
Prime process, provider, credentials, filesystem effects, or packaged application.

## Rust checks

```powershell
cd app
cargo fmt --manifest-path .\src-tauri\Cargo.toml --all -- --check
cargo check --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
cargo clippy --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin -- -D warnings
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --all-targets --features test-support-bin
```

The default suite excludes machine-dependent ignored probes. Run one only in an
authorized disposable environment, never against a real provider profile:

```powershell
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --lib cli_probe -- --ignored --nocapture
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --lib codex_probe -- --ignored --nocapture
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --lib kernel_probe -- --ignored --nocapture
```

## Repository policy checks

From the repository root:

```powershell
node --test tests/design-provenance.check.mjs tests/public-fixtures-privacy.check.mjs
node --test tests/open-source-release-readiness.check.mjs
git diff --check
```

The design-provenance and privacy checks reject unresolved interface-source residue and
non-synthetic public fixtures. The release-policy test verifies that an incomplete candidate
remains blocked. None is release approval.

## Native development window

The mocked browser shell is the default UI-development path. Native startup may
inspect and recover account state below the `.prime` directory derived from
`USERPROFILE`, and it may persist configuration below the directory derived from
`APPDATA` on Windows or `XDG_CONFIG_HOME` on Linux. Windows webview state may also use
`LOCALAPPDATA`. Never launch it with your normal profile variables.

Open a fresh PowerShell at the repository root and use it only for the native launch.
Then create and verify a new disposable environment:

```powershell
cd app

$primeStudioBuildProfile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($primeStudioBuildProfile)) {
  throw "USERPROFILE is required to locate the installed Rust toolchain"
}
$primeStudioCargoHome = if ($env:CARGO_HOME) {
  $env:CARGO_HOME
} else {
  Join-Path $primeStudioBuildProfile '.cargo'
}
$primeStudioRustupHome = if ($env:RUSTUP_HOME) {
  $env:RUSTUP_HOME
} else {
  Join-Path $primeStudioBuildProfile '.rustup'
}

$primeStudioDevRoot = Join-Path ([IO.Path]::GetTempPath()) (
  'prime-studio-native-' + [guid]::NewGuid().ToString('N')
)
$primeStudioDevRoot = [IO.Path]::GetFullPath($primeStudioDevRoot)
$primeStudioProfile = Join-Path $primeStudioDevRoot 'profile'
$primeStudioAppData = Join-Path $primeStudioDevRoot 'appdata'
$primeStudioLocalAppData = Join-Path $primeStudioDevRoot 'local-appdata'
$primeStudioXdg = Join-Path $primeStudioDevRoot 'xdg'

New-Item -ItemType Directory -Path @(
  $primeStudioProfile,
  $primeStudioAppData,
  $primeStudioLocalAppData,
  $primeStudioXdg
) | Out-Null

foreach ($primeStudioPath in @(
  $primeStudioProfile,
  $primeStudioAppData,
  $primeStudioLocalAppData,
  $primeStudioXdg
)) {
  $primeStudioResolved = [IO.Path]::GetFullPath($primeStudioPath)
  if (-not $primeStudioResolved.StartsWith(
    $primeStudioDevRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Disposable path escaped its root"
  }
}

$env:USERPROFILE = $primeStudioProfile
$env:HOME = $primeStudioProfile
$env:APPDATA = $primeStudioAppData
$env:LOCALAPPDATA = $primeStudioLocalAppData
$env:XDG_CONFIG_HOME = $primeStudioXdg
$env:CARGO_HOME = $primeStudioCargoHome
$env:RUSTUP_HOME = $primeStudioRustupHome
$env:PRIME_STUDIO_CLI = $null
$env:PRIME_AGENT_CLI = $null
$env:PRIME_AGENT_CODING_AGENT_DIR = $null
$env:PRIME_STUDIO_DAEMON_SOCKET = $null

npm run tauri dev
```

Do not copy a real `.prime` directory into this root. Close the dedicated PowerShell
after the app exits so the modified environment is discarded. If the disposable
directory is later removed, resolve and inspect that exact directory again before any
recursive operation; never derive a deletion target from an unset variable. The
captured Cargo and rustup locations are retained only so the native build can find the
installed Rust toolchain; they are not copied into the disposable profile.

## Native build and destructive surfaces

`npm run tauri build` can be used as a local compilation and packaging check. Its
output is unsigned and unsupported; do not publish it.

Account-removal, recovery, and filesystem-mutation tests require a newly created
disposable operating-system profile. Before running them:

1. resolve and record the disposable root;
2. prove it contains only synthetic fixtures;
3. snapshot hidden files and canary hashes;
4. run the smallest intended operation;
5. compare the complete before-and-after state; and
6. remove only the exact verified disposable root.

Never use a real `.prime` directory. If a process must be stopped, verify both its PID
and executable path; do not terminate by image name.

## Interpreting results

- A unit test demonstrates only the boundary it directly exercises.
- A mocked browser test is not a native integration test.
- A build is not a signed or reproducible release.
- A historical acceptance record is not evidence for the current revision.
- Any change to source, dependencies, workflow, notices, or packaging invalidates the
  affected candidate evidence and requires fresh checks.

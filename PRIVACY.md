# Privacy

Prime Studio is a local desktop development snapshot, not an online service. This
document describes the checked-in application code, not a deployed service or the
separately installed prime-agent runtime.

## Data the application code can access

Local features in the source tree can access:

- Prime account registry metadata and profile directories under the operating-system
  user's `.prime` directory;
- the presence and expiry metadata of provider authentication records;
- local session JSONL files and derived transcript, usage, and fleet metadata;
- user-selected working directories and CLI paths;
- Prime Studio settings and scheduler state in the operating-system configuration
  directory; and
- small browser-local values used for generated labels and UI seen-state.

The code is designed not to expose credential values to the frontend. Account labels,
paths, session content, prompts, tool output, working directories, and usage records
can still be sensitive personal or organizational data.

## Local storage

On Windows, application settings are stored under the current user's roaming
application-data directory in a `prime-studio` folder. Prime-owned data remains under
the user's `.prime` directory. The embedded webview may retain its own local storage.

Source code includes account-removal transactions that can update the registry and,
after explicit confirmation, remove a selected profile directory. Development tests
for those paths must use a disposable operating-system profile containing only
synthetic data. Uninstall behavior and complete data deletion have not been validated
for a release.

## Network and external processes

Prime Studio does not include project telemetry or analytics reporting. The current
production authority gate rejects live Prime processes, provider authentication,
live RPC, external navigation, browser execution, and other elevated effects.

If those effects are enabled in a future version, the separately installed runtime,
provider, model, opened website, package manager, operating system, and build tools
may process data under their own terms. This project cannot describe or control those
third parties on their behalf. A future release must update this policy from verified
behavior before enabling those paths.

Development commands such as dependency installation may contact package registries.
That developer-tool traffic is not application telemetry.

## Logs and diagnostics

Do not publish raw logs, session files, crash dumps, screenshots, or protocol
captures. They may contain prompts, paths, account identifiers, provider output,
environment details, or other sensitive data. Reduce reproductions to deterministic
synthetic fixtures and inspect binary metadata before sharing them.

## Retention and deletion

Because there is no hosted Prime Studio service, the project has no server-side user
account or cloud retention schedule. Local data remains until the user or an
authorized local operation removes it. Removing the application may not remove Prime
data, settings, webview data, caches, build output, or the separately installed
runtime.

Before a supported release, the project must verify and document exact install,
upgrade, uninstall, export, and deletion behavior. No current source snapshot promises
complete erasure.

## Privacy reports

Treat a privacy issue that exposes sensitive data as a security report and follow
[SECURITY.md](SECURITY.md). Never put personal data in a public issue.

# dev/ — diagnostics

Throwaway-but-useful probes kept out of the shipped surface. None of these are
needed to build or run Prime Studio; they are how the facts in `../PROTOCOL.md`
were established and how the Windows console-flashing bug was tracked down.

All of them locate prime-agent the same way the app does. Override with
`PRIME_STUDIO_CLI` (path to prime-agent's `dist`, or directly to `bundle/cli.js`)
when it is not at the per-OS default.

| File | What it does |
|---|---|
| `prime-paths.mjs` | Shared prime-agent locator for the `.mjs` probes. |
| `probe-rpc.mjs` | Drives `--mode rpc` end to end and prints every event type seen. Source of the command/event tables in `PROTOCOL.md`. |
| `probe-shapes.mjs` | Same, but dumps truncated payload samples to ignored `rpc-shapes.local.json` for local comparison with `app/src/types.ts`. |
| `ratelimit-probe.py` | Logging pass-through proxy on `127.0.0.1:47822` in front of `api.anthropic.com`, to see whether `anthropic-ratelimit-unified-*` headers could drive a real subscription-% display. Blocked today: prime hardcodes its API base URL. |
| `watch-spawns.ps1` | Records every process created during a window, with parent and command line. Used to attribute console windows to prime's kernel vs. the harness. |
| `window-probe.ps1` | Enumerates top-level windows and reports any owned by the given PIDs, with window class (`ConsoleWindowClass`). Window ownership is reliable where conhost parentage is not. |
| `find-flasher.ps1` / `find-flasher-shim.ps1` | Reproduce the "prime launched from a parent with no console" case and poll for any visible window a descendant owns. The `-shim` variant runs the same thing with the `windowshide-shim.cjs` `--require` applied, so the two can be compared. |
| `console-experiment.ps1` | Decides whether Node's `windowsHide` actually suppresses a console when the *parent* has none. |
| `hide-test.mjs` | Spawns a long-lived python child the way prime's bootstrap does and prints its PID, so an external prober can check for a console. |
| `esm-test.mjs` | Checks whether an ESM import sees the shim's patched `spawnSync`. |

Probe output is gitignored because it is machine-specific and may contain local
paths or session content. The committed `rpc-raw.log` and `rpc-shapes.json` files
are separately maintained deterministic synthetic fixtures; `npm run check`
replays them through the transcript reducer. Never replace them with probe output.

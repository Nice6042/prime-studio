# Architecture

Prime Studio is a single desktop application with a React webview and a Rust Tauri
backend. It is currently structured as a fail-closed development snapshot rather than
an activated Prime client.

## Runtime boundary

```text
React presentation and domain state
        |
        | typed Tauri IPC request
        v
pre-dispatch command classification
        |
        +-- offline reads, local bookkeeping, account management,
        |   and safety controls -> command-specific validation
        |
        +-- elevated effects -> authority readiness check -> denied
                                      (all unavailable at startup)

Prime process request
        -> verified process specification
        -> explicit error before executable, arguments, environment, or spawn
```

Frontend code cannot promote effect readiness. A future activation path must obtain
enforced readiness from a trusted verifier and preserve command-specific validation;
changing UI state alone is never authority.

## Frontend

`app/src/` contains:

- React surfaces for sessions, accounts, settings, usage, fleet, artifacts, and tool
  activity;
- reducers and domain types for deterministic state transitions;
- strict provider, browser, orchestration, and project-chat contracts;
- a Tauri RPC wrapper that converts unavailable commands into explicit UI states; and
- unit, component, security, and characterization tests.

Several surfaces render synthetic or unavailable states in the browser harness. A
component's presence is not evidence that its native effect is active.

The webview stores only small UI values such as generated-name sequence and seen-state
in browser local storage. Native settings are owned by the backend.

## Backend

`app/src-tauri/src/` is the native trust boundary. Important modules include:

| Module | Responsibility |
|---|---|
| `authority.rs` | Classifies Tauri and raw-RPC commands and denies unavailable effects before dispatch |
| `lib.rs` | Wires commands, local settings, session reads, and the current process hard stop |
| `session_process.rs` | Models bounded process lifecycle and session ownership |
| `process_env_policy.rs` | Constructs an explicit child-process environment policy |
| `bounded_io.rs` | Applies byte, line, record, and directory bounds to local input |
| `accounts/` | Handles account metadata, transactional removal, and recovery |
| `runtime_manifest.rs` | Verifies a pinned runtime artifact closure; it does not activate execution |
| `provider_product.rs` | Produces bounded provider-product state from local metadata |
| `project_catalog.rs` | Validates and persists project catalog state |
| `scheduler.rs` | Persists local scheduler state with revision checks |

These modules use strict decoding, explicit bounds, path-containment checks, and
fail-closed errors at trust boundaries. Tests exercise additional implementations and
fixtures that production construction may not make reachable.

## Local data flow

The backend derives the operating-system user and configuration roots, then performs
bounded reads of Prime-owned metadata and session files. It may persist Prime Studio
settings and scheduler state under the application's configuration directory. Account
removal uses a prepare-and-commit transaction with recovery records; it is the most
destructive local surface and must be tested only against disposable synthetic data.

See [PRIVACY.md](PRIVACY.md) for the user-facing data inventory and the files under
`docs/security/` for detailed security invariants.

## Browser-shell test boundary

`app/e2e/` starts a Vite preview and injects a browser-only Tauri IPC fixture. It
checks rendered behavior and accessibility without loading the Rust backend, starting
a Prime process, accessing credentials, or touching a real workspace. See
`app/e2e/README.md` for the exact boundary.

## Build boundary

The frontend is compiled by TypeScript and Vite. Tauri embeds the frontend output and
builds the Rust application. A successful local build proves compilation only. It
does not prove runtime activation, provenance, reproducibility, signing, installer
safety, update safety, or release eligibility.

## Adding a capability

A production capability is incomplete until all of the following agree:

1. a strict external contract and bounded decoder;
2. command classification and an explicit effect class;
3. a trusted readiness verifier;
4. path, process, credential, and data-flow constraints;
5. negative authorization and malformed-input tests;
6. truthful unavailable and error states in the UI;
7. privacy, security, and architecture documentation; and
8. release evidence for the exact candidate revision.

Do not infer activation from a protocol type, test adapter, UI control, or dormant
backend function.

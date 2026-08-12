# Architecture

Prime Studio is a Windows-first desktop application with a React webview, a Rust
Tauri trust boundary, and a Studio-owned Node sidecar that adapts a separately
installed Prime Harness. It is a working development shell with a deterministic fake
full-stack integration and a fail-closed production activation boundary.

## Runtime boundary

```text
React product shell and projection stores
        | closed Tauri DTOs
        v
Rust command classification + Harness broker
        | ownership, cursor chronology, bounded frames, recovery
        v
verified Studio Node sidecar
        | versioned Studio Harness Protocol adapter
        v
supported Prime Harness profile
        | production activation currently unavailable
        v
separately installed Prime Agent runtime
```

Frontend code cannot promote effect readiness. Compatibility is descriptive, not
authority. A production capability needs a private native activation receipt bound to
the exact runtime, Node executable, sidecar, protocol/schema/profile, security epoch,
and scope. Changing UI state or accepting an adapter handshake is insufficient.

## Product frontend

The renderer starts at `app/src/App.tsx`, which always mounts
`app/src/app/StudioApp.tsx`. There is no environment-selectable legacy app entry.

The product frontend is split into:

- `app/`: composition, providers, workspace routing, and layout;
- `entities/`: project, chat, parent-message, and Harness projection models;
- `features/`: project navigation, parent conversation, composer, Harness inspector,
  editor canvas, command palette, and Settings surfaces; and
- `shared/`: closed IPC decoding, generated contracts, state store, and primitives.

The three-pane shell deliberately separates information channels:

1. projects, chat history, search, and create-chat entry points live on the left;
2. only the parent conversation and composer live in the center; and
3. child agents, child transcripts, tools, queue, resources, activity, and
   current-chat usage live in the right Harness inspector.

Selecting a child never injects its private work log into the parent transcript.
Account-wide usage lives in Settings and is not inferred from one chat. At compact
widths the side panes become focus-managed sheets; desktop widths are persisted and
bounded. Editor/canvas and command-palette surfaces preserve the same projection
ownership rules.

## Native backend

`app/src-tauri/src/` is the native trust boundary. Important modules include:

| Module | Responsibility |
|---|---|
| `authority.rs` | Classifies Tauri and legacy commands and denies unavailable effects before dispatch |
| `commands/harness.rs` | Typed bootstrap, projection, attach, and session-command endpoints |
| `harness/` | Verifies sidecar resources, validates SHP, binds ownership/cursors, and projects sessions |
| `lib.rs` | Wires commands, app state, catalog startup, recovery, and debug-only fixture installation |
| `project_catalog.rs` | Validates and persists the confined `projects-v2.json` catalog |
| `runtime_manifest.rs` | Verifies a pinned runtime artifact closure; it does not activate execution |
| `session_process.rs` | Provides bounded process lifecycle primitives retained for migration |
| `process_env_policy.rs` | Constructs explicit child-process environment policy |
| `bounded_io.rs` | Applies byte, line, record, and directory bounds to local input |
| `accounts/` | Handles account metadata, transactional removal, and recovery |
| `provider_product.rs` | Produces bounded provider-product state from local metadata |
| `scheduler.rs` | Persists scheduler state with revision checks |

These domains use strict decoding, explicit bounds, path-containment checks, and
fail-closed errors. Test-only constructors and fixtures are not production authority.

## Harness sidecar and protocol

`app/harness-sidecar/` is not part of renderer authority. Rust starts it only from
verified absolute resources and communicates through bounded LF-delimited Studio
Harness Protocol frames. The checked-in contract generates both Rust and TypeScript
shapes.

The Rust broker additionally enforces:

- Studio-owned session and child identity;
- exact runtime-generation and monotonically increasing sequence cursors;
- idempotent command identifiers and uncertain-outcome handling;
- bounded snapshots, strings, collections, and frames;
- a closed compatibility profile and command union; and
- recovery records that cannot be forged by the renderer.

A debug build may install the deterministic fake profile only when every explicit
Node, sidecar, and scenario path is present, absolute, hash-verified, and held. A
normal build does not install it. See [PROTOCOL.md](PROTOCOL.md).

## Browser and native verification

`app/e2e/` starts a Vite preview and injects browser-only typed Tauri projections. It
checks layout, keyboard behavior, accessibility, narrow sheets, inspector routing,
chat submission, usage updates, and child-detail isolation without credentials or a
real workspace.

The browser fixture and native fake-daemon path share the scenario contract and both
exercise mutable cursor-bound prompt admission. Native smoke verification additionally
proves the actual Tauri window, Rust broker, sidecar, catalog, composer response,
usage update, and child-detail isolation. Neither test activates a provider.

## Local data and persistence

Native code owns settings, projects, chats, session bindings, and account metadata.
The webview stores only bounded presentation preferences such as pane widths and
theme. Prime-owned session files remain outside Studio's persistence authority.

Account removal uses a prepare-and-commit transaction with recovery records and is
the most destructive local surface. It must be tested only against disposable
synthetic data. See [PRIVACY.md](PRIVACY.md) and `docs/security/`.

## Build and release boundary

TypeScript/Vite compilation and Rust/Tauri compilation prove only that the candidate
builds. They do not prove runtime activation, provenance, signing, installer safety,
update safety, or release eligibility. The boundary checker rejects legacy app-entry
selection, renderer raw RPC, direct runtime imports, open command unions, Node
primitives in product renderer code, and legacy markers in the production bundle.

## Adding or updating a capability

A production capability is incomplete until all of the following agree:

1. a strict external adapter contract and bounded decoder;
2. a closed generated renderer DTO;
3. command classification and an explicit effect class;
4. a trusted native readiness verifier and scoped activation receipt;
5. path, process, credential, ownership, chronology, and data-flow constraints;
6. malformed, stale, replay, mismatch, timeout, and update tests;
7. truthful ready/degraded/read-only/unavailable UI states;
8. privacy, security, architecture, testing, and compatibility documentation; and
9. release evidence for the exact candidate revision.

Do not infer production activation from a protocol type, fake adapter, UI control, or
dormant backend function. Unknown future Harness profiles must degrade safely; they
must never fall back to raw RPC.

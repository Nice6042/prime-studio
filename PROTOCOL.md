# Prime Studio Harness protocol

Prime Studio does not expose Prime Agent's daemon or RPC protocol directly to the
React renderer. The product boundary is a small, versioned Studio Harness Protocol
(SHP) carried over newline-delimited JSON between the Rust backend and a
Studio-owned Node sidecar.

## Why the adapter exists

The separately installed Prime Agent runtime may add commands, events, fields, or a
new protocol revision. Those changes must not silently become renderer authority.
The sidecar is the only code that understands a supported external runtime profile.
Rust validates a closed SHP envelope and the renderer receives a smaller generated
DTO projection.

```text
React renderer
  -> typed Tauri commands
  -> Rust Harness broker (ownership, chronology, bounds, recovery)
  -> verified Studio sidecar
  -> supported Prime Agent adapter profile
  -> separately installed Prime Agent runtime
```

There is no generic renderer `send_rpc` escape hatch in this path. Unknown fields,
unknown variants, duplicate keys, oversized frames, stale cursors, changed runtime
generations, and mismatched ownership fail closed.

## SHP envelope

The checked-in schema is `app/harness-contract/schema.json`. Generated Rust and
TypeScript representations are checked by `npm run check:harness-contract`.

Every frame is one UTF-8 JSON object followed by LF. Frames are bounded before JSON
decoding and duplicate object keys are rejected. Current request variants are:

- `discover_runtime`
- `bootstrap`
- `attach_session`
- `session_command`

`session_command` is a closed union of `prompt`, `steer`, `follow_up`, and `abort`.
It binds a Studio command ID, root session ID, and the exact expected
`{ runtimeGeneration, sequence }` cursor. A successful response contains the same
command ID, an explicit admission outcome, and a new authoritative session snapshot.

The projected root snapshot contains only bounded product data:

- parent-channel messages;
- child-agent summaries (child transcripts stay in the Harness inspector);
- queue, tool, context-source, and activity summaries;
- current-chat token/cost/context usage; and
- provider/model/session facts needed by this chat.

Account-wide usage is a Settings concern and is not inferred from current-chat
statistics.

Synthetic deterministic example (values are illustrative, not captured usage):

```json
{"tokens":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"total":100},"cost":0.01,"contextUsage":{"tokens":50,"contextWindow":1000,"percent":5}}
```

## Compatibility and authority

Discovery returns one of `ready`, `degraded`, `read_only`, or `unavailable`.
Compatibility is descriptive, not authority. Production execution additionally
requires a private native activation receipt bound to the exact runtime closure,
Node executable, sidecar, protocol/schema/profile, security epoch, and scope. That
activation is not shipped yet, so a normal production build remains unavailable.

The current adapter work targets the observed Prime Agent daemon profile named
`daemon-v7-schema13`. Version strings alone are never trusted: the installed package
has had prose and runtime-protocol metadata disagree, so activation must attest exact
files plus the live handshake and mandatory capabilities.

## Development fixture

Debug builds can opt into a deterministic fake Harness only when all three absolute
paths are supplied:

- `PRIME_STUDIO_DEBUG_HARNESS_NODE`
- `PRIME_STUDIO_DEBUG_HARNESS_ENTRY`
- `PRIME_STUDIO_DEBUG_HARNESS_SCENARIO`

Rust hashes and locks those explicit resources before starting the sidecar. The fake
daemon has no provider credentials, network access, or access to the user's normal
workspace. It exists to exercise the real Tauri -> Rust broker -> sidecar -> daemon
path, including cursor-bound prompt admission and projection updates. The browser
fixture consumes the same scenario model for parity.

These environment variables are debug-only. They are not a production activation
mechanism and must never be documented or presented as one.

## Update resilience

A new Prime Agent version is handled as a new or reviewed adapter profile:

1. discover and fingerprint the runtime without credentials;
2. compare protocol, schema, and mandatory capabilities;
3. replay the deterministic conformance corpus;
4. add a new profile or explicitly degrade unsupported features;
5. independently review the activation closure; and
6. only then allow a native activation receipt to select it.

If an update is unknown, Prime Studio remains readable where safe and reports the
exact unavailable reason. It never falls back to raw RPC or guesses command shapes.

## Related boundaries

Account removal is a separate typed Tauri domain and is not SHP. Browser, computer
use, filesystem mutation, external navigation, and credential management likewise
require their own native authorities; a Harness connection does not grant them.

See [ARCHITECTURE.md](ARCHITECTURE.md), the
[implementation program](docs/superpowers/plans/2026-08-12-prime-studio-implementation-program.md),
and the
[activation plan](docs/superpowers/plans/2026-08-12-prime-studio-activation-verification.md).

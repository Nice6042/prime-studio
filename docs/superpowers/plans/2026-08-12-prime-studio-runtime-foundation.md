# Prime Studio Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a closed, bounded, versioned Harness contract and a verified Rust-owned sidecar/broker boundary while leaving live execution unavailable.

**Architecture:** A generated Studio Harness Protocol is shared by the Node sidecar and Rust broker. The sidecar imports only verified Prime Harness package-root exports and normalizes runtime-specific data. Rust owns launch, authority, chronology, persistence, and renderer projections.

**Tech Stack:** JSON Schema, TypeScript/Node 22, Rust/serde, Tauri 2, Node test runner, Cargo.

## Global Constraints

- Do not enable `PrimeCliProcess` or `PrimeSessionProcess` production readiness in this plan.
- Do not import Prime Harness in the renderer or add it to application dependencies.
- Every external record is closed, bounded, detached, request-bound, and chronology-checked.
- The sidecar protocol channel contains protocol frames only; diagnostics use a separate bounded channel.
- Preserve current phase-zero behavior until ACT-02.

---

### Task FND-01: Characterize existing process and authority boundaries

**Files:**
- Create: `app/src-tauri/tests/harness_foundation_characterization.rs`
- Modify: `app/src-tauri/tests/execution_authority_gate.rs`
- Test: `app/src-tauri/tests/harness_foundation_characterization.rs`

**Interfaces:**
- Consumes: existing `AuthorityGate`, `TauriCommand`, process environment policy, runtime manifest.
- Produces: regression tests proving the legacy runtime remains unavailable during foundation work.

- [ ] **Step 1: Write the failing/characterization tests**

Add assertions equivalent to:

```rust
#[test]
fn phase_zero_rejects_every_harness_execution_entry() {
    let gate = AuthorityGate::phase_zero();
    for command in [
        TauriCommand::StartSession,
        TauriCommand::AttachSession,
        TauriCommand::FleetList,
        TauriCommand::SendRpc,
    ] {
        assert!(authorize_tauri_invoke(&gate, command.name(), &valid_payload(command)).is_err());
    }
}

#[test]
fn renderer_cannot_supply_runtime_readiness() {
    assert_rejected("harness_bootstrap", json!({"compatibility":{"status":"ready"}}));
}
```

- [ ] **Step 2: Run the focused tests**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --locked --test harness_foundation_characterization --features test-support-bin
cargo test --manifest-path app/src-tauri/Cargo.toml --locked --test execution_authority_gate --features test-support-bin
```

Expected: characterization tests pass against current phase-zero behavior; any missing command classifier test fails before subsequent code exists.

- [ ] **Step 3: Add only missing classification assertions**

Do not change production readiness. Extend test helpers so every future Harness command must appear in `ALL_TAURI_COMMANDS` and have explicit authority.

- [ ] **Step 4: Re-run focused tests and diff check**

Expected: PASS and no production activation delta.

- [ ] **Step 5: Commit**

```powershell
git add app/src-tauri/tests/harness_foundation_characterization.rs app/src-tauri/tests/execution_authority_gate.rs
git commit -m "test: characterize harness activation boundary"
```

### Task FND-02: Define and generate Studio Harness Protocol v1

**Files:**
- Create: `app/contracts/harness-v1.schema.json`
- Create: `app/scripts/generate-harness-contract.mjs`
- Create: `app/scripts/generate-harness-contract.node.mjs`
- Create: `app/src/shared/ipc/harness.generated.ts`
- Create: `app/src-tauri/src/harness/generated.rs`
- Create: `app/src-tauri/src/harness/mod.rs`
- Modify: `app/package.json`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/scripts/generate-harness-contract.node.mjs`
- Test: `app/src-tauri/src/harness/generated.rs`

**Interfaces:**
- Produces: `StudioEnvelope`, `HarnessCompatibility`, `HarnessCursor`, `RootSessionSnapshot`, `HarnessEvent`, closed request/result unions.
- Consumes: none; this is the contract root.

- [ ] **Step 1: Write schema generation tests**

Test deterministic output, schema closure, numeric bounds, string/array caps, and union discriminants:

```js
test("all authority-bound objects are closed", () => {
  for (const node of walkSchema(schema)) {
    if (node.type === "object") assert.equal(node.additionalProperties, false);
  }
});

test("generated files are byte-identical on a second run", async () => {
  const first = await generateInMemory(schema);
  const second = await generateInMemory(schema);
  assert.deepEqual(first, second);
});
```

- [ ] **Step 2: Run RED**

Run: `cd app; node --test scripts/generate-harness-contract.node.mjs`

Expected: FAIL because schema/generator do not exist.

- [ ] **Step 3: Author schema v1**

Required top-level limits:

```json
{
  "studioProtocol": { "const": 1 },
  "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{16,96}$" },
  "emittedAtMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
}
```

Define explicit maxima in schema constants: frame 4 MiB; label 200 Unicode scalars; IDs 128 printable ASCII; arrays 4,096 unless a narrower domain cap applies; transcript page 300 content rows; nesting 64.

- [ ] **Step 4: Generate TS and Rust types**

The generator must sort definitions/properties, include the source schema SHA-256, and refuse a dirty generated file in `--check` mode. Add scripts:

```json
{
  "scripts": {
    "generate:harness-contract": "node scripts/generate-harness-contract.mjs --write",
    "check:harness-contract": "node scripts/generate-harness-contract.mjs --check"
  }
}
```

- [ ] **Step 5: Add Rust round-trip/unknown-field tests**

Use `#[serde(deny_unknown_fields)]` on generated structs and assert duplicate JSON fields are rejected by a duplicate-preserving preflight before serde decoding.

- [ ] **Step 6: Run GREEN**

Run contract Node tests, `npm run check:harness-contract`, focused Rust tests, TypeScript build, and `git diff --check`.

- [ ] **Step 7: Commit**

```powershell
git add app/contracts app/scripts/generate-harness-contract* app/src/shared/ipc/harness.generated.ts app/src-tauri/src/harness app/package.json app/src-tauri/src/lib.rs
git commit -m "feat: define studio harness protocol"
```

### Task FND-03: Build the credential-free runtime discovery sidecar

**Files:**
- Create: `app/harness-sidecar/package.json`
- Create: `app/harness-sidecar/tsconfig.json`
- Create: `app/harness-sidecar/src/index.ts`
- Create: `app/harness-sidecar/src/framing.ts`
- Create: `app/harness-sidecar/src/runtimeDiscovery.ts`
- Create: `app/harness-sidecar/src/redaction.ts`
- Create: `app/harness-sidecar/test/runtimeDiscovery.test.ts`
- Create: `app/harness-sidecar/test/fixtures/runtime-ready/package.json`
- Create: `app/harness-sidecar/test/fixtures/runtime-ready/dist/index.js`
- Create: `app/harness-sidecar/test/fixtures/runtime-unknown/package.json`
- Create: `app/harness-sidecar/test/fixtures/runtime-unknown/dist/index.js`
- Modify: `app/package.json`
- Modify: `app/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: SHP `discover_runtime` request.
- Produces: credential-free `RuntimeIdentity` and observed protocol/schema/capability set.
- Does not create sessions or read credential values.

- [ ] **Step 1: Write hostile discovery tests**

Cover valid fixture, package-root reparse escape, wrong package name, missing export, accessor export, huge package metadata, protocol mismatch, stdout noise, and secret-shaped diagnostics.

```ts
expect(await discoverRuntime(validRoot)).toMatchObject({
  packageName: "prime-agent",
  protocolName: "prime-agent.daemon",
  protocolVersion: 7,
  schemaRevision: 13,
});
await expect(discoverRuntime(unknownRoot)).rejects.toMatchObject({ code: "unsupported_runtime" });
```

- [ ] **Step 2: Run RED**

Run: `cd app; npx tsc -p harness-sidecar/tsconfig.json && node --test harness-sidecar/dist/test/*.test.js`

Expected: FAIL on missing project.

- [ ] **Step 3: Implement bounded discovery**

Use Node built-ins only. Resolve the package root from a Rust-supplied canonical path; import only the package root; inspect required exports without invoking auth; derive runtime identity and hash inputs; serialize only SHP DTOs. Reject getters/accessors and unexpected callable shapes.

- [ ] **Step 4: Implement framing/redaction**

Read exact bounded frames, reject duplicate JSON fields before `JSON.parse`, write one response per request, send redacted diagnostics to stderr, and exit nonzero on protocol corruption.

- [ ] **Step 5: Package as a Tauri resource**

Compile to a deterministic resource directory. Do not copy Prime Harness. Add resource existence/hash policy tests.

- [ ] **Step 6: Run GREEN and mutation probes**

Mutate protocol version, schema ID, export identity, and capability list one at a time; each must make the focused suite fail before restoration.

- [ ] **Step 7: Commit**

```powershell
git add app/harness-sidecar app/package.json app/src-tauri/tauri.conf.json
git commit -m "feat: add harness runtime discovery sidecar"
```

### Task FND-04: Implement compatibility profiles

**Files:**
- Create: `app/harness-sidecar/src/compatibility.ts`
- Create: `app/harness-sidecar/src/profiles/daemon-v7-schema13.ts`
- Create: `app/harness-sidecar/test/compatibility.test.ts`
- Create: `app/src-tauri/src/harness/compatibility.rs`
- Create: `app/src-tauri/tests/harness_compatibility.rs`
- Create: `docs/runtime-compatibility-manifest.md`
- Modify: `app/src-tauri/src/authority.rs`

**Interfaces:**
- Consumes: `RuntimeIdentity`, observed capabilities, trusted profile manifest.
- Produces: `HarnessCompatibility`.
- Profile mandatory capabilities: attach snapshot, event sequence, resident lifecycle/create, session input admission, model catalog.
- Optional features map independently to feature flags.

- [ ] **Step 1: Write the compatibility matrix tests**

```rust
assert_eq!(decide(known_complete()).status(), CompatibilityStatus::Ready);
assert_eq!(decide(known_without("extension_ui")).status(), CompatibilityStatus::Degraded);
assert_eq!(decide(known_without("event_sequence")).status(), CompatibilityStatus::ReadOnly);
assert_eq!(decide(unknown_schema()).status(), CompatibilityStatus::Unavailable);
```

Also prove a version string change alone cannot make an unknown hash ready.

- [ ] **Step 2: Run RED**

Expected: missing compatibility module/profile.

- [ ] **Step 3: Implement one explicit profile**

Bind exact observed package/runtime identities to daemon protocol 7/schema 13 and map every capability to a Studio feature. Keep the manifest data-only and independently reviewable.

- [ ] **Step 4: Keep authority unavailable**

The compatibility result is evidence input, not readiness. Add a test showing `status: ready` still cannot start a session without a verified activation receipt.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add app/harness-sidecar/src/compatibility.ts app/harness-sidecar/src/profiles app/harness-sidecar/test/compatibility.test.ts app/src-tauri/src/harness/compatibility.rs app/src-tauri/tests/harness_compatibility.rs docs/runtime-compatibility-manifest.md app/src-tauri/src/authority.rs
git commit -m "feat: negotiate harness compatibility profiles"
```

### Task FND-05: Contain and supervise the sidecar process

**Files:**
- Create: `app/src-tauri/src/harness/sidecar.rs`
- Create: `app/src-tauri/tests/harness_sidecar.rs`
- Create: `app/src-tauri/tests/support/fake_harness_sidecar.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/process_env_policy.rs`
- Modify: `app/src-tauri/src/authority.rs`

**Interfaces:**
- Produces: `SidecarSupervisor::start(spec) -> Result<SidecarHandle, HarnessError>`, `SidecarHandle::request(request, deadline)`, `SidecarHandle::shutdown(deadline)`.
- Consumes: verified sidecar resource identity and explicit Node process spec.

```rust
pub struct SidecarSupervisor;
impl SidecarSupervisor {
    pub fn start(spec: VerifiedSidecarSpec) -> Result<SidecarHandle, HarnessError>;
}
impl SidecarHandle {
    pub async fn request(
        &self,
        request: StudioRequest,
        deadline: Instant,
    ) -> Result<StudioResponse, HarnessError>;
    pub async fn shutdown(self, deadline: Instant) -> Result<(), HarnessError>;
}
```

- [ ] **Step 1: Write process containment tests**

Cover silent timeout, output flood, invalid frame, stderr secret redaction, parent shutdown, child descendant retention, sidecar replacement race, wrong executable, and environment leakage.

- [ ] **Step 2: Run RED**

Expected: missing supervisor.

- [ ] **Step 3: Implement verified launch**

Reuse existing command timeout/process-tree containment and explicit environment policy. Pass only required locale/temp/system variables plus a random per-launch channel nonce. Assign Windows Job Object before resume. Never inherit provider environment secrets by default.

- [ ] **Step 4: Implement bounded request multiplexer**

Bind responses to request ID; cap pending requests; enforce absolute deadlines; treat post-send timeout as uncertain unless the operation is declared idempotent; close on malformed frame.

- [ ] **Step 5: Run Rust focused and existing process tests**

Expected: all green and no regression to current command containment.

- [ ] **Step 6: Commit**

```powershell
git add app/src-tauri/src/harness/sidecar.rs app/src-tauri/tests/harness_sidecar.rs app/src-tauri/tests/support/fake_harness_sidecar.rs app/src-tauri/Cargo.toml app/src-tauri/src/process_env_policy.rs app/src-tauri/src/authority.rs
git commit -m "feat: contain harness adapter sidecar"
```

### Task FND-06: Add broker snapshots, chronology, and credential-free projections

**Files:**
- Create: `app/src-tauri/src/harness/broker.rs`
- Create: `app/src-tauri/src/harness/projections.rs`
- Create: `app/src-tauri/src/harness/recovery.rs`
- Create: `app/src-tauri/tests/harness_broker.rs`
- Create: `app/src-tauri/tests/harness_recovery.rs`
- Create: `app/src-tauri/src/app_state.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `HarnessBroker::bootstrap`, `attach`, `apply_snapshot`, `apply_event`, `project`, `close`.
- Stores exact `HarnessCursor { runtime_generation, sequence }` per root session.
- Projects only bounded SHP DTOs.

```rust
impl HarnessBroker {
    pub async fn bootstrap(&mut self) -> Result<BootProjection, HarnessError>;
    pub async fn attach(&mut self, request: AttachRequest) -> Result<RootSessionProjection, HarnessError>;
    pub fn apply_snapshot(&mut self, snapshot: RootSessionSnapshot) -> Result<(), HarnessError>;
    pub fn apply_event(&mut self, event: HarnessEvent) -> Result<(), HarnessError>;
    pub fn project(&self, session_id: &SessionId) -> Option<RootSessionProjection>;
}
```

- [ ] **Step 1: Write event chronology and ownership tests**

Reject duplicate/decreasing sequences, old generation, wrong root/child/account/project, cursor replay after restart, partial snapshot without end, event before snapshot, and cross-broker snapshot reuse.

- [ ] **Step 2: Run RED**

Expected: missing broker/recovery.

- [ ] **Step 3: Implement snapshot-first state machine**

States are `Disconnected → Handshaking → Snapshotting → Live → Reconnecting/Failed/Closed`. No event reaches a projection before the snapshot is complete and authenticated.

- [ ] **Step 4: Implement bounded recovery record**

Persist only runtime identity digest, Studio profile, root session bindings, last cursor, and projection schema version. Use atomic replacement, exact revision, and bounded read. Do not persist credentials or raw event payloads.

- [ ] **Step 5: Implement projection builders**

Detach/freeze equivalent data at the Rust boundary and distinguish `unavailable`, `stale`, `disconnected`, and `unknown_outcome`.

- [ ] **Step 6: Run GREEN, reducer-style randomized sequence tests, and commit**

```powershell
git add app/src-tauri/src/harness app/src-tauri/tests/harness_broker.rs app/src-tauri/tests/harness_recovery.rs app/src-tauri/src/app_state.rs app/src-tauri/src/lib.rs
git commit -m "feat: broker harness snapshots and event chronology"
```

### Task FND-07: Expose read-only bootstrap through generated Tauri IPC

**Files:**
- Create: `app/src-tauri/src/commands/mod.rs`
- Create: `app/src-tauri/src/commands/harness.rs`
- Create: `app/src/shared/ipc/client.ts`
- Create: `app/src/shared/ipc/client.test.ts`
- Create: `app/src/entities/harness/types.ts`
- Modify: `app/src-tauri/src/authority.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/rpc.ts`

**Interfaces:**
- Produces renderer calls: `bootstrapHarness(): Promise<BootProjection>`, `subscribeHarnessEvents(listener): Unsubscribe`.
- This task exposes discovery/compatibility only; session mutation methods return unavailable.

```ts
export async function bootstrapHarness(): Promise<BootProjection>;
export function subscribeHarnessEvents(
  listener: (event: HarnessProjectionEvent) => void,
): () => void;
```

- [ ] **Step 1: Write strict frontend decoder tests**

Test exact ready/degraded/read-only/unavailable projections, wrong keys, impossible capability combinations, huge strings, proxy/accessor values in the browser fixture, and stale response generations.

- [ ] **Step 2: Run RED**

Expected: generated client absent.

- [ ] **Step 3: Add `harness_bootstrap` and `harness_projection` commands**

Classify them `OfflineRead`. Keep `harness_create_session`, `harness_attach_session`, and `harness_send` unregistered until activation tasks.

- [ ] **Step 4: Add event subscription wrapper**

Use a single global Tauri listener, validate every patch, reject sequence gaps, and expose an unsubscribe function. Do not fold errors to null/empty arrays.

- [ ] **Step 5: Keep legacy `rpc.ts` working**

Add deprecation comments and route only discovery UI to the new client. Do not remove legacy paths in foundation.

- [ ] **Step 6: Run exit gate**

```powershell
cd app
npm test -- src/shared/ipc/client.test.ts src/rpc.test.ts
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --test harness_compatibility --test harness_sidecar --test harness_broker --test harness_recovery --features test-support-bin
npm run test:browser-shell:strict
```

Expected: app shows a truthful compatibility state; live session effects remain unavailable.

- [ ] **Step 7: Commit and request security review**

```powershell
git add app/src-tauri/src/commands app/src/shared/ipc app/src/entities/harness app/src-tauri/src/authority.rs app/src-tauri/src/lib.rs app/src/rpc.ts
git commit -m "feat: project harness compatibility to renderer"
```

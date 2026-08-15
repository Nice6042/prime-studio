# Browser and computer-use worker contract

Prime Studio treats browser execution and Windows computer use as separate high-impact native
effects. Renderer intent, a settings toggle, a Harness capability string, or an installed browser
is never execution authority.

The checked-in native contract is deliberately split into three layers:

1. **Admission truth.** Existing browser and computer-use projections report whether trusted native
   authority, a verified worker, and effect dispatch are independently absent, partial, or ready.
   They never promote readiness from UI intent.
2. **Lease-scoped authority.** `app/src-tauri/src/harness/interaction_worker.rs` binds every operation
   to a session, chat, operation ID, capability, target digest, exact worker identity, issue time,
   and expiry. Read-only and mutating capabilities are distinct. Click and typing leases require an
   explicit mutating grant. Settled operation identities remain retired for the worker epoch so a
   success, failure, timeout, cancellation, mismatch, or invalid completion cannot be replayed.
3. **Evidence closure.** Completion must use the same worker and an unexpired lease. Evidence is
   bounded, hashed, and tied to the target digest. Duplicate operations, replay, oversized captures,
   worker mismatch, and late completion fail closed.

Production currently constructs no `VerifiedInteractionWorker` and exposes no interaction dispatch
command. Settings and other product surfaces must therefore continue to report the exact
unavailable/admission-only state. A future production worker must add platform-specific resource
verification, process containment, worker handshake and shutdown, bounded browser capture,
foreground-window identity for OS-level computer use, user takeover and cancellation, screenshot
redaction, immutable audit persistence, and disposable Windows end-to-end evidence before any
readiness can be promoted.

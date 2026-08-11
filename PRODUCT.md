# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Prime Studio is delivered as a Windows-first Tauri desktop application. Its interface is a
React webview, so the product uses web interaction and accessibility semantics while preserving
desktop window, keyboard, filesystem, and process expectations.

## Users

Prime Studio is for developers who use the separately installed Prime Harness to work across
repositories, long-running agent sessions, provider accounts, and child-agent tasks. They need a
calm primary conversation and a separate operational view of the harness without mixing child
transcripts, tool telemetry, or accounting detail into the main chat.

## Product Purpose

Prime Studio turns Prime Harness into a coherent desktop application. It should let a developer
start, resume, steer, queue, inspect, and stop work; understand context and token use; inspect
subagents and files; and recover safely from disconnects or runtime incompatibility.

Success means the main conversation remains as direct as a familiar desktop chat application,
while the right-side Harness inspector provides truthful operational depth on demand. Every
visible state must come from an authenticated runtime projection, persisted Studio state, or
clearly labeled demonstration fixture.

## Positioning

Prime Studio is not another model chat wrapper. Its distinctive mechanism is a clean parent-agent
conversation paired with a dedicated Harness inspector for private child-agent transcripts,
queue and tool activity, current-chat context and usage, and runtime recovery. Account-wide
usage and configuration remain in Settings.

## Operating Context

- Windows 11 is the currently exercised native platform.
- Prime Harness is installed separately and is not distributed by this repository.
- A user may have several provider accounts, projects, live resident sessions, archived sessions,
  and child agents active at once.
- Work happens inside user-selected repositories and can include long-running tools, filesystem
  edits, context compaction, reconnects, and daemon restarts.
- The public source repository is a fail-closed development snapshot until verified runtime
  activation is implemented and independently reviewed.

## Capabilities and Constraints

- Keep Tauri 2, Rust, React, TypeScript, and Vite unless an implementation task proves a specific
  boundary cannot meet the contract.
- The final target includes real resident Prime Harness sessions, delivered through staged
  activation. Unsupported or unverified Harness versions must degrade to an explicit compatible
  subset or read-only unavailable state.
- Runtime compatibility is negotiated from exact runtime identity, protocol/schema identity,
  and declared capabilities. Package semver alone is never authority.
- Provider credentials stay outside the renderer. The renderer receives bounded, credential-free
  projections only.
- The main transcript contains only the parent conversation. Child transcripts, child activity,
  and child files appear only after selecting a child in the right panel.
- The right-panel Usage view is scoped to the current chat. Account-wide usage lives only in
  Settings → Usage.
- Subagent creation and ordinary subagent execution do not invent approval prompts. A contextual
  prompt is shown only when the verified runtime emits a real extension UI request.
- Unknown events, impossible state combinations, lost event chronology, and unsupported effects
  fail closed and remain visible as unavailable, degraded, stale, blocked, or disconnected.
- The app must remain keyboard-complete, screen-reader understandable, reduced-motion aware, and
  usable at narrow desktop sizes and 200% zoom.
- ChatGPT Desktop and the supplied Prime Studio prototype are interaction references, not sources
  of code, branding, icons, copy, or proprietary assets. The implementation must remain original.

## Brand Commitments

- Product name: Prime Studio.
- Prime Studio should feel like a proper desktop application built on Prime Harness: quiet,
  precise, familiar, fast, and operationally truthful.
- The conversation structure follows familiar desktop-chat conventions. Prime-specific identity
  lives in the Harness inspector, status vocabulary, original project iconography, and restrained
  violet accent.
- Use one workhorse system UI type family, semantic dark and light tokens, restrained borders,
  compact metadata, and standard desktop controls. Avoid decorative dashboards, gradients,
  excessive cards, fake telemetry, and invented gamification.

## Evidence on Hand

- The current public source tree contains hardened native authority, account, persistence,
  provider, scheduler, browser, computer-use, artifact, transcript, and test boundaries.
- The project owner supplied a working high-fidelity HTML prototype and seven reviewed reference
  views covering the shell, parent chat, Harness overview, child detail, current-chat usage,
  activity, settings, and account usage. These are behavioral and visual references only and are
  not imported into the repository.
- The installed Prime Harness exposes a daemon protocol with protocol/schema identity,
  capability negotiation, snapshots, event sequences, resident sessions, child-agent state,
  model catalogs, extension UI, and recovery semantics. The repository's older RPC assumptions
  are not sufficient authority for that runtime.
- No production customer claims, benchmark claims, provider quota promises, or release claims are
  available. Future work must not fabricate them.

## Product Principles

1. Keep the parent conversation clean; reveal operational depth in the Harness inspector.
2. Project runtime truth; never infer availability, success, cost, approval, or safety from UI
   intent.
3. Prefer capability negotiation and normalized contracts over dependencies on one Harness build.
4. Preserve hardened native boundaries while replacing stale integration assumptions.
5. Make expert workflows fast without hiding recovery, degraded, or destructive states.

## Accessibility & Inclusion

Prime Studio targets WCAG 2.2 AA for the renderer, zero serious or critical axe findings in its
supported browser-shell scenarios, full keyboard operation, visible focus, robust screen-reader
landmarks and live status, reduced-motion behavior, forced-colors support, 200% zoom reflow, and
non-color-only state communication.

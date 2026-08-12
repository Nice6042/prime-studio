# Prime Studio Package Fidelity Contract

**Status:** authoritative implementation acceptance contract

**Package:** `Prime Studio App Concept.zip`
**Package SHA-256:** `7EE3AC5496A93A9EDAB444873DAEF3632E9684173AE315116DEA2A01531E77A9`

## Source boundary

The owner-supplied package is read-only design and behavior evidence. It is not vendored, linked,
or copied into the product. The package artifacts inspected for this contract were:

| Artifact | SHA-256 | Use |
|---|---|---|
| `README.md` | `2D736242ABA4E70029B6714FEC5D44FF49972C84CDE29A71B5996A092E0F1B5E` | product intent, screen inventory, target tokens |
| `Prime Studio.dc.html` | `1A292ACABA352DB9965D2DF652F42C1FC2AF08D86E363E18B23D67B2D5FF3627` | working interaction and state oracle |
| `support.js` | `8FE7DF74405F3C55F49B7249C74EA1397E65D07DEA2B1BD3B4A489BEC2E28CBE` | generic prototype renderer; explicitly excluded from product behavior and porting |

## Machine-checkable authorities

- [`packageAcceptance.ts`](../../app/src/contracts/packageAcceptance.ts) is the complete acceptance
  catalog: 115 feature requirements, 153 unique feature/action control bindings, 29 screen
  destinations, 58 state families, 30 preference keys, 7 keyboard requirements, 13 responsive
  invariants, and 26 required data authorities.
- [`studioOperations.ts`](../../app/src/contracts/studioOperations.ts) is the closed action contract.
  Every interactive requirement points to one or more typed actions owned by Harness, a durable
  Studio store, renderer presentation state, a native boundary, or an explicit unsupported rule.
- Their Vitest suites prove feature-range completeness, action existence, action-owner routing,
  current-chat/account-usage separation, required unavailable explanations, and rejection of
  undefined executor outcomes.

An interactive component is complete only when it is registered with a stable control ID and one
closed action. `undefined`, an omitted callback, an empty function, or a generic “demo” toast is a
contract failure.

## Fidelity inventory

| Area | IDs | Count | Required product result |
|---|---:|---:|---|
| Shell and responsive layout | SH-01–SH-10 | 10 | native title/status chrome, exact width budget, semantic themes |
| Navigation | NV-01–NV-10 | 10 | durable projects/chats/pins/archive/unread/workspace actions |
| Parent conversation | CV-01–CV-15 | 15 | parent-only streaming, versions, branches, files, Canvas, history |
| Composer | CP-01–CP-11 | 11 | attachments, catalogs, slash commands, admission, drafts, explicit voice status |
| Harness and child detail | HR-01–HR-18 | 18 | overview, queue/tools/context, failures, private child drill-in, extension prompts |
| Current-chat usage | CU-01–CU-08 | 8 | root-session-scoped accounting and accessible charts |
| Activity | AC-01–AC-06 | 6 | filters, groups, tool/file details, child links, seen cursor |
| Editor and Canvas | ED-01–ED-07 | 7 | diff/edit/save/conflict/canvas/reflow |
| Settings | ST-01–ST-14 | 14 | 13 routes, live/policy-backed controls, accurate identities |
| Account usage | AU-01–AU-06 | 6 | 7/30/90 ledger views, refresh, safe CSV, invariant totals |
| Command palette | PL-01–PL-04 | 4 | Actions/Chats/Messages, keyboard selection, shared registry |
| Common interaction/state | CM-01–CM-06 | 6 | shortcuts, toasts, clock, overlays, state matrix, zoom/reflow |

## Required destinations

Workspace: expanded sidebar, collapsed rail, empty/active/streaming parent conversation. Editor:
Diff, Edit, and Canvas. Inspector: Harness overview, current-chat Usage, Activity, and child Chat,
Activity, and Files. Settings: General, Appearance, Composer, Harness, Usage, Models, Accounts,
Tools, Git, Environments, Privacy & security, Keyboard shortcuts, and About. Overlays: command
palette plus the shared menus/popovers/toast layer.

The handoff calls this a “12-page” settings surface, but the executable prototype and its route
registry contain 13 pages. Thirteen is the acceptance truth.

## Prototype defects that must be corrected, not reproduced

- Window controls, File/Edit/Window menu commands, new project, rename/duplicate/move, normal file
  save, refresh, export-session, and several attachment actions were decorative or toast-only.
- Archive and Delete performed the same removal and no archive destination existed.
- Context was global rather than per chat; displayed token totals disagreed with its assumed window.
- Preferences were memory-only except four pane fields; most visible preference controls did not
  affect the render.
- Responsive fitting could render a 200px sidebar or 260px inspector despite documented minima,
  and it used a fixed 310px editor budget unrelated to the rendered editor width.
- Esc did not actually close the topmost overlay; palette keyboard navigation had no active row;
  ordinary Save and Canvas Apply left dirty state uncleared.
- All telemetry, agent identities, transcripts, charts, tokens, costs, files, timers, retry events,
  and overload events were synthetic demonstration data.

Production keeps the package's visible intent while replacing every item above with a typed action,
verified projection, durable Studio state, or explicit unavailable explanation.

## Data ownership

Prime Harness projections own runtime compatibility, root/child session truth, parent/child
transcripts, queue, tools, context sources, model catalog, live activity, and current-chat usage.
Studio stores own project/chat metadata, pins, archive, unread cursors, drafts, display revisions,
layout, preferences, account registry, and the account-wide usage ledger. Native boundaries own
window commands, clipboard outcomes, dialogs, identity-bound file reads/writes, and exports.

No provider credential, raw SDK object, unrestricted path, or fabricated count enters the renderer.

## Acceptance gate

The audited baseline at `4206bbedb5fb7d6ee0ae34e3092d5fea5b02241d` has 18 complete, 63 partial,
11 placeholder, 21 missing, and 2 explicitly unavailable requirements. “Complete” means the
visible product slice already meets this package contract, not merely that a component renders.

1. All 115 rows in the machine catalog are `complete` or `explicitly_unavailable` for a documented
   upstream reason; no `partial`, `placeholder`, or `missing` remains.
2. Every rendered interactive control has exactly one stable control binding whose action exists in
   the closed action map and whose executor always returns an allowed outcome.
3. Browser scenarios cover all 29 destinations at wide, narrow, and 200% zoom states with keyboard,
   overflow, and serious/critical axe assertions.
4. Deterministic fake-daemon fixtures exercise all runtime states without presenting demonstration
   values as production truth; native integration proves renderer → Rust → sidecar → daemon.
5. Current-chat Usage excludes unrelated sessions and Settings Usage never appears in the right
   inspector. Parent and child transcript reducers remain structurally isolated.
6. The visual build is compared against the supplied package at representative wide and narrow
   viewports using `DESIGN.md`; proprietary code and assets remain absent from the repository.

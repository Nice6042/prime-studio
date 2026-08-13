# Prime Studio Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic workspace composition with the final resizable desktop-chat shell, project navigation, parent-only conversation, and production composer against fixture/read-only projections.

**Architecture:** Feature stores consume normalized entities and expose selectors to presentational components. A pure layout solver owns all panel geometry. Parent transcript state is structurally separate from child data. Existing hardened reducers and session behavior are characterized before migration.

**Tech Stack:** React 19, TypeScript, CSS semantic tokens, Vitest/Testing Library, Playwright/axe.

## Global Constraints

- Do not activate live Harness effects in this plan.
- Preserve all current account/session/archive functionality until its replacement slice is green.
- Do not render child transcript/activity in the center conversation.
- Use one global event listener and presentation clock.
- Use semantic dark/light tokens; do not use CSS inversion.
- Every layout action must work with pointer, keyboard, 200% zoom, and narrow-sheet mode.

---

### Task UI-01: Introduce application composition and normalized stores

**Files:**
- Create: `app/src/app/StudioApp.tsx`
- Create: `app/src/app/AppProviders.tsx`
- Create: `app/src/app/routes.ts`
- Create: `app/src/shared/state/store.ts`
- Create: `app/src/entities/chats/chatStore.ts`
- Create: `app/src/entities/sessions/sessionStore.ts`
- Create: `app/src/entities/navigation/navigationStore.ts`
- Create: `app/src/app/StudioApp.test.tsx`
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `BootProjection`, existing accounts/models/sessions, new Harness compatibility projection.
- Produces: `StudioAppState`, typed `StudioIntent`, selectors, route `workspace | settings`.

```ts
export type StudioIntent =
  | { type: "chat/open"; chatId: string }
  | { type: "chat/create"; projectId: string; accountId: string | null }
  | { type: "route/settings"; section?: SettingsSectionId }
  | { type: "async/started"; key: string; generation: number }
  | { type: "async/resolved"; key: string; generation: number; value: unknown };
export function reduceStudio(state: StudioAppState, intent: StudioIntent): StudioAppState;
```

- [ ] **Step 1: Write reducer/store tests**

```ts
it("keeps account and project ownership fixed for an open chat", () => {
  const state = reduce(initial, openChat({ chatId: "c1", accountId: "a1", projectId: "p1" }));
  expect(reduce(state, selectDefaultAccount("a2")).chats.c1.accountId).toBe("a1");
});

it("rejects stale async results by request generation", () => {
  const state = reduce(loading(2), loaded({ generation: 1, data: fixture }));
  expect(state).toEqual(loading(2));
});
```

- [ ] **Step 2: Run RED**

Run: `cd app; npm test -- src/app/StudioApp.test.tsx`

Expected: missing modules.

- [ ] **Step 3: Implement a small external-store primitive**

Use `useSyncExternalStore`; require explicit actions and selectors; no proxy/magic mutation. Normalize projects/chats/sessions by ID and keep overlay/layout state separate.

- [ ] **Step 4: Mount `StudioApp` behind a temporary feature flag**

`App.tsx` chooses legacy or new composition from a compile-time test fixture flag only. Production remains legacy until UI-07 parity gate.

- [ ] **Step 5: Run focused tests/typecheck and commit**

```powershell
git add app/src/app app/src/shared/state app/src/entities app/src/App.tsx
git commit -m "refactor: add normalized studio application state"
```

### Task UI-02: Build the pure layout solver and desktop shell

**Files:**
- Create: `app/src/features/shell/layoutSolver.ts`
- Create: `app/src/features/shell/layoutSolver.test.ts`
- Create: `app/src/features/shell/WorkspaceShell.tsx`
- Create: `app/src/features/shell/WorkspaceShell.test.tsx`
- Create: `app/src/features/shell/PaneSeparator.tsx`
- Create: `app/src/features/shell/TitleBar.tsx`
- Create: `app/src/features/shell/RuntimeStatusBar.tsx`
- Create: `app/src/features/shell/shell.css`
- Modify: `app/src/app/StudioApp.tsx`
- Create: `app/src-tauri/src/commands/settings.rs`

**Interfaces:**
- Produces:

```ts
type LayoutInput = {
  viewport: number;
  sidebar: { open: boolean; preferred: number };
  inspector: { open: boolean; preferred: number };
  editor: { open: boolean; preferred: number };
};
type LayoutResult = {
  sidebar: { mode: "pane" | "rail" | "sheet"; width: number };
  inspector: { mode: "pane" | "sheet" | "closed"; width: number };
  editor: { mode: "pane" | "sheet" | "closed"; width: number };
  centerWidth: number;
};
```

- [ ] **Step 1: Write exhaustive table/property tests**

Include viewport widths 320–2560, preferred widths outside bounds, every open/closed combination, editor priority, 340px center minimum, 8px handle budget, and no negative/NaN values.

- [ ] **Step 2: Run RED**

Expected: missing solver.

- [ ] **Step 3: Implement deterministic solver**

Bounds: sidebar 210–380/default 264; inspector 300–600/default 384; editor 280–600/max 46%; center minimum 340. Collapse sidebar before violating center; convert inspector/editor to sheets according to active intent.

- [ ] **Step 4: Build shell and accessible separators**

```tsx
<PaneSeparator
  aria-label="Resize project sidebar"
  orientation="vertical"
  valueNow={sidebarWidth}
  valueMin={210}
  valueMax={380}
  onChange={setSidebarWidth}
  onReset={() => setSidebarWidth(264)}
/>
```

Arrow keys resize by 8px, Shift+Arrow by 32px, Home/End clamp, double click resets.

- [ ] **Step 5: Persist layout through Rust settings**

Use a versioned `LayoutPreferencesV1`; validate/clamp on read and write. Migrate only legacy `prime-studio-ui` values that pass strict bounds, then delete the key after acknowledged persistence.

- [ ] **Step 6: Add title/status bars**

Title bar commands use Tauri window APIs; status bar consumes current root-session projection and prints unavailable/stale rather than zero.

- [ ] **Step 7: Run component/property tests and commit**

```powershell
git add app/src/features/shell app/src/app/StudioApp.tsx app/src-tauri/src/commands/settings.rs
git commit -m "feat: add adaptive workspace shell"
```

### Task UI-03: Implement project-first navigation and chat catalog actions

**Files:**
- Create: `app/src/features/navigation/ProjectSidebar.tsx`
- Create: `app/src/features/navigation/ProjectSidebar.test.tsx`
- Create: `app/src/features/navigation/CollapsedSidebar.tsx`
- Create: `app/src/features/navigation/navigationSelectors.ts`
- Create: `app/src/features/navigation/navigationSelectors.test.ts`
- Create: `app/src/features/navigation/navigation.css`
- Modify: `app/src/domain/projectChats/reducer.ts`
- Modify: `app/src/domain/projectChats/serialization.ts`
- Modify: `app/src-tauri/src/project_catalog.rs`
- Modify: `app/src/app/StudioApp.tsx`

**Interfaces:**
- Consumes: projects/chats/catalog revision, root-session summaries, unread cursor.
- Produces intents: `createChat`, `selectChat`, `pinChat`, `renameChat`, `duplicateChat`, `moveChat`, `archiveChat`, `deleteChat`.

```ts
export type CatalogMutation =
  | { type: "pin"; chatId: string; pinned: boolean; expectedRevision: number }
  | { type: "rename"; chatId: string; title: string; expectedRevision: number }
  | { type: "move"; chatId: string; projectId: string; expectedRevision: number }
  | { type: "archive"; chatId: string; archived: boolean; expectedRevision: number }
  | { type: "delete"; chatId: string; expectedRevision: number };
```

- [ ] **Step 1: Write navigation behavior tests**

Cover expanded/collapsed projects, selected and working labels, unread clear-on-select, keyboard navigation, pinned ordering, archive visibility, cross-project move, revision conflict, and deterministic close focus.

- [ ] **Step 2: Run RED**

Expected: ProjectSidebar absent and missing catalog actions.

- [ ] **Step 3: Extend project/chat catalog contracts**

Use exact revision/CAS. A chat binding includes `projectId`, `accountId`, optional `sessionId`, `archived`, `pinned`, `title`, and timestamps. Validate existing scalar limits.

- [ ] **Step 4: Implement selectors**

Sort pinned first, then projects by stable user order, chats by last activity. Session status annotates rows but never mutates catalog data.

- [ ] **Step 5: Build full and collapsed sidebars**

Use semantic navigation/tree/list patterns, original icons, tooltips, New chat, Search, Settings, and workspace/account footer. No personal email is synthesized.

- [ ] **Step 6: Run focused frontend and Rust project-catalog tests**

Also run existing Sidebar and project chat reducer/serialization suites.

- [ ] **Step 7: Commit**

```powershell
git add app/src/features/navigation app/src/domain/projectChats app/src-tauri/src/project_catalog.rs app/src/app/StudioApp.tsx
git commit -m "feat: add project and chat navigation"
```

### Task UI-04: Create parent-only transcript projections and streaming reducer

**Files:**
- Create: `app/src/entities/messages/types.ts`
- Create: `app/src/entities/messages/parentTranscriptReducer.ts`
- Create: `app/src/entities/messages/parentTranscriptReducer.test.ts`
- Create: `app/src/features/conversation/ParentConversation.tsx`
- Create: `app/src/features/conversation/ParentConversation.test.tsx`
- Create: `app/src/features/conversation/MessageActions.tsx`
- Create: `app/src/features/conversation/TurnActivity.tsx`
- Create: `app/src/features/conversation/conversation.css`
- Modify: `app/src/reducer.ts`
- Modify: `app/src/components/MessageList.tsx`

**Interfaces:**
- Consumes: parent-channel snapshot page and ordered parent-channel events only.
- Produces: bounded `ParentTranscriptState` with 300 content-row resident cap, cursor window, streaming metrics, and version pointers.

- [ ] **Step 1: Write hostile isolation and chronology tests**

```ts
it.each(["child_message", "child_tool", "child_reasoning", "child_system"])(
  "never renders %s in the parent transcript",
  type => expect(reduceParent(empty, event({ type, channel: "child" }))).toEqual(empty),
);
```

Also cover duplicate/reordered events, split Unicode, oversized blocks, unknown content, tool start after blocked, batched completion, history page gaps, and in-flight assistant retention at cap.

- [ ] **Step 2: Run RED**

Expected: parent reducer absent.

- [ ] **Step 3: Implement normalized parent message union**

Use explicit `channel: "parent"`; separate user, assistant, notice, edited-files, and turn-activity records. Do not accept generic `{type: string}` at the reducer boundary.

- [ ] **Step 4: Derive streaming metrics**

First-token latency is first assistant delta time minus accepted prompt time. Token/s is reported runtime value or derived from authoritative token deltas; otherwise null. Use monotonic presentation time.

- [ ] **Step 5: Build conversation presentation**

Readable max width, user bubbles, open assistant prose, one completion announcement, expandable worked-for steps, bounded edited-files card, empty suggestions, and archived read-only state.

- [ ] **Step 6: Preserve paging and omission truth**

Load older/latest pages by cursor; never fetch full 32 MiB history per page. Keep omission counts visible.

- [ ] **Step 7: Run focused/full reducer tests and commit**

```powershell
git add app/src/entities/messages app/src/features/conversation app/src/reducer.ts app/src/components/MessageList.tsx
git commit -m "feat: render isolated parent conversation"
```

### Task UI-05: Build the production composer and command admission states

**Files:**
- Create: `app/src/features/conversation/Composer.tsx`
- Create: `app/src/features/conversation/Composer.test.tsx`
- Create: `app/src/features/conversation/composerModel.ts`
- Create: `app/src/features/conversation/composerModel.test.ts`
- Create: `app/src/features/conversation/AttachmentChips.tsx`
- Create: `app/src/features/conversation/SlashMenu.tsx`
- Modify: `app/src/components/Composer.tsx`
- Modify: `app/src/shared/ipc/client.ts`

**Interfaces:**
- Consumes: active chat draft, compatibility/capabilities, model catalog, slash catalog, root-session command state.
- Produces intents: `sendPrompt`, `steer`, `followUp`, `abort`, `compact`, `fork`, `export`.

```ts
export type ComposerState =
  | { kind: "unavailable"; reason: string; draft: string }
  | { kind: "read_only"; draft: "" }
  | { kind: "idle"; draft: string; canSend: boolean }
  | { kind: "working"; draft: string; canQueue: boolean; canSteer: boolean; canAbort: boolean }
  | { kind: "submitting" | "aborting"; draft: string };
```

- [ ] **Step 1: Write composer state-machine tests**

States: idle-empty, idle-ready, submitting, working-empty, working-ready, aborting, unavailable, read-only. Test Enter/Ctrl+Enter/Shift+Enter, IME composition, draft isolation, tab switch, slash filtering, disabled capability reasons, attachment caps, drag leave, and stale submit response.

- [ ] **Step 2: Run RED**

Expected: new Composer absent.

- [ ] **Step 3: Implement bounded draft and token estimate**

Keep draft per chat. Token estimate is `ceil(codePoints/4)`, labeled approximate; clamp displayed estimate and never use it for admission.

- [ ] **Step 4: Implement attachments**

Allow only verified size/count/type metadata at UI stage. The later native command reopens/validates selected files. Do not append filenames to message text; represent attachments structurally.

- [ ] **Step 5: Implement model/thinking quick controls**

Quick picks are favorites/recent models from the normalized model catalog. Thinking choices come from profile capability. Disabled controls explain the unavailable feature.

- [ ] **Step 6: Implement slash registry**

Studio commands and runtime slash commands share a typed registry. `/usage` opens inspector usage; `/export` uses a save flow; `/fork` requires capability. Enter runs the selected command only after exact match/admission.

- [ ] **Step 7: Run tests and commit**

```powershell
git add app/src/features/conversation app/src/components/Composer.tsx app/src/shared/ipc/client.ts
git commit -m "feat: add capability-aware conversation composer"
```

### Task UI-06: Add branches, versions, message actions, and edited-file review

**Files:**
- Create: `app/src/features/conversation/branching.ts`
- Create: `app/src/features/conversation/branching.test.ts`
- Create: `app/src/features/conversation/VersionSwitcher.tsx`
- Create: `app/src/features/conversation/InlineMessageEditor.tsx`
- Create: `app/src/features/conversation/EditedFilesCard.tsx`
- Modify: `app/src/domain/projectChats/reducer.ts`
- Modify: `app/src/shared/ipc/client.ts`
- Test: `app/src/features/conversation/ParentConversation.test.tsx`

**Interfaces:**
- `editUserMessage` creates a new branch/version; it never rewrites daemon history.
- `regenerateAssistant` uses retry/fork capability.
- `openCanvas(messageId)` routes to SE-01.
- `openFileDiff(artifactRef)` routes to SE-01.
- `undo` remains unavailable without reversible patch authority.

```ts
export interface BranchResult {
  sourceChatId: string;
  chatId: string;
  sessionId: string;
  fromMessageId: string;
  version: number;
}
```

- [ ] **Step 1: Write branch/version tests**

Prove edit creates version N+1, prior version remains selectable, fork creates a new chat binding, regenerate is capability-gated, copy reports clipboard error, Canvas targets exact response, and Undo never emits a raw git command.

- [ ] **Step 2: Run RED**

Expected: missing modules/actions.

- [ ] **Step 3: Implement branch model**

Store branch metadata in Studio catalog and bind the new chat to the runtime fork result. Handle unknown outcome by creating no successful binding until reconciliation identifies the child session.

- [ ] **Step 4: Build action rows and inline editor**

Action rows are keyboard reachable even when visually subdued. Cancel restores original. Send validates bounded text and presents the newly created version.

- [ ] **Step 5: Build edited-files card**

Use structured file references/counts from activity/git projections. Review opens editor. Render Undo disabled with “Reversible patch unavailable” until a separate authority exists.

- [ ] **Step 6: Run focused tests and commit**

```powershell
git add app/src/features/conversation app/src/domain/projectChats/reducer.ts app/src/shared/ipc/client.ts
git commit -m "feat: add conversation branching and review actions"
```

### Task UI-07: Complete shell accessibility, responsive sheets, themes, and parity cutover

**Files:**
- Create: `app/src/shared/ui/Dialog.tsx`
- Create: `app/src/shared/ui/Popover.tsx`
- Create: `app/src/shared/ui/Tooltip.tsx`
- Create: `app/src/shared/ui/ToastQueue.tsx`
- Create: `app/src/shared/ui/ui.test.tsx`
- Create: `app/src/shared/ui/tokens.css`
- Create: `app/e2e/workspace-shell.spec.ts`
- Modify: `app/src/styles.css`
- Modify: `app/src/App.tsx`
- Modify: `app/e2e/support/browser-shell.ts`
- Modify: `app/e2e/axe-baseline.json`

**Interfaces:**
- Produces shared accessible overlay primitives and final default `StudioApp` composition.
- Consumes layout solver, settings, command registry, route state.

- [ ] **Step 1: Write RED browser scenarios**

At 640×400, 820×720, 1280×800, and 1600×1000 assert: no horizontal overflow; composer usable; sheets modal/inert/focus-restoring; both resizers keyboard operable when panes; center >=340 where physically possible; one banner/nav/main/complementary landmark; active chat semantics; dark/light/forced-colors/reduced-motion.

- [ ] **Step 2: Run RED**

Run strict browser shell on an isolated validated port. Expected failures reflect missing new shell behavior.

- [ ] **Step 3: Implement shared overlays and global shortcut priority**

Escape closes topmost overlay before abort. Ctrl+B/J toggle sidebar/inspector. Focus fallback cannot target disabled/removed controls.

- [ ] **Step 4: Implement semantic token themes**

Define surfaces, text, border, accent, state, focus, diff, chart, and code tokens for dark/light. Add forced-colors overrides and eliminate root inversion.

- [ ] **Step 5: Cut over `App.tsx`**

Make `StudioApp` default after unit/browser parity. Retain a temporary legacy import only for a single comparison test, then remove it in ACT-03.

- [ ] **Step 6: Run Impeccable bounded inspection at implementation time**

Capture desktop and narrow in one batch, fix material issues once, confirm once, run detector exactly once over changed UI targets, and request the fresh finish review described by the Impeccable workflow.

- [ ] **Step 7: Run exit gate and commit**

```powershell
cd app
npm test -- --maxWorkers=1 --no-file-parallelism
npm run check
npm run build
npm run test:browser-shell:strict
cd ..
git diff --check
git add app/src app/e2e
git commit -m "feat: switch to adaptive prime studio workspace"
```

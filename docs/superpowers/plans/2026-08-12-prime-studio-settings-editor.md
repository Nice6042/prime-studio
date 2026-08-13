# Prime Studio Settings, Editor, and Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the editor/Canvas, full settings route, account-wide usage, command palette, themes, and shared control system.

**Architecture:** Editor access uses identity-bound artifact references and conflict-aware native commands. Settings is a top-level route backed by typed Rust persistence. Account usage remains distinct from current-chat usage. One command registry drives palette, shortcuts, slash commands, and shortcut documentation.

**Tech Stack:** React/TypeScript, Rust/Tauri storage and filesystem authority, Vitest, Playwright/axe.

## Global Constraints

- No arbitrary renderer file paths or raw shell/git commands.
- Canvas edits affect Studio display revisions; they do not rewrite Harness transcript history.
- File saves require exact identity/content revision checks and explicit write authority.
- Account usage is Settings-only and never leaks into current-chat projections.
- CSV export prevents spreadsheet formula injection and uses a user-selected destination.
- Controls with unavailable capabilities are disabled with reasons and do not persist fake values.

---

### Task SE-01: Build identity-bound Diff, Edit, and Canvas

**Files:**
- Create: `app/src/entities/editor/types.ts`
- Create: `app/src/entities/editor/editorStore.ts`
- Create: `app/src/entities/editor/editorStore.test.ts`
- Create: `app/src/features/editor/EditorPane.tsx`
- Create: `app/src/features/editor/EditorPane.test.tsx`
- Create: `app/src/features/editor/DiffView.tsx`
- Create: `app/src/features/editor/EditView.tsx`
- Create: `app/src/features/editor/CanvasEditor.tsx`
- Create: `app/src/features/editor/editor.css`
- Create: `app/src-tauri/src/commands/editor.rs`
- Create: `app/src-tauri/tests/editor_authority.rs`
- Modify: `app/src-tauri/src/authority.rs`
- Modify: `app/src/features/shell/WorkspaceShell.tsx`

**Interfaces:**
- `ArtifactRef { brokerId, rootSessionId, artifactId, revision }` is native-minted.
- `readArtifact(ref) -> ArtifactSnapshot { content, diff, identity, revision, truncated }`.
- `saveArtifact(ref, expectedIdentity, expectedRevision, content) -> SaveResult`.
- `CanvasRef { chatId, messageId, displayRevision }` never crosses into filesystem authority.

- [ ] **Step 1: Write native RED tests**

Reject forged broker/session/artifact IDs, wrong revision, wrong identity, path swap/reparse/hardlink, oversized content/diff, binary edit, stale save, cross-account ref, and write when authority unavailable.

- [ ] **Step 2: Write frontend RED tests**

Cover open/close, Diff/Edit, line/gutter semantics, dirty state, save success/conflict/error, tab/chat switch, Canvas apply/cancel, per-session buffers, narrow sheet mode, and disabled save.

- [ ] **Step 3: Run RED**

Expected: editor commands/components absent.

- [ ] **Step 4: Implement structured diff projection**

Native side returns bounded rows `context | add | delete` with old/new line numbers and display text. Renderer never parses an unbounded raw patch.

- [ ] **Step 5: Implement conflict-aware save**

Reopen from held authority, compare identity/revision, write atomically within authorized workspace, and return saved/conflict/unknown outcome. Do not provide generalized write-file IPC.

- [ ] **Step 6: Implement Canvas**

Create an editable display revision, preserve original Harness message, show revision switcher, and apply only to Studio presentation/export.

- [ ] **Step 7: Run focused Rust/frontend/browser tests and commit**

```powershell
git add app/src/entities/editor app/src/features/editor app/src-tauri/src/commands/editor.rs app/src-tauri/tests/editor_authority.rs app/src-tauri/src/authority.rs app/src/features/shell/WorkspaceShell.tsx
git commit -m "feat: add secure diff editor and canvas"
```

### Task SE-02: Replace modal settings with typed routed settings

**Files:**
- Create: `app/src/features/settings/SettingsShell.tsx`
- Create: `app/src/features/settings/SettingsShell.test.tsx`
- Create: `app/src/features/settings/settingsRegistry.ts`
- Create: `app/src/features/settings/settingsRegistry.test.ts`
- Create: `app/src/features/settings/GeneralSettings.tsx`
- Create: `app/src/features/settings/AppearanceSettings.tsx`
- Create: `app/src/features/settings/ComposerSettings.tsx`
- Create: `app/src/features/settings/HarnessSettings.tsx`
- Create: `app/src/features/settings/ModelsSettings.tsx`
- Create: `app/src/features/settings/IntegrationsSettings.tsx`
- Create: `app/src/features/settings/SecuritySettings.tsx`
- Create: `app/src/features/settings/ShortcutsSettings.tsx`
- Create: `app/src/features/settings/AboutSettings.tsx`
- Create: `app/src/features/settings/settings.css`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/components/settingsSections.ts`
- Modify: `app/src/types.ts`
- Modify: `app/src-tauri/src/commands/settings.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Settings registry fields: id, group, label, description, keywords, route, capability, policy, default, decoder.
- Persistence uses schema-versioned typed settings and atomic write.
- Route groups: Preferences; Usage; AI & models; Tools & integrations; Admin & safety.

```ts
export interface SettingDefinition<T> {
  id: SettingId;
  group: SettingsGroup;
  route: SettingsSectionId;
  label: string;
  description: string;
  keywords: readonly string[];
  defaultValue: T;
  decode(value: unknown): T;
  availability(state: StudioAppState): { enabled: boolean; reason?: string; lockedBy?: string };
}
```

- [ ] **Step 1: Write registry and persistence tests**

Test unique IDs/routes, searchable labels/keywords, default validity, setting decoder closure, policy lock, migration from current keys, unknown key rejection, interrupted write, and stale revision.

- [ ] **Step 2: Run RED**

Expected: registry/new shell absent.

- [ ] **Step 3: Implement top-level settings route**

Back to chat preserves mounted chat/session state and previous focus. Left navigation is searchable, grouped, keyboard navigable, and narrow-responsive.

- [ ] **Step 4: Implement pages**

General: editor/shell/language where supported. Appearance: theme/density/motion/panel defaults. Composer: send shortcut/suggestions/token estimate/drafts. Harness: concurrency/max turns/retry/context discovery with capability/policy truth. Models: catalog/provider/account/thinking/context. Integrations: tools/Git/environments projections. Security: runtime identity/storage/authority/diagnostics. Shortcuts: generated registry. About: exact Studio/Harness/profile/licenses/update facts.

- [ ] **Step 5: Implement locked settings**

A managed row receives `{ locked: true, source, reason }`; controls are disabled, Save is not called, and a concise policy explanation is available.

- [ ] **Step 6: Preserve hardened Accounts**

Embed existing Accounts behavior under the new route; do not rewrite transactional removal in this UI task.

- [ ] **Step 7: Run focused/full settings tests and commit**

```powershell
git add app/src/features/settings app/src/components/Settings.tsx app/src/components/settingsSections.ts app/src/types.ts app/src-tauri/src
git commit -m "feat: add routed typed settings"
```

### Task SE-03: Move account-wide Usage into Settings and add safe CSV export

**Files:**
- Create: `app/src/entities/usage/accountUsage.ts`
- Create: `app/src/entities/usage/accountUsage.test.ts`
- Create: `app/src/features/settings/AccountUsageSettings.tsx`
- Create: `app/src/features/settings/AccountUsageSettings.test.tsx`
- Create: `app/src/features/settings/AccountUsageChart.tsx`
- Create: `app/src-tauri/src/commands/usage.rs`
- Create: `app/src-tauri/tests/usage_export.rs`
- Modify: `app/src/components/Usage.tsx`
- Modify: `app/src/features/settings/settingsRegistry.ts`

**Interfaces:**
- Consumes existing bounded account usage rows, Codex subscription projection, and optional attribution dimensions.
- `exportAccountUsageCsv(request, destinationToken) -> ExportResult`.
- Produces 7/30/90 day report, stats, daily series, provider/model/project breakdowns when supported.

```rust
#[tauri::command]
async fn export_account_usage_csv(
    state: State<'_, AppState>,
    request: ExportAccountUsageRequest,
) -> Result<ExportResult, UsageExportError>;
```

- [ ] **Step 1: Write accounting tests**

Test shared agent directories, provider filtering, local-day/DST windows, no double counting, unknown provider/model/project, missing cost, stale subscription snapshot, invalid timestamp, max rows, and unrelated current-chat state.

- [ ] **Step 2: Write CSV hostile tests**

Reject arbitrary destination, symlink/reparse swap, overwrite without confirmation, oversized export, invalid UTF-8 fields, and formula-leading values. Expected escaped cells prefix `'\t\r\n=+-@` cases safely and produce UTF-8 CSV with deterministic column order.

- [ ] **Step 3: Run RED**

Expected: projector/export command absent.

- [ ] **Step 4: Implement report selectors and page**

Refresh is single-flight; 7/30/90 swaps all data. Charts use accessible SVG plus table/summary. Legend toggles affect presentation only, not totals.

- [ ] **Step 5: Implement native CSV save**

Use Tauri save dialog token, bounded rows, RFC 4180 quoting, formula-injection defense, atomic create/replace policy, and explicit result path only after success.

- [ ] **Step 6: Remove account usage modal entry points**

Every account-wide link routes to Settings → Usage. Inspector link is tested separately to preserve scope.

- [ ] **Step 7: Run focused tests and commit**

```powershell
git add app/src/entities/usage app/src/features/settings app/src-tauri/src/commands/usage.rs app/src-tauri/tests/usage_export.rs app/src/components/Usage.tsx
git commit -m "feat: add account usage settings and export"
```

### Task SE-04: Centralize commands, shortcuts, slash actions, and search palette

**Files:**
- Create: `app/src/entities/commands/commandRegistry.ts`
- Create: `app/src/entities/commands/commandRegistry.test.ts`
- Create: `app/src/features/command-palette/CommandPalette.tsx`
- Create: `app/src/features/command-palette/CommandPalette.test.tsx`
- Create: `app/src/features/command-palette/searchIndex.ts`
- Create: `app/src/features/command-palette/searchIndex.test.ts`
- Modify: `app/src/components/Palette.tsx`
- Modify: `app/src/app/StudioApp.tsx`
- Modify: `app/src/features/conversation/SlashMenu.tsx`
- Modify: `app/src/features/settings/ShortcutsSettings.tsx`

**Interfaces:**
- `StudioCommand { id, label, group, shortcuts, keywords, availability(state), run(ctx) }`.
- Search index contains bounded chat titles and message excerpts, never credentials/tool secrets/full unbounded transcripts.
- One registry feeds palette, shortcuts, slash actions, menus, and Settings.

- [ ] **Step 1: Write registry tests**

Assert unique IDs/shortcuts, no unreachable command, capability/policy reason, overlay priority, exact top result, disabled Enter no-op with explanation, and all displayed shortcuts registered.

- [ ] **Step 2: Write bounded search tests**

Cover Actions/Chats/Messages grouping, project hint, Unicode case, huge messages, redacted blocks, archive filters, stale index generation, 4,096 result/index caps, and no child/private transcript in global message search unless a future explicit scope is designed.

- [ ] **Step 3: Run RED**

Expected: central registry/index absent.

- [ ] **Step 4: Implement registry and global shortcut dispatcher**

Priority: text IME → topmost overlay → active editor → active chat → global. Esc closes overlay before abort. Ctrl+N/K/,/B/J come from registry.

- [ ] **Step 5: Implement palette**

600px desktop dialog, responsive narrow sheet, grouped results, keyboard wrap, stable active descendant, snippets, Esc, and focus restore.

- [ ] **Step 6: Replace duplicate command closures**

Chat header, sidebar, composer slash menu, menus, and Shortcuts page consume registry entries.

- [ ] **Step 7: Run focused/full tests and commit**

```powershell
git add app/src/entities/commands app/src/features/command-palette app/src/components/Palette.tsx app/src/app/StudioApp.tsx app/src/features/conversation/SlashMenu.tsx app/src/features/settings/ShortcutsSettings.tsx
git commit -m "refactor: centralize studio commands and search"
```

### Task SE-05: Finish semantic themes and reusable controls

**Files:**
- Create: `app/src/shared/ui/Button.tsx`
- Create: `app/src/shared/ui/Field.tsx`
- Create: `app/src/shared/ui/Select.tsx`
- Create: `app/src/shared/ui/SegmentedControl.tsx`
- Create: `app/src/shared/ui/Switch.tsx`
- Create: `app/src/shared/ui/Disclosure.tsx`
- Create: `app/src/shared/ui/DataTable.tsx`
- Create: `app/src/shared/ui/controls.test.tsx`
- Modify: `app/src/shared/ui/tokens.css`
- Modify: `app/src/styles.css`
- Create: `app/e2e/settings-editor.spec.ts`
- Modify: `app/e2e/support/browser-shell.ts`

**Interfaces:**
- Shared controls implement default/hover/focus/active/disabled/loading/error and forced-colors behavior.
- No component introduces one-off color/radius/spacing tokens.

```ts
export type ControlState =
  | { kind: "enabled" }
  | { kind: "loading"; label: string }
  | { kind: "disabled"; reason: string }
  | { kind: "error"; message: string };
```

- [ ] **Step 1: Write control matrix tests**

Keyboard, label/description/error relationships, disabled/loading, switch state, select popup, segmented single selection, disclosure state, table captions/sorting semantics, focus restoration, and forced-colors.

- [ ] **Step 2: Write browser RED scenarios**

Settings General, Appearance light/system, Harness policy lock, Models unavailable, Security runtime identity, Shortcuts, About, account Usage, editor Diff/Edit/Canvas, palette messages, narrow settings/editor.

- [ ] **Step 3: Run RED then implement controls/tokens**

Use one Segoe UI/system stack, semantic surfaces, 1px dividers, restrained violet selection/focus, original icon set, and standard scrollbars.

- [ ] **Step 4: Replace duplicated controls in changed surfaces**

Do not rewrite untouched hardened dialogs solely for visual purity; migrate them when their owning feature changes.

- [ ] **Step 5: Perform bounded visual QA at implementation time**

Capture settings, account usage, editor, and palette in one desktop/narrow batch; one fix batch, one confirmation, detector once, independent finish review.

- [ ] **Step 6: Run exit gate and commit**

```powershell
cd app
npm test -- src/features/settings src/features/editor src/features/command-palette src/shared/ui
npm run build
npm run test:browser-shell:strict
cd ..
git diff --check
git add app/src app/e2e
git commit -m "feat: finish studio settings and editor surfaces"
```

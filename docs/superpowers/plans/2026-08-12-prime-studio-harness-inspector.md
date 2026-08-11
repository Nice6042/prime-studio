# Prime Studio Harness Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete right-side Harness inspector: overview, selected-child detail, current-chat usage, activity, real error/retry states, and contextual extension prompts.

**Architecture:** The inspector is a route-driven projection of the active root session. Parent and child channels use separate stores. Usage is computed from the root session and attributed descendants only. Activity is append-only and cursor-bounded. Optional features render from capabilities.

**Tech Stack:** React/TypeScript, SHP projections, Vitest, Playwright/axe.

## Global Constraints

- Nothing in this plan enables live execution; use fixture/fake-adapter projections.
- Child transcript/activity/files never enter the parent conversation store or DOM.
- Current-chat usage excludes every unrelated root session.
- Cost, progress, quota, context sources, and tools may be unavailable; never invent values.
- Extension prompts are contextual overlays, not an approvals dashboard.

---

### Task HI-01: Build Harness overview routes and operational lists

**Files:**
- Create: `app/src/features/harness/HarnessInspector.tsx`
- Create: `app/src/features/harness/HarnessInspector.test.tsx`
- Create: `app/src/features/harness/InspectorTabs.tsx`
- Create: `app/src/features/harness/HarnessOverview.tsx`
- Create: `app/src/features/harness/AgentRow.tsx`
- Create: `app/src/features/harness/QueueSection.tsx`
- Create: `app/src/features/harness/ToolsSection.tsx`
- Create: `app/src/features/harness/ContextSection.tsx`
- Create: `app/src/features/harness/inspectorStore.ts`
- Create: `app/src/features/harness/harness.css`
- Modify: `app/src/features/shell/WorkspaceShell.tsx`

**Interfaces:**
- Consumes: active `RootSessionSnapshot`, `HarnessCompatibility`, `InspectorRoute`.
- Produces intents: select tab/child, compact, run queue item, toggle tool, retry/dismiss error, close inspector.

```ts
export function selectInspector(
  state: InspectorState,
  intent: InspectorIntent,
): InspectorState;
```

- [ ] **Step 1: Write overview projection tests**

Cover ready, degraded, read-only, disconnected, no-session, no-children, active/done children, unknown progress, queue, tools, context, overload, silent worker death, and unseen activity.

- [ ] **Step 2: Run RED**

Expected: inspector modules absent.

- [ ] **Step 3: Implement route store**

Keep route per chat. If selected child disappears, route returns to overview with a status toast. Tab switch never discards child/activity data.

- [ ] **Step 4: Implement overview**

Render main agent with monotonic elapsed display, current-chat stats, active/done children, and capability-aware Queue/Tools/Context accordions. Reuse one presentation clock.

- [ ] **Step 5: Implement admitted actions**

Compact remains pending until a compaction event/snapshot changes context. Run-now and tool toggle are disabled when capability or policy is absent. Retry is available only for idempotent/reconciled failures.

- [ ] **Step 6: Add error truth**

Silent worker exit becomes `failed`, not done. One auto-retry occurs only when policy is enabled and the runtime reports a retry-safe closure. Provider overload retains exact safe error code and retry eligibility.

- [ ] **Step 7: Run focused tests and commit**

```powershell
git add app/src/features/harness app/src/features/shell/WorkspaceShell.tsx
git commit -m "feat: add harness overview inspector"
```

### Task HI-02: Add selected-child private Chat, Activity, and Files

**Files:**
- Create: `app/src/entities/agents/childStore.ts`
- Create: `app/src/entities/agents/childStore.test.ts`
- Create: `app/src/features/harness/ChildDetail.tsx`
- Create: `app/src/features/harness/ChildDetail.test.tsx`
- Create: `app/src/features/harness/ChildChat.tsx`
- Create: `app/src/features/harness/ChildActivity.tsx`
- Create: `app/src/features/harness/ChildFiles.tsx`
- Modify: `app/src/features/harness/HarnessInspector.tsx`
- Modify: `app/src/shared/ipc/client.ts`

**Interfaces:**
- Consumes: `ChildAgentSummary`; lazy `ChildSnapshotPage`, `ChildActivityPage`, `ChildFilePage`.
- Produces: open/back/close/tab/older/latest/stop-child intents.
- `stopChild(rootSessionId, childId, expectedGeneration)` is capability-gated and result-bound.

```ts
export interface ChildPageKey {
  rootSessionId: string;
  runtimeGeneration: string;
  childId: string;
  tab: "chat" | "activity" | "files";
  cursor: string | null;
}
```

- [ ] **Step 1: Write structural isolation tests**

Render parent conversation and selected child together, then assert no child sentinel exists under the main conversation landmark and every child sentinel exists only under the complementary inspector.

- [ ] **Step 2: Write child lifecycle tests**

Cover queued/running/done/error/cancelled, selection race, removed child, stale page, pagination, missing model/provider/context, file open, Stop confirmation, stop rejection, and focus restoration.

- [ ] **Step 3: Run RED**

Expected: missing child store/detail.

- [ ] **Step 4: Implement lazy child store**

Do not fetch transcripts until selected. Key pages by root session, runtime generation, child ID, tab, and cursor. Cap resident child rows and discard stale responses.

- [ ] **Step 5: Build child detail**

Header contains status, elapsed, provider/model facts, task, context, Chat/Activity/Files tabs, locked composer explanation, and Stop only while stoppable.

- [ ] **Step 6: Wire files to editor route**

Pass a closed `ArtifactRef`; never pass renderer-supplied arbitrary paths.

- [ ] **Step 7: Run focused tests and commit**

```powershell
git add app/src/entities/agents app/src/features/harness app/src/shared/ipc/client.ts
git commit -m "feat: inspect private child agent work"
```

### Task HI-03: Implement current-chat Usage and accounting invariants

**Files:**
- Create: `app/src/entities/usage/currentChatUsage.ts`
- Create: `app/src/entities/usage/currentChatUsage.test.ts`
- Create: `app/src/features/harness/ChatUsage.tsx`
- Create: `app/src/features/harness/ChatUsage.test.tsx`
- Create: `app/src/features/harness/TokenTurnChart.tsx`
- Modify: `app/src/features/harness/HarnessInspector.tsx`
- Modify: `app/src/types.ts`

**Interfaces:**
- Consumes: usage entries bound to one root session and descendants with attribution IDs.
- Produces: context, tokens, turns, elapsed, optional cost, per-turn series, context utilization samples, parent/children/tools contribution, token types.

- [ ] **Step 1: Write non-double-counting tests**

```ts
expect(projectUsage(entries, { rootSessionId: "root-a" }).totalTokens).toBe(100);
expect(projectUsage(entries, { rootSessionId: "root-a" }).children.tokens).toBe(30);
expect(projectUsage(entries, { rootSessionId: "root-a" }).parent.tokens).toBe(70);
expect(projectUsage(entries, { rootSessionId: "root-a" }).bySession).not.toHaveProperty("root-b");
```

Test duplicate attribution, missing cost, reset snapshot, compaction, child retry, cache categories, out-of-order usage, and unrelated account/session contamination.

- [ ] **Step 2: Run RED**

Expected: projector absent.

- [ ] **Step 3: Implement usage projector**

Deduplicate by runtime usage event ID; bind child usage to one root; enforce `parent + children == total` and category sums; represent unknown cost as null. Context utilization is context tokens/window, not provider quota.

- [ ] **Step 4: Build current-chat usage UI**

Context card, stats, tokens-by-turn, utilization sparkline, contribution and token-type tables. Charts have table/summary equivalents. “Account-wide usage” routes to Settings → Usage.

- [ ] **Step 5: Add scope regression**

A fixture with two projects, accounts, and root sessions must show only the active chat in the inspector, while Settings later shows all account data.

- [ ] **Step 6: Run focused tests and commit**

```powershell
git add app/src/entities/usage app/src/features/harness app/src/types.ts
git commit -m "feat: report current chat harness usage"
```

### Task HI-04: Build the bounded Activity feed

**Files:**
- Create: `app/src/entities/activity/activityReducer.ts`
- Create: `app/src/entities/activity/activityReducer.test.ts`
- Create: `app/src/features/harness/ActivityFeed.tsx`
- Create: `app/src/features/harness/ActivityFeed.test.tsx`
- Create: `app/src/features/harness/ActivityRow.tsx`
- Modify: `app/src/features/harness/HarnessInspector.tsx`
- Modify: `app/src/entities/chats/chatStore.ts`

**Interfaces:**
- Consumes: bounded normalized activity events for root and children.
- Produces: filter selectors, Today/Yesterday/dated grouping, expanded row, unseen cursor.
- File and child references use typed IDs, never arbitrary paths.

```ts
export type ActivityItem =
  | { kind: "agent"; id: string; emittedAtMs: number; childId?: string; title: string }
  | { kind: "tool"; id: string; emittedAtMs: number; toolId: string; status: "running" | "blocked" | "succeeded" | "failed" }
  | { kind: "file"; id: string; emittedAtMs: number; artifactRef: ArtifactRef; title: string };
```

- [ ] **Step 1: Write activity reducer tests**

Cover agents/tools/files filters, stable chronology, local-date boundaries, future/invalid timestamps, dedupe, retention cap, blocked tools, command redaction, file reference, child route, and inactive-chat unseen state.

- [ ] **Step 2: Run RED**

Expected: reducer/feed absent.

- [ ] **Step 3: Implement activity model**

Retain a bounded cursor window and total omitted count. Group at render time using locale; store epoch milliseconds. Copy uses redacted command text only.

- [ ] **Step 4: Build feed**

Use filter chips, group headings, expandable tool detail, status/duration, affected files, and View subagent. Clear unseen cursor only when Activity is visible for the active chat.

- [ ] **Step 5: Run focused tests and commit**

```powershell
git add app/src/entities/activity app/src/features/harness app/src/entities/chats/chatStore.ts
git commit -m "feat: add harness activity feed"
```

### Task HI-05: Project genuine extension UI requests contextually

**Files:**
- Create: `app/src/entities/extensionUi/extensionUiStore.ts`
- Create: `app/src/entities/extensionUi/extensionUiStore.test.ts`
- Create: `app/src/features/harness/ExtensionRequestDialog.tsx`
- Create: `app/src/features/harness/ExtensionRequestDialog.test.tsx`
- Modify: `app/src/shared/ipc/client.ts`
- Modify: `app/src/app/StudioApp.tsx`

**Interfaces:**
- Consumes: verified `ExtensionUiRequest` with request/session identity, method `confirm | select | input | editor`, deadline, title/message/options.
- Produces: one bounded response or timeout/cancel.
- Does not expose credential values or create a persistent approval queue.

```ts
export type ExtensionUiResponse =
  | { requestId: string; status: "submitted"; value: boolean | string | readonly string[] }
  | { requestId: string; status: "cancelled" | "timed_out" };
```

- [ ] **Step 1: Write request lifecycle tests**

Cover confirm/select/input/editor, unknown method, expired request, inactive chat, app restart, duplicate request ID, response replay, renderer close, malicious HTML, huge options, and child-origin request labeling.

- [ ] **Step 2: Run RED**

Expected: store/dialog absent.

- [ ] **Step 3: Implement exact queue semantics**

Only the topmost current request displays. Requests remain bound to session/generation. Expiry responds timeout. Closing responds cancel when supported. No request is interpreted as approval for future calls.

- [ ] **Step 4: Build contextual dialog**

Copy identifies requesting session/child/tool and exact requested action. Use text rendering only. Keep ordinary subagent rows free of approval badges.

- [ ] **Step 5: Run focused/full inspector tests and browser scenarios**

Add scenarios for no prompt during normal subagent work and one real prompt when fixture emits `extension_ui_request`.

- [ ] **Step 6: Commit**

```powershell
git add app/src/entities/extensionUi app/src/features/harness/ExtensionRequestDialog* app/src/shared/ipc/client.ts app/src/app/StudioApp.tsx
git commit -m "feat: handle contextual harness extension requests"
```

### Task HI-06: Inspector responsive, accessibility, and visual verification

**Files:**
- Create: `app/e2e/harness-inspector.spec.ts`
- Modify: `app/e2e/support/browser-shell.ts`
- Modify: `app/src/features/harness/harness.css`
- Modify: `app/e2e/axe-baseline.json`

**Interfaces:**
- Exercises all HI surfaces through deterministic fixture states.

- [ ] **Step 1: Write browser RED scenarios**

Desktop overview, selected child each tab, current-chat usage, activity expanded row, extension request, degraded/offline, and 640×400/820×720 inspector sheets.

- [ ] **Step 2: Assert behavioral completeness**

Verify pane resize persists, close/reopen, focus trap/restore, no parent contamination, chart alternative, scroll reachability, no clipping, unseen clear, and no zero/fake unavailable values.

- [ ] **Step 3: Run RED then implement CSS/semantics**

Use established shell tokens and standard controls. Keep dense metadata >=11px and primary readable content >=13px.

- [ ] **Step 4: Perform bounded visual QA at implementation time**

Capture overview, child, usage, activity at desktop plus selected-child narrow in one batch; fix material issues once; confirm once; run Impeccable detector exactly once and independent finish review.

- [ ] **Step 5: Run exit gate and commit**

```powershell
cd app
npm test -- src/features/harness src/entities/agents src/entities/usage src/entities/activity src/entities/extensionUi
npm run build
npm run test:browser-shell:strict
cd ..
git diff --check
git add app/src/features/harness app/e2e
git commit -m "test: verify adaptive harness inspector"
```

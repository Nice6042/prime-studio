import { STUDIO_ACTIONS, type StudioActionId } from "./studioOperations";

export type ImplementationStatus = "complete" | "partial" | "placeholder" | "missing" | "explicitly_unavailable";

export interface PackageFeatureAcceptance {
  readonly id: string;
  readonly requirement: string;
  readonly current: ImplementationStatus;
  readonly interactive: boolean;
  readonly actions: readonly StudioActionId[];
}

const row = (id: string, requirement: string, current: ImplementationStatus, actions: readonly StudioActionId[] = []): PackageFeatureAcceptance => Object.freeze({ id, requirement, current, interactive: actions.length > 0, actions });

export const FEATURE_ACCEPTANCE: readonly PackageFeatureAcceptance[] = Object.freeze([
  row("SH-01", "40px desktop title bar with app identity, five menus, and real window controls", "complete", ["surface.popover.toggle", "window.minimize", "window.maximize-toggle", "window.close"]),
  row("SH-02", "persistent sidebar, parent conversation, optional editor, and Harness inspector topology", "complete"),
  row("SH-03", "sidebar resizes 210–380px, defaults to 264px, and resets on double click", "complete", ["layout.sidebar.resize", "layout.sidebar.reset"]),
  row("SH-04", "inspector resizes 300–600px, defaults to 384px, and resets on double click", "complete", ["layout.inspector.resize", "layout.inspector.reset"]),
  row("SH-05", "center keeps a 340px minimum plus handle and border budget", "complete"),
  row("SH-06", "editor uses 280–600px up to 46 percent and may displace the inspector", "complete", ["layout.editor.resize", "layout.editor.toggle"]),
  row("SH-07", "narrow layouts use a 52px sidebar rail and sheet/replacement panel routes", "complete", ["layout.sidebar.toggle", "layout.inspector.toggle"]),
  row("SH-08", "24px bottom status reports runtime, model, thinking, context, latency, throughput, and overload", "complete"),
  row("SH-09", "dark, light, and system themes use semantic tokens", "complete", ["settings.preference.set"]),
  row("SH-10", "reduced motion controls pulse, blink, and pane/popover transitions", "complete", ["settings.preference.set"]),

  row("NV-01", "New chat button and Ctrl+N create a catalog chat and select it", "complete", ["catalog.chat.create"]),
  row("NV-02", "Search row opens the global command and content palette", "complete", ["palette.open"]),
  row("NV-03", "pinned section and pin toggle persist truthfully", "complete", ["catalog.chat.pin-toggle"]),
  row("NV-04", "expandable project tree groups chats and preserves expansion", "complete", ["catalog.project.toggle", "catalog.chat.select"]),
  row("NV-05", "Archived chats route lists and restores archived records", "complete", ["route.archived.open", "catalog.project.restore", "catalog.chat.restore"]),
  row("NV-06", "inactive-chat completion sets unread and selection clears it", "complete", ["catalog.chat.unread-clear"]),
  row("NV-07", "chat rows show authoritative working, live, and error status", "complete"),
  row("NV-08", "footer reports configured workspace identity and opens its menu", "complete", ["surface.popover.toggle", "workspace.switch", "route.settings.open", "workspace.sign-out"]),
  row("NV-09", "collapsed rail preserves expand, new, search, settings, avatar actions and tooltips", "complete", ["layout.sidebar.toggle", "catalog.chat.create", "palette.open", "route.settings.open"]),
  row("NV-10", "rename, duplicate, move, archive, restore, and delete are durable catalog commands", "complete", ["catalog.chat.rename", "catalog.chat.duplicate", "catalog.chat.move", "catalog.chat.archive", "catalog.chat.restore", "catalog.chat.delete"]),

  row("CV-01", "header breadcrumb, chat switcher, pin, chat menu, and inspector reopen are functional", "complete", ["surface.popover.toggle", "catalog.chat.select", "catalog.chat.pin-toggle", "layout.inspector.toggle"]),
  row("CV-02", "main transcript renders parent-channel messages only", "complete"),
  row("CV-03", "bounded assistant streaming has cursor, pending, active, stopped, and completed states", "complete"),
  row("CV-04", "first-token latency and tokens per second come from admitted event chronology", "partial"),
  row("CV-05", "editing a user message creates and selects a new immutable version", "partial", ["conversation.user-edit.start", "conversation.user-edit.cancel", "conversation.user-version.create"]),
  row("CV-06", "user and assistant version selectors preserve independent version positions", "partial", ["conversation.user-version.select", "conversation.assistant-version.select"]),
  row("CV-07", "branch from a message creates a new chat bound to a Harness branch", "complete", ["conversation.branch.create"]),
  row("CV-08", "copy response reports clipboard success or failure", "complete", ["conversation.response.copy"]),
  row("CV-09", "Canvas opens the selected response and applies a Studio display revision", "partial", ["conversation.canvas.open", "editor.canvas.apply"]),
  row("CV-10", "edited-files card shows bounded paths and opens Review/editor", "partial", ["conversation.files.review", "activity.file.open"]),
  row("CV-11", "Undo edited files is visibly unavailable without verified reversible patch authority", "explicitly_unavailable", ["conversation.files.undo"]),
  row("CV-12", "Worked-for disclosure groups real steps under the owning root turn", "partial", ["conversation.work-details.toggle"]),
  row("CV-13", "empty conversation suggestions fill but never send the draft", "complete", ["conversation.suggestion.fill"]),
  row("CV-14", "history pages by cursor with truncation and omission metadata", "complete", ["conversation.history.page"]),
  row("CV-15", "archived transcripts are read-only and may fork to continue", "partial", ["conversation.archive-fork"]),

  row("CP-01", "composer grows to a bounded height and scrolls beyond it", "complete"),
  row("CP-02", "add menu, picker, drag/drop, chips, removal, and bounded admission are wired", "partial", ["surface.popover.toggle", "composer.attachment.pick", "composer.attachment.drop", "composer.attachment.remove"]),
  row("CP-03", "quick model pills and catalog dropdown select a verified model", "partial", ["composer.model.select"]),
  row("CP-04", "thinking dropdown uses supported levels for the selected model", "partial", ["composer.thinking.select"]),
  row("CP-05", "send, stop, queue, follow-up, and steer return explicit admission outcomes", "partial", ["harness.session.prompt", "harness.session.abort", "harness.session.follow-up", "harness.session.steer"]),
  row("CP-06", "slash autocomplete filters above the composer and supports keyboard execution", "partial", ["composer.slash.select", "composer.slash.execute"]),
  row("CP-07", "/model /effort /compact /fork /new /usage /export all map to real or explicit unavailable actions", "partial", ["composer.model.select", "composer.thinking.select", "harness.session.compact", "conversation.branch.create", "catalog.chat.create", "usage.account.open", "harness.session.export"]),
  row("CP-08", "draft token estimate is local, approximate, and visually distinct from runtime counts", "complete"),
  row("CP-09", "Enter versus Ctrl+Enter is persisted and safe for IME and multiline input", "complete", ["settings.preference.set"]),
  row("CP-10", "text and attachment drafts are isolated and retained per chat", "complete", ["composer.draft.change"]),
  row("CP-11", "mic control exposes an explicit privacy-safe unavailable state until voice exists", "explicitly_unavailable", ["composer.voice.start", "composer.voice.stop"]),

  row("HR-01", "Harness, Usage, and Activity tabs preserve a per-chat route", "complete", ["harness.tab.select"]),
  row("HR-02", "compatibility, demonstration, degraded, read-only, and unavailable banners are truthful", "partial"),
  row("HR-03", "main agent state and elapsed time come from the attached root session", "partial"),
  row("HR-04", "This chat context, tokens, turns, and Compact use active-session truth", "partial", ["harness.session.compact"]),
  row("HR-05", "active and done child lists reconcile by child identity", "complete", ["harness.child.open"]),
  row("HR-06", "child progress shows reported numeric progress or an indeterminate state", "complete"),
  row("HR-07", "queue accordion supports run-now and removal with explicit outcomes", "partial", ["surface.accordion.toggle", "harness.queue.run-now", "harness.queue.remove"]),
  row("HR-08", "tools accordion reports and changes capability-backed enablement", "partial", ["surface.accordion.toggle", "harness.tool.set-enabled"]),
  row("HR-09", "context accordion lists real context sources and opens supported ones", "complete", ["surface.accordion.toggle", "harness.context-source.open"]),
  row("HR-10", "overload banner retries idempotently or dismisses only the local presentation", "partial", ["harness.overload.retry", "harness.overload.dismiss"]),
  row("HR-11", "authoritative worker failure shows the public lifecycle reason, one retry, recovery, and terminal failure", "complete"),
  row("HR-12", "child selection never inserts child transcript into the parent conversation", "complete", ["harness.child.open"]),
  row("HR-13", "child status, elapsed, provider, model, task, context, and token facts are projected", "partial"),
  row("HR-14", "child Chat, Activity, and Files tabs load their own paged data", "partial", ["harness.child.tab-select", "harness.child.transcript-page"]),
  row("HR-15", "child composer is visibly locked with a Harness-owned explanation", "complete"),
  row("HR-16", "Stop child invokes verified cancellation and reconciles its actual result", "partial", ["harness.child.stop"]),
  row("HR-17", "Back and close restore focus to the selected child row", "complete", ["harness.child.back"]),
  row("HR-18", "extension prompts exist only for verified runtime extension requests; no approvals dashboard", "complete", ["harness.extension.respond"]),

  row("CU-01", "right-panel usage contains only the active root session and its attributed children/tools", "complete"),
  row("CU-02", "context card includes authoritative window, use, and freshness", "partial"),
  row("CU-03", "tokens, turns, elapsed, and cost use real values or explicit unavailable", "partial"),
  row("CU-04", "finalized tokens-by-turn grouped chart has an accessible table equivalent", "complete"),
  row("CU-05", "utilization sparkline reports context samples rather than provider quota", "complete"),
  row("CU-06", "contribution breakdown avoids double counting main, child, and tool tokens", "partial"),
  row("CU-07", "token-type table separates input, cached input, output, and tool results", "complete"),
  row("CU-08", "Account-wide selection routes to Settings Usage without changing inspector scope", "complete", ["usage.account.open"]),
  row("AC-01", "Activity filters All, Agents, Tools, and Files", "complete", ["activity.filter.select"]),
  row("AC-02", "activity groups timestamps into Today and Yesterday using local presentation time", "complete"),
  row("AC-03", "tool rows expand to redacted command, status, duration, and copy", "partial", ["activity.row.toggle", "activity.command.copy"]),
  row("AC-04", "affected file rows open identity-bound editor content", "complete", ["activity.file.open"]),
  row("AC-05", "View subagent selects its private inspector route", "complete", ["activity.child.open"]),
  row("AC-06", "unseen Activity dot is content-evidence-backed and clears on visit", "complete", ["activity.seen.mark"]),

  row("ED-01", "split editor header shows path, counts, mode, and close", "partial", ["layout.editor.close"]),
  row("ED-02", "Diff and Edit modes operate on one identity-bound artifact", "complete", ["editor.mode.select"]),
  row("ED-03", "structured diff rows render bounded numbers, markers, additions, deletions, and context", "complete"),
  row("ED-04", "dirty edits save with expected revision and conflict handling", "partial", ["editor.content.change", "editor.file.save", "editor.conflict.reload", "editor.conflict.save-copy"]),
  row("ED-05", "Canvas edits apply a new Studio display revision without rewriting Harness history", "partial", ["editor.canvas.apply"]),
  row("ED-06", "file and Canvas buffers persist per session and artifact identity", "partial"),
  row("ED-07", "narrow editor replaces center or opens as a focus-managed sheet", "complete", ["layout.editor.toggle"]),

  row("ST-01", "Settings replaces the workspace and Back to chat restores it", "complete", ["route.settings.open", "route.settings.back"]),
  row("ST-02", "left navigation groups and live-filters all 13 actual settings pages", "complete", ["settings.search.change", "settings.section.select"]),
  row("ST-03", "General page wires theme, density, default project, send shortcut, panel width, restore, and motion", "partial", ["settings.preference.set", "settings.preference.reset"]),
  row("ST-04", "Appearance page wires accent, font size, timestamps, and compact bubbles", "partial", ["settings.preference.set"]),
  row("ST-05", "Composer page wires voice visibility, token estimate, and spell check", "partial", ["settings.preference.set"]),
  row("ST-06", "Harness page wires concurrency, turn budget, retry policy, and context discovery", "partial", ["settings.harness-policy.set"]),
  row("ST-07", "Models page wires provider, model, thinking, context facts, and streaming", "partial", ["settings.model-default.set", "settings.preference.set"]),
  row("ST-08", "Accounts page preserves hardened add, use, default, remove, and sign-out flows", "partial", ["account.add", "account.use", "account.set-default", "account.remove", "account.sign-out"]),
  row("ST-09", "Tools page lists and changes verified tool policy", "partial", ["settings.tool.set-enabled"]),
  row("ST-10", "Git and Environments remain separate pages with bounded discovery and controls", "partial", ["settings.preference.set"]),
  row("ST-11", "Privacy and security page wires telemetry, crash reports, and local-only policy", "partial", ["settings.preference.set"]),
  row("ST-12", "Keyboard shortcuts page is generated from the same command registry that executes them", "partial"),
  row("ST-13", "About reports real Studio/Harness/runtime identity, licenses, and update availability", "partial", ["settings.updates.check", "route.external-docs.open"]),
  row("ST-14", "workspace-managed controls are disabled with policy source and feedback", "partial", ["settings.preference.set"]),
  row("AU-01", "Settings-only account usage switches 7, 30, and 90 day windows", "complete", ["usage.account.range-select"]),
  row("AU-02", "account usage refresh and formula-safe CSV export use real ledger data", "complete", ["usage.account.refresh", "usage.account.export-csv"]),
  row("AU-03", "seven-stat strip reports processed, cache, input, output, cost, chats, and tasks", "partial"),
  row("AU-04", "daily accessible chart toggles main, subagent, and tool series", "partial", ["usage.account.series-toggle"]),
  row("AU-05", "breakdowns by runtime or model and project preserve totals", "partial"),
  row("AU-06", "quota and cost remain separate and unavailable when unsupported", "complete"),

  row("PL-01", "Ctrl+K opens a centered modal palette and restores trigger focus", "complete", ["palette.open", "palette.close"]),
  row("PL-02", "palette groups Actions, Chats, and bounded full-text Message hits", "complete", ["palette.result.execute"]),
  row("PL-03", "query, keyboard movement, Enter, Escape, empty, and disabled results work", "complete", ["palette.query.change", "palette.result.execute", "palette.close"]),
  row("PL-04", "one typed command registry owns menus, shortcuts, palette, and availability", "complete", ["palette.result.execute"]),
  row("CM-01", "Ctrl+N, Ctrl+K, Ctrl+comma, Ctrl+B, and Ctrl+J honor topmost overlay priority", "partial", ["catalog.chat.create", "palette.open", "route.settings.open", "layout.sidebar.toggle", "layout.inspector.toggle"]),
  row("CM-02", "typed toast queue deduplicates and keeps actionable failures until resolved", "complete", ["toast.dismiss"]),
  row("CM-03", "one monotonic clock drives elapsed time and progress without row timers", "partial"),
  row("CM-04", "menus, dropdowns, and popovers use outside click, focus, Escape, and unclipped overlays", "partial", ["surface.popover.toggle", "overlay.topmost.close"]),
  row("CM-05", "each asynchronous surface declares loading, empty, ready, stale, degraded, disconnected, error, and blocked states", "partial"),
  row("CM-06", "the whole product reflows at 640x400, 820px, 1280px, 1600px, and 200 percent zoom", "partial"),
]);

/**
 * Rows whose current status must not be promoted from fixture/component evidence.
 * Re-audit these only after the verified production adapter is mounted and proves
 * session lifecycle, daemon projections, and identity-bound artifact hydration.
 */
export const PRODUCTION_BRIDGE_REAUDIT_FEATURE_IDS = Object.freeze([
  "CV-04", "CV-05", "CV-06", "CV-09", "CV-10", "CV-12",
  "CP-03", "CP-04", "CP-05", "CP-07",
  "HR-02", "HR-03", "HR-04", "HR-07", "HR-08", "HR-10",
  "HR-13", "HR-14", "HR-16",
  "CU-02", "CU-03", "CU-06",
  "AC-03",
  "ED-01", "ED-04", "ED-05", "ED-06",
  "ST-06", "ST-07", "ST-09", "ST-13",
] as const);

export type PackageImplementationSummary = Readonly<Record<ImplementationStatus, number>>;

export function summarizePackageImplementation(
  features: readonly PackageFeatureAcceptance[] = FEATURE_ACCEPTANCE,
): PackageImplementationSummary {
  const counts: Record<ImplementationStatus, number> = {
    complete: 0,
    partial: 0,
    placeholder: 0,
    missing: 0,
    explicitly_unavailable: 0,
  };
  for (const feature of features) counts[feature.current] += 1;
  return Object.freeze(counts);
}

export const PACKAGE_IMPLEMENTATION_SUMMARY = summarizePackageImplementation();

export function isPackageReleaseReady(
  features: readonly PackageFeatureAcceptance[] = FEATURE_ACCEPTANCE,
): boolean {
  return features.every((feature) =>
    feature.current === "complete" || feature.current === "explicitly_unavailable"
  );
}

export interface PackageControlAcceptance {
  readonly controlId: string;
  readonly featureId: string;
  readonly action: StudioActionId;
}

/**
 * Stable acceptance IDs are derived from each package feature/action pair. This
 * catalog proves the required vocabulary only; it does not claim that a rendered
 * control is wired. Browser traversal separately requires visible controls to
 * carry unique IDs and rejects advertised actions outside STUDIO_ACTIONS, while
 * behavior scenarios exercise the corresponding product paths.
 */
export const PACKAGE_CONTROLS: readonly PackageControlAcceptance[] = Object.freeze(
  FEATURE_ACCEPTANCE.flatMap((feature) => feature.actions.map((action) => Object.freeze({
    controlId: `${feature.id.toLocaleLowerCase()}.${action}`,
    featureId: feature.id,
    action,
  }))),
);

export interface PackageScreen {
  readonly id: string;
  readonly kind: "workspace" | "inspector" | "editor" | "settings" | "overlay";
}

export const PACKAGE_SCREENS: readonly PackageScreen[] = Object.freeze([
  { id: "workspace.sidebar-expanded", kind: "workspace" }, { id: "workspace.sidebar-rail", kind: "workspace" },
  { id: "workspace.conversation-empty", kind: "workspace" }, { id: "workspace.conversation-active", kind: "workspace" }, { id: "workspace.conversation-streaming", kind: "workspace" },
  { id: "editor.diff", kind: "editor" }, { id: "editor.edit", kind: "editor" }, { id: "editor.canvas", kind: "editor" },
  { id: "inspector.overview", kind: "inspector" }, { id: "inspector.current-chat-usage", kind: "inspector" }, { id: "inspector.activity", kind: "inspector" },
  { id: "inspector.child-chat", kind: "inspector" }, { id: "inspector.child-activity", kind: "inspector" }, { id: "inspector.child-files", kind: "inspector" },
  ...["general", "appearance", "composer", "harness", "usage", "models", "accounts", "tools", "git", "environments", "privacy", "shortcuts", "about"].map((id) => ({ id: `settings.${id}`, kind: "settings" as const })),
  { id: "overlay.command-palette", kind: "overlay" }, { id: "overlay.menus-popovers-toasts", kind: "overlay" },
]);

export const PACKAGE_STATES = Object.freeze([
  "boot.loading", "runtime.ready", "runtime.degraded", "runtime.read-only", "runtime.unavailable", "runtime.disconnected", "runtime.stale", "runtime.unknown-outcome",
  "catalog.loading", "catalog.empty", "catalog.ready", "catalog.error", "chat.unread", "chat.read", "chat.archived", "chat.read-only",
  "session.idle", "session.working", "session.blocked", "session.failed", "session.stopped", "stream.pending-first-token", "stream.active", "stream.stopped", "stream.completed",
  "child.queued", "child.running", "child.done", "child.error", "child.cancelled", "child.unknown", "worker.silent-death", "worker.retrying", "worker.recovered", "worker.retry-failed",
  "overload.visible", "overload.dismissed", "overload.retrying", "overload.recovered", "queue.empty", "queue.populated", "tool.enabled", "tool.disabled", "tool.managed",
  "editor.empty", "editor.loading", "editor.clean", "editor.dirty", "editor.saving", "editor.conflict", "editor.error", "usage.loading", "usage.ready", "usage.unavailable",
  "overlay.open", "overlay.closed", "control.enabled", "control.disabled-with-reason",
]);

export interface PackageSetting { readonly key: string; readonly owner: "studio" | "harness"; readonly allowed: readonly (string | boolean)[] }
export const PACKAGE_SETTINGS: readonly PackageSetting[] = Object.freeze([
  { key: "theme", owner: "studio", allowed: ["System", "Dark", "Light"] }, { key: "density", owner: "studio", allowed: ["Comfortable", "Compact"] },
  { key: "project", owner: "studio", allowed: ["Last opened"] }, { key: "send", owner: "studio", allowed: ["Enter", "Ctrl+Enter"] },
  { key: "restore", owner: "studio", allowed: [true, false] }, { key: "motion", owner: "studio", allowed: [true, false] },
  { key: "subStatus", owner: "studio", allowed: [true, false] }, { key: "childOnly", owner: "studio", allowed: [true] },
  { key: "execMain", owner: "studio", allowed: [false] }, { key: "provider", owner: "studio", allowed: [] }, { key: "dmodel", owner: "studio", allowed: [] },
  { key: "dthink", owner: "studio", allowed: ["off", "low", "medium", "high", "max"] }, { key: "streaming", owner: "studio", allowed: [true, false] },
  { key: "accent", owner: "studio", allowed: ["Prime Violet", "Slate", "Ember"] }, { key: "fontSize", owner: "studio", allowed: ["Small", "Medium", "Large"] },
  { key: "timestamps", owner: "studio", allowed: [true, false] }, { key: "bubbles", owner: "studio", allowed: [true, false] }, { key: "voice", owner: "studio", allowed: [true, false] },
  { key: "tokenEst", owner: "studio", allowed: [true, false] }, { key: "spell", owner: "studio", allowed: [true, false] },
  { key: "maxSub", owner: "harness", allowed: [] }, { key: "maxTurns", owner: "harness", allowed: [] }, { key: "retry", owner: "harness", allowed: [true, false] },
  { key: "ctxFiles", owner: "harness", allowed: ["AGENTS.md", "CLAUDE.md", "Disabled"] }, { key: "autofetch", owner: "studio", allowed: [true, false] },
  { key: "sign", owner: "studio", allowed: [true, false] }, { key: "env", owner: "studio", allowed: [] }, { key: "telemetry", owner: "studio", allowed: [true, false] },
  { key: "crash", owner: "studio", allowed: [true, false] }, { key: "localOnly", owner: "studio", allowed: [true, false] },
]);

export const SHORTCUT_REQUIREMENTS = Object.freeze([
  { chord: "Ctrl+N", action: "catalog.chat.create" }, { chord: "Ctrl+K", action: "palette.open" }, { chord: "Ctrl+,", action: "route.settings.open" },
  { chord: "Ctrl+B", action: "layout.sidebar.toggle" }, { chord: "Ctrl+J", action: "layout.inspector.toggle" },
  { chord: "Enter", action: "harness.session.prompt" }, { chord: "Shift+Enter", action: "composer.draft.change" },
] satisfies readonly { chord: string; action: StudioActionId }[]);

export const RESPONSIVE_REQUIREMENTS = Object.freeze([
  "center minimum 340px plus 8px slack", "sidebar preferred 264px", "sidebar drag range 210–380px", "sidebar rail 52px below narrow budget",
  "inspector preferred 384px", "inspector drag range 300–600px", "inspector auto-hides before center violation", "inspector reopen action remains visible",
  "editor range 280–600px and maximum 46 percent", "opening editor may replace inspector", "composer controls wrap without shrinking primary actions",
  "settings navigation and content reflow without horizontal overflow", "200 percent zoom retains composer and escape routes",
]);

export interface DataRequirement { readonly id: string; readonly source: "harness_projection" | "studio_store" | "native" | "account_usage_ledger"; readonly scope: string }
export const DATA_REQUIREMENTS: readonly DataRequirement[] = Object.freeze([
  { id: "data.runtime-identity", source: "harness_projection", scope: "installation" }, { id: "data.compatibility", source: "harness_projection", scope: "adapter_profile" },
  { id: "data.project-catalog", source: "studio_store", scope: "workspace" }, { id: "data.chat-catalog", source: "studio_store", scope: "workspace" },
  { id: "data.parent-transcript", source: "harness_projection", scope: "root_session" }, { id: "data.child-transcript", source: "harness_projection", scope: "selected_child" },
  { id: "data.child-activity", source: "harness_projection", scope: "selected_child" }, { id: "data.child-files", source: "harness_projection", scope: "selected_child" },
  { id: "data.current-chat-usage", source: "harness_projection", scope: "root_session" }, { id: "data.account-usage", source: "account_usage_ledger", scope: "account_ledger" },
  { id: "data.model-catalog", source: "harness_projection", scope: "account" }, { id: "data.thinking-catalog", source: "harness_projection", scope: "model" },
  { id: "data.queue", source: "harness_projection", scope: "root_session" }, { id: "data.tools", source: "harness_projection", scope: "root_session" },
  { id: "data.context-sources", source: "harness_projection", scope: "root_session" }, { id: "data.activity", source: "harness_projection", scope: "root_session" },
  { id: "data.diff", source: "native", scope: "identity_bound_artifact" }, { id: "data.editor-buffer", source: "studio_store", scope: "chat_artifact" },
  { id: "data.canvas-revision", source: "studio_store", scope: "chat_message" }, { id: "data.layout", source: "studio_store", scope: "device" },
  { id: "data.settings", source: "studio_store", scope: "workspace" }, { id: "data.accounts", source: "studio_store", scope: "account_registry" },
  { id: "data.window-state", source: "native", scope: "window" }, { id: "data.clipboard-result", source: "native", scope: "operation" },
  { id: "data.attachment-metadata", source: "native", scope: "chat_draft" }, { id: "data.extension-request", source: "harness_projection", scope: "root_session" },
]);

export function validatePackageAcceptance(): Readonly<{ valid: true; featureCount: number }> {
  const ids = new Set<string>();
  for (const feature of FEATURE_ACCEPTANCE) {
    if (ids.has(feature.id)) throw new Error(`Duplicate package feature ID: ${feature.id}.`);
    ids.add(feature.id);
    if (feature.interactive !== (feature.actions.length > 0)) throw new Error(`Interaction flag mismatch for ${feature.id}.`);
    for (const action of feature.actions) if (!(action in STUDIO_ACTIONS)) throw new Error(`Unknown action ${action} on ${feature.id}.`);
  }
  const expected = { SH: 10, NV: 10, CV: 15, CP: 11, HR: 18, CU: 8, AC: 6, ED: 7, ST: 14, AU: 6, PL: 4, CM: 6 } as const;
  for (const [prefix, count] of Object.entries(expected)) {
    const actual = FEATURE_ACCEPTANCE.filter((feature) => feature.id.startsWith(`${prefix}-`)).length;
    if (actual !== count) throw new Error(`Package feature group ${prefix} expected ${count}, found ${actual}.`);
  }
  const controlIds = new Set<string>();
  for (const control of PACKAGE_CONTROLS) {
    if (controlIds.has(control.controlId)) throw new Error(`Duplicate package control ID: ${control.controlId}.`);
    controlIds.add(control.controlId);
    const feature = FEATURE_ACCEPTANCE.find((candidate) => candidate.id === control.featureId);
    if (!feature?.actions.includes(control.action)) throw new Error(`Control ${control.controlId} is not mapped by feature ${control.featureId}.`);
  }
  for (const feature of FEATURE_ACCEPTANCE.filter((candidate) => candidate.interactive)) {
    const mapped = PACKAGE_CONTROLS.filter((control) => control.featureId === feature.id);
    if (mapped.length !== feature.actions.length) throw new Error(`Interactive feature ${feature.id} has incomplete control mapping.`);
  }
  return Object.freeze({ valid: true, featureCount: FEATURE_ACCEPTANCE.length });
}

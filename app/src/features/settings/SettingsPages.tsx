import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { Accounts } from "../../components/Accounts";
import { createControlBinding, type StudioActionId, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import { studioKeyboardShortcutGroups, type CommandAvailabilityContext } from "../../entities/commands/commandRegistry";
import type { HarnessCompatibility, RuntimeIdentity } from "../../shared/ipc/harness.generated";
import type { SendShortcut } from "../conversation/composerModel";
import type { Account, AppSettings } from "../../types";
import type { SubscriptionQuotaProjection } from "../../quotaProjection";
import type { HarnessComposerProjection } from "../harness/adapter";
import { RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON } from "../navigation/residentCreationPolicy";

type SettingWriter = (key: keyof AppSettings, value: string | null) => void;

function SettingGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="studio-setting-group"><h2>{title}</h2><div className="studio-setting-card">{children}</div></section>;
}

function Row({ label, description, children, lockedReason }: { readonly label: string; readonly description: string; readonly children?: ReactNode; readonly lockedReason?: string }) {
  return <div className="studio-setting-row"><div><strong>{label}</strong><p>{description}</p>{lockedReason && <small className="studio-setting-lock">Managed: {lockedReason}</small>}</div>{children && <div className="studio-setting-control">{children}</div>}</div>;
}

function Unavailable({ children }: { readonly children: ReactNode }) {
  return <p className="studio-setting-unavailable" role="status">{children}</p>;
}

function SettingSelect({ label, value, options, setting, onSetting, disabled, reason, action = "settings.preference.set" }: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly Readonly<{ value: string; label: string }>[];
  readonly setting: keyof AppSettings;
  readonly onSetting?: SettingWriter;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly action?: StudioActionId;
}) {
  const unavailable = disabled || !onSetting;
  const binding = createControlBinding(`settings.${String(setting)}`, action);
  return <select aria-label={label} data-control-id={binding.controlId} data-action={binding.action} title={unavailable ? (reason ?? "This setting is not writable.") : undefined} value={value} disabled={unavailable} onChange={(event) => onSetting?.(setting, event.currentTarget.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}

function SettingSwitch({ label, enabled, setting, onSetting, disabled, reason, action = "settings.preference.set" }: {
  readonly label: string;
  readonly enabled: boolean;
  readonly setting: keyof AppSettings;
  readonly onSetting?: SettingWriter;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly action?: StudioActionId;
}) {
  const unavailable = disabled || !onSetting;
  const binding = createControlBinding(`settings.${String(setting)}`, action);
  return <button className="studio-switch" type="button" role="switch" aria-label={label} aria-checked={enabled} data-control-id={binding.controlId} data-action={binding.action} disabled={unavailable} title={unavailable ? (reason ?? "This setting is not writable.") : undefined} onClick={() => onSetting?.(setting, enabled ? "disabled" : "enabled")}><span /></button>;
}

const boolValue = (value: string | null | undefined, fallback = true) => value == null ? fallback : value === "enabled";
const connected = (compatibility: HarnessCompatibility) => compatibility.status === "ready" || compatibility.status === "degraded";
const unappliedReason = "This preference is not applied by the current runtime, so it is read-only instead of being persisted inertly.";

export function GeneralSettings({ settings, onSetting }: { readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  return <><Unavailable>{unappliedReason}</Unavailable><SettingGroup title="General"><Row label="Default file open destination" description="Choose where verified files and folders open."><SettingSelect label="Default file open destination" value={settings.fileOpenDestination ?? "system"} setting="fileOpenDestination" onSetting={onSetting} disabled reason={unappliedReason} options={[{ value: "system", label: "System default" }, { value: "vscode", label: "VS Code" }, { value: "studio", label: "Prime Studio" }]} /></Row><Row label="Language" description="Language used by the application interface."><SettingSelect label="Language" value={settings.language ?? "auto"} setting="language" onSetting={onSetting} disabled reason={unappliedReason} options={[{ value: "auto", label: "Auto detect" }, { value: "en", label: "English" }]} /></Row><Row label="Bottom panel" description="Show the terminal and diagnostics panel control in the app header."><SettingSwitch label="Bottom panel" enabled={boolValue(settings.bottomPanel, false)} setting="bottomPanel" onSetting={onSetting} disabled reason={unappliedReason} /></Row></SettingGroup><SettingGroup title="Workspace"><Row label="Default workspace" description="New chats start in this user-selected working directory."><span className="studio-setting-value">{settings.defaultCwd || "Ask each time"}</span></Row><Row label="Panel layout" description="Pane widths and open states are persisted per window and reflow at narrow widths."><span className="studio-setting-value">Adaptive</span></Row></SettingGroup></>;
}

export function AppearanceSettings({ settings, onSetting }: { readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  const theme = settings.theme ?? "system";
  return <>
    <SettingGroup title="Theme"><div className="studio-theme-options" role="radiogroup" aria-label="Theme">{(["system", "dark", "light"] as const).map((value) => <button type="button" role="radio" aria-checked={theme === value} key={value} disabled={!onSetting} data-control-id={`settings.theme.${value}`} data-action="settings.preference.set" onClick={() => onSetting?.("theme", value)}><span className={`studio-theme-preview studio-theme-${value}`} />{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div></SettingGroup>
    <SettingGroup title="Personalization">
      <Row label="Accent" description="Choose the semantic accent used for focus, selection, and active controls."><SettingSelect label="Accent" value={settings.accent ?? "prime-violet"} setting="accent" onSetting={onSetting} options={[{ value: "prime-violet", label: "Prime Violet" }, { value: "slate", label: "Slate" }, { value: "ember", label: "Ember" }]} /></Row>
      <Row label="Font size" description="Adjust the base interface type size without changing the pane geometry."><SettingSelect label="Font size" value={settings.fontSize ?? "medium"} setting="fontSize" onSetting={onSetting} options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} /></Row>
      <Row label="Show timestamps" description="Show local presentation time beside user and assistant messages."><SettingSwitch label="Show timestamps" enabled={boolValue(settings.timestamps)} setting="timestamps" onSetting={onSetting} /></Row>
      <Row label="Compact message bubbles" description="Use tighter spacing for parent-conversation message bubbles."><SettingSwitch label="Compact message bubbles" enabled={boolValue(settings.bubbles, false)} setting="bubbles" onSetting={onSetting} /></Row>
    </SettingGroup>
    <SettingGroup title="Interface"><Row label="Density" description="Adjust vertical spacing without changing text size."><SettingSelect label="Density" value={settings.density ?? "comfortable"} setting="density" onSetting={onSetting} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} /></Row><Row label="Reduced motion" description="Reduce pulsing and animated transitions throughout the workspace."><SettingSwitch label="Reduced motion" enabled={boolValue(settings.reducedMotion, false)} setting="reducedMotion" onSetting={onSetting} /></Row></SettingGroup>
  </>;
}

export function ComposerSettings({ settings, onSetting }: { readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  return <><SettingGroup title="Composer"><Row label="Send shortcut" description="Choose whether Enter or Ctrl+Enter sends your prompt."><SettingSelect label="Send shortcut" value={settings.sendShortcut ?? "enter"} setting="sendShortcut" onSetting={onSetting} options={[{ value: "enter", label: "Enter" }, { value: "ctrl-enter", label: "Ctrl+Enter" }]} /></Row><Row label="Suggested prompts" description="Show suggestions generated from the active project and verified connections."><SettingSwitch label="Suggested prompts" enabled={boolValue(settings.promptSuggestions)} setting="promptSuggestions" onSetting={onSetting} /></Row><Row label="Token estimate" description="Show the bounded character-based estimate beneath the composer."><SettingSwitch label="Token estimate" enabled={boolValue(settings.tokenEstimate)} setting="tokenEstimate" onSetting={onSetting} /></Row><Row label="Voice control" description="Show the microphone control; capture remains explicitly unavailable until a reviewed audio privacy contract exists."><SettingSwitch label="Voice control" enabled={boolValue(settings.voice)} setting="voice" onSetting={onSetting} /></Row><Row label="Spell check" description="Use the operating system and WebView spelling service in the prompt editor."><SettingSwitch label="Spell check" enabled={boolValue(settings.spell)} setting="spell" onSetting={onSetting} /></Row><Row label="Drafts" description="Drafts are always isolated per chat; a configurable persistence policy is not verified yet."><SettingSwitch label="Drafts" enabled={boolValue(settings.drafts)} setting="drafts" onSetting={onSetting} disabled reason={unappliedReason} /></Row></SettingGroup></>;
}

export function AccountsSettings({ accounts, defaultAccount, onChanged, onDefaultAccount, quota }: { readonly accounts: readonly Account[]; readonly defaultAccount: string | null; readonly onChanged: (accounts?: Account[]) => void; readonly onDefaultAccount: (accountId: string | null) => void; readonly quota?: SubscriptionQuotaProjection }) {
  return <div className="studio-accounts-settings">
    <Unavailable>{RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON} Account login, status, quota, local usage, rename, and removal remain available.</Unavailable>
    {defaultAccount && <button type="button" className="btn" data-control-id="settings.defaultAccount.reset" data-action="settings.preference.reset" onClick={() => onDefaultAccount(null)}>Clear unsupported account preference</button>}
    <Accounts accounts={[...accounts]} onChanged={onChanged} onUse={onDefaultAccount} newSessionDisabledReason={RESIDENT_ACCOUNT_SELECTION_UNAVAILABLE_REASON} defaultAccount={defaultAccount} onDefaultAccount={onDefaultAccount} quota={quota} />
  </div>;
}

export function HarnessSettings({ compatibility, settings, onSetting }: { readonly compatibility: HarnessCompatibility; readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  const canConfigure = connected(compatibility) && Boolean(onSetting);
  const reason = connected(compatibility) ? "A verified settings adapter is required." : "A verified Harness connection is required.";
  return <>{!canConfigure && <Unavailable>{reason} Existing values remain visible but cannot be changed.</Unavailable>}<SettingGroup title="Agent runtime"><Row label="Maximum concurrent subagents" description="Studio requests this ceiling; the Harness remains the final admission authority."><input aria-label="Maximum concurrent agents" data-control-id="settings.maxConcurrentAgents" data-action="settings.harness-policy.set" type="number" min={1} max={64} value={settings.maxConcurrentAgents ?? "4"} disabled={!canConfigure} title={!canConfigure ? reason : undefined} onChange={(event) => onSetting?.("maxConcurrentAgents", event.currentTarget.value)} /></Row><Row label="Autonomous maximum turns" description="Limit unattended turns before control returns to you."><input aria-label="Autonomous maximum turns" data-control-id="settings.autonomousMaxTurns" data-action="settings.harness-policy.set" type="number" min={1} max={1000} value={settings.autonomousMaxTurns ?? "40"} disabled={!canConfigure} title={!canConfigure ? reason : undefined} onChange={(event) => onSetting?.("autonomousMaxTurns", event.currentTarget.value)} /></Row><Row label="Retry silent worker death" description="Retry once when the verified runtime reports an unexpected clean worker exit."><SettingSwitch label="Retry silent worker death" enabled={boolValue(settings.retrySilentWorkers)} setting="retrySilentWorkers" onSetting={onSetting} disabled={!canConfigure} reason={reason} action="settings.harness-policy.set" /></Row><Row label="Context discovery" description="Honor repository AGENTS.md instructions before broader workspace context."><SettingSelect label="Context discovery" value={settings.contextDiscovery ?? "agents-first"} setting="contextDiscovery" onSetting={onSetting} disabled={!canConfigure} reason={reason} action="settings.harness-policy.set" options={[{ value: "agents-first", label: "AGENTS.md wins" }, { value: "project-only", label: "Project only" }]} /></Row></SettingGroup></>;
}

export function ModelsSettings({ compatibility, composer }: { readonly compatibility: HarnessCompatibility; readonly composer?: HarnessComposerProjection }) {
  const verified = connected(compatibility) && compatibility.capabilities.includes("model_catalog") ? composer : undefined;
  const creationReason = "The verified resident creation route accepts workspace and title only; it cannot prove account, model, or thinking defaults.";
  const modelOptions = verified?.models.length
    ? verified.models.map((model) => ({ value: model.id, label: model.label }))
    : [{ value: "unavailable", label: "Not reported" }];
  const selectedModel = verified?.selectedModel && modelOptions.some((option) => option.value === verified.selectedModel)
    ? verified.selectedModel
    : modelOptions[0]!.value;
  const thinkingOptions = verified?.thinkingLevels.length
    ? verified.thinkingLevels.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))
    : [{ value: "unavailable", label: "Not reported" }];
  const selectedThinking = verified?.selectedThinking && thinkingOptions.some((option) => option.value === verified.selectedThinking)
    ? verified.selectedThinking
    : thinkingOptions[0]!.value;
  return <>
    {!verified && <Unavailable>A verified session model catalog is required. Prime Studio will not invent provider, model, or thinking choices.</Unavailable>}
    <Unavailable>{creationReason}</Unavailable>
    <SettingGroup title="Current verified session">
      <Row label="Available model" description="Choices reported by the selected admitted Harness session."><SettingSelect label="Default model" value={selectedModel} setting="defaultModel" disabled reason={creationReason} options={modelOptions} /></Row>
      <Row label="Thinking level" description="Effort values reported by the selected model and session."><SettingSelect label="Default thinking level" value={selectedThinking} setting="defaultThinking" disabled reason={creationReason} options={thinkingOptions} /></Row>
      <Row label="Session commands" description="Commands present on the verified attached connection."><span className="studio-setting-value">{verified?.supportedCommands.length ? verified.supportedCommands.join(" · ") : "Not reported"}</span></Row>
    </SettingGroup>
  </>;
}

export function ToolsSettings({ compatibility, settings, onSetting }: { readonly compatibility: HarnessCompatibility; readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  const canConfigure = connected(compatibility) && Boolean(onSetting);
  const reason = connected(compatibility) ? "A verified settings adapter is required." : "Connect a verified Harness to inspect and configure its tools.";
  return <><Unavailable>{canConfigure ? "Tool availability is projected by the active session; policy-locked tools remain read-only." : reason}</Unavailable><SettingGroup title="Harness tools"><Row label="Enable configurable tools" description="Allow tools admitted by both workspace policy and the verified runtime."><SettingSwitch label="Enable configurable tools" enabled={boolValue(settings.toolsEnabled)} setting="toolsEnabled" onSetting={onSetting} disabled={!canConfigure} reason={reason} action="settings.tool.set-enabled" /></Row><Row label="Computer use and browser" description="High-impact tools remain subject to their native authority and cannot be enabled by this toggle alone."><span className="studio-setting-value">Policy controlled</span></Row></SettingGroup></>;
}

export function GitSettings({ settings, onSetting }: { readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  return <><Unavailable>{unappliedReason}</Unavailable><SettingGroup title="Repository"><Row label="Automatic status refresh" description="Refresh read-only Git status when the active workspace changes."><SettingSwitch label="Automatic Git status refresh" enabled={boolValue(settings.gitAutoRefresh)} setting="gitAutoRefresh" onSetting={onSetting} disabled reason={unappliedReason} /></Row><Row label="Write operations" description="Commit, push, reset, and checkout require an explicit command and native authority."><span className="studio-setting-value">Never automatic</span></Row></SettingGroup></>;
}

export function EnvironmentsSettings({ settings, onSetting }: { readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  return <><Unavailable>{unappliedReason}</Unavailable><SettingGroup title="Agent environment"><Row label="Environment" description="Choose where verified Harness processes run on Windows."><SettingSelect label="Agent environment" value={settings.environmentMode ?? "windows-native"} setting="environmentMode" onSetting={onSetting} disabled reason={unappliedReason} options={[{ value: "windows-native", label: "Windows native" }, { value: "wsl", label: "WSL (when available)" }]} /></Row><Row label="Default working directory" description="The current default path is stored without credentials."><span className="studio-setting-value studio-setting-path">{settings.defaultCwd || "Ask each time"}</span></Row></SettingGroup></>;
}

export function PrivacySettings({ compatibility, settings, onSetting }: { readonly compatibility: HarnessCompatibility; readonly settings: AppSettings; readonly onSetting?: SettingWriter }) {
  return <><Unavailable>{unappliedReason}</Unavailable><SettingGroup title="Privacy"><Row label="Telemetry" description="Share anonymous application diagnostics. Prompt and credential content is never included."><SettingSwitch label="Telemetry" enabled={boolValue(settings.telemetry, false)} setting="telemetry" onSetting={onSetting} disabled reason={unappliedReason} /></Row><Row label="Crash reports" description="Send bounded crash diagnostics after redaction."><SettingSwitch label="Crash reports" enabled={boolValue(settings.crashReports, false)} setting="crashReports" onSetting={onSetting} disabled reason={unappliedReason} /></Row><Row label="Local-only mode" description="Keep sessions, logs, and usage history on this machine."><SettingSwitch label="Local-only mode" enabled={boolValue(settings.localOnly)} setting="localOnly" onSetting={onSetting} disabled reason={unappliedReason} /></Row></SettingGroup><SettingGroup title="Runtime security"><Row label="Compatibility" description="Runtime behavior is bound to verified hashes, protocol schema, and capabilities."><span className="studio-setting-value">{compatibility.status.replace(/_/gu, " ")}</span></Row><Row label="Credentials" description="Credential values stay outside renderer projections and logs."><span className="studio-setting-value">Protected</span></Row></SettingGroup></>;
}

export function ShortcutsSettings({ availability, sendShortcut, composerAvailability }: { readonly availability: CommandAvailabilityContext; readonly sendShortcut: SendShortcut; readonly composerAvailability: Readonly<{ enabled: boolean; reason?: string }> }) {
  const groups = studioKeyboardShortcutGroups({ commands: availability, composer: { sendShortcut, availability: composerAvailability } });
  const list = (rows: readonly (typeof groups.application)[number][]) => <ul className="studio-shortcut-list">{rows.map((row) => <li key={row.id} aria-disabled={!row.availability.enabled}>
    <span><strong>{row.label}</strong><small className={row.availability.enabled ? "studio-shortcut-available" : "studio-shortcut-unavailable"}>{row.availability.enabled ? "Available" : "Unavailable"}{row.availability.reason && <span> — {row.availability.reason}</span>}</small></span>
    <span className="studio-shortcut-chords">{row.shortcuts.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)}</span>
  </li>)}</ul>;
  return <><SettingGroup title="Application">{list(groups.application)}</SettingGroup><SettingGroup title="Composer">{list(groups.composer)}</SettingGroup></>;
}

export function AboutSettings({ compatibility, runtime, onExecute }: {
  readonly compatibility: HarnessCompatibility;
  readonly runtime: RuntimeIdentity | null;
  readonly onExecute?: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
}) {
  const [studioVersion, setStudioVersion] = useState("Loading\u2026");
  const updateReason = "No signed update channel is configured.";
  const updateBinding = createControlBinding("settings.about.updates", "settings.updates.check", updateReason);
  const licensesBinding = createControlBinding("settings.about.licenses", "route.external-docs.open");
  const harnessStatus = compatibility.status === "ready" || compatibility.status === "degraded"
    ? `${compatibility.status.replace(/_/gu, " ")} \u00b7 ${compatibility.profile}`
    : compatibility.status.replace(/_/gu, " ");

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => getVersion()).then((version) => {
      const verified = typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(version) ? version : null;
      if (active) setStudioVersion(verified ?? "Unavailable");
    }).catch(() => {
      if (active) setStudioVersion("Unavailable");
    });
    return () => { active = false; };
  }, []);

  return <>
    <SettingGroup title="Prime Studio">
      <Row label="Version" description="Installed application version reported by the Tauri package."><span className="studio-setting-value">{studioVersion}</span></Row>
      <Row label="Compatibility" description="Status of the exact verified local Harness adapter profile."><span className="studio-setting-value studio-setting-identity">{harnessStatus}</span></Row>
      <Row label="Updates" description="Signed update availability requires a configured and verified release channel.">
        <div><span className="studio-setting-value">{"Unavailable \u00b7 no signed update channel configured"}</span><button type="button" disabled title={updateReason} aria-label="Check for updates" data-control-id={updateBinding.controlId} data-action={updateBinding.action}>Check</button></div>
      </Row>
    </SettingGroup>
    <SettingGroup title="Verified Harness runtime">
      {runtime ? <>
        <Row label="Package" description="Package identity observed and verified by the native runtime manifest."><span className="studio-setting-value studio-setting-identity">{runtime.packageName} {runtime.packageVersion}</span></Row>
        <Row label="Package digest" description="SHA-256 digest verified before Harness activation."><code className="studio-setting-value studio-setting-code">{runtime.packageDigest}</code></Row>
        <Row label="Entrypoint digest" description="SHA-256 digest of the admitted runtime entrypoint."><code className="studio-setting-value studio-setting-code">{runtime.entrypointDigest}</code></Row>
        <Row label="Protocol" description="Closed protocol name and version admitted by the compatibility profile."><span className="studio-setting-value studio-setting-identity">{runtime.protocolName} v{runtime.protocolVersion}</span></Row>
        <Row label="Schema" description="Closed schema identity and revision used by this connection."><span className="studio-setting-value studio-setting-identity">{runtime.schemaId} r{runtime.schemaRevision}</span></Row>
      </> : <Unavailable>No verified Harness runtime identity is available.</Unavailable>}
    </SettingGroup>
    <SettingGroup title="Open source">
      <Row label="License" description="Prime Studio is distributed under the MIT License."><span className="studio-setting-value">MIT</span></Row>
      <Row label="Third-party notices" description="The dependency license notices packaged with this application are available through the native document owner.">
        <button type="button" disabled={!onExecute} title={!onExecute ? "The native document owner is unavailable." : undefined} data-control-id={licensesBinding.controlId} data-action={licensesBinding.action} onClick={() => { void onExecute?.({ action: "route.external-docs.open", payload: { document: "licenses" } }); }}>Open license notices</button>
      </Row>
    </SettingGroup>
  </>;
}

export { Row, SettingGroup };

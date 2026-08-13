import { useEffect, useMemo, useState } from "react";

import { createControlBinding, type StudioOperation, type StudioOperationOutcome } from "../../contracts/studioOperations";
import type { CommandAvailabilityContext } from "../../entities/commands/commandRegistry";
import type { HarnessCompatibility, RuntimeIdentity } from "../../shared/ipc/harness.generated";
import type { Account, AppSettings } from "../../types";
import type { SubscriptionQuotaProjection } from "../../quotaProjection";
import type { HarnessComposerProjection } from "../harness/adapter";
import { AccountUsageSettings } from "./AccountUsageSettings";
import {
  AboutSettings, AccountsSettings, AppearanceSettings, ComposerSettings, EnvironmentsSettings,
  GeneralSettings, GitSettings, HarnessSettings, ModelsSettings, PrivacySettings, ShortcutsSettings, ToolsSettings,
} from "./SettingsPages";
import { isStudioSettingsSection, searchSettingsSections, settingsSections, type StudioSettingsSectionId } from "./settingsRegistry";
import "./settings.css";

const controls = {
  back: createControlBinding("settings.back", "route.settings.back"),
  search: createControlBinding("settings.search", "settings.search.change"),
  section: createControlBinding("settings.section", "settings.section.select"),
};

interface SettingsSharedProps {
  readonly compatibility: HarnessCompatibility;
  readonly runtime?: RuntimeIdentity | null;
  readonly onExecute?: (operation: StudioOperation) => Promise<StudioOperationOutcome>;
  readonly settings?: AppSettings;
  readonly onSetting?: (key: keyof AppSettings, value: string | null) => void;
  readonly onHarnessSetting?: (key: keyof AppSettings, value: string | null) => void;
  readonly onToolSetting?: (key: keyof AppSettings, value: string | null) => void;
  readonly accounts?: readonly Account[];
  readonly onAccountsChanged?: (accounts?: Account[]) => void;
  readonly onExportUsageCsv?: (csv: string, rangeDays: 7 | 30 | 90) => Promise<Readonly<{ status: "cancelled" }> | Readonly<{ status: "saved"; path: string; rows: number; bytes: number }>>;
  readonly composer?: HarnessComposerProjection;
  readonly quota?: SubscriptionQuotaProjection;
  readonly quotaStatus?: "loading" | "ready" | "unavailable";
  readonly onRefreshQuota?: () => Promise<Readonly<{ status: "updated" | "preserved" | "unavailable"; message?: string }>>;
  readonly commandAvailability?: CommandAvailabilityContext;
  readonly composerShortcutAvailability?: Readonly<{ enabled: boolean; reason?: string }>;
}

function SettingsPage({ section, compatibility, runtime = null, onExecute, settings = {}, onSetting, onHarnessSetting, onToolSetting, accounts = [], onAccountsChanged, onExportUsageCsv, composer, quota, quotaStatus, onRefreshQuota, commandAvailability = { admissionConnected: false }, composerShortcutAvailability = { enabled: false, reason: "Prompt admission is not connected." } }: SettingsSharedProps & { readonly section: StudioSettingsSectionId }) {
  switch (section) {
    case "general": return <GeneralSettings settings={settings} onSetting={onSetting} />;
    case "appearance": return <AppearanceSettings settings={settings} onSetting={onSetting} />;
    case "composer": return <ComposerSettings settings={settings} onSetting={onSetting} />;
    case "harness": return <HarnessSettings compatibility={compatibility} settings={settings} onSetting={onHarnessSetting} />;
    case "usage": return <AccountUsageSettings accounts={accounts} onExportCsv={onExportUsageCsv} quota={quota} quotaStatus={quotaStatus} onRefreshQuota={onRefreshQuota} />;
    case "models": return <ModelsSettings compatibility={compatibility} composer={composer} />;
    case "accounts": return <AccountsSettings accounts={accounts} defaultAccount={settings.defaultAccount ?? null} onChanged={onAccountsChanged ?? (() => undefined)} onDefaultAccount={(accountId) => onSetting?.("defaultAccount", accountId)} quota={quota} />;
    case "tools": return <ToolsSettings compatibility={compatibility} settings={settings} onSetting={onToolSetting} />;
    case "git": return <GitSettings settings={settings} onSetting={onSetting} />;
    case "environments": return <EnvironmentsSettings settings={settings} onSetting={onSetting} />;
    case "privacy": return <PrivacySettings compatibility={compatibility} settings={settings} onSetting={onSetting} />;
    case "shortcuts": return <ShortcutsSettings availability={commandAvailability} sendShortcut={settings.sendShortcut === "ctrl-enter" ? "ctrl-enter" : "enter"} composerAvailability={composerShortcutAvailability} />;
    case "about": return <AboutSettings compatibility={compatibility} runtime={runtime} onExecute={onExecute} />;
  }
}

export function SettingsShell({ section, onSection, onBack, compatibility, runtime, onExecute, settings, onSetting, onHarnessSetting, onToolSetting, accounts = [], onAccountsChanged, onExportUsageCsv, composer, quota, quotaStatus, onRefreshQuota, commandAvailability, composerShortcutAvailability }: SettingsSharedProps & {
  readonly section: string | null;
  readonly onSection: (section: StudioSettingsSectionId) => void;
  readonly onBack: () => void;
}) {
  const active = isStudioSettingsSection(section) ? section : "general";
  const [query, setQuery] = useState("");
  const visible = useMemo(() => searchSettingsSections(query), [query]);
  const definition = settingsSections.find((candidate) => candidate.id === active)!;
  const groups = [...new Set(visible.map((candidate) => candidate.group))];

  useEffect(() => {
    const selected = settings?.theme ?? "system";
    const resolved = selected === "system" && typeof window.matchMedia === "function" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : selected;
    document.documentElement.dataset.theme = resolved === "light" ? "light" : "dark";
  }, [settings?.theme]);

  return <main className="studio-settings" aria-label="Settings">
    <aside className="studio-settings-nav" aria-label="Settings navigation">
      <button type="button" className="studio-settings-back" aria-label="Back to chat" data-control-id={controls.back.controlId} data-action={controls.back.action} onClick={onBack}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg><span>Back to chat</span></button>
      <label className="studio-settings-search"><span className="sr-only">Search settings</span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Search settings" data-control-id={controls.search.controlId} data-action={controls.search.action} value={query} onChange={(event) => setQuery(event.currentTarget.value.slice(0, 200))} placeholder="Search settings" /></label>
      <nav aria-label="Settings sections">{groups.map((group) => <section key={group}><h2>{group}</h2>{visible.filter((candidate) => candidate.group === group).map((candidate) => <button type="button" key={candidate.id} data-control-id={`${controls.section.controlId}.${candidate.id}`} data-action={controls.section.action} aria-current={active === candidate.id ? "page" : undefined} onClick={() => onSection(candidate.id)}><span>{candidate.label}</span><small>{candidate.description}</small></button>)}</section>)}</nav>
    </aside>
    <section className="studio-settings-content" data-settings-section={active} aria-labelledby="studio-settings-title"><div className="studio-settings-page"><header><h1 id="studio-settings-title">{definition.label}</h1><span>{definition.description}</span></header><SettingsPage section={active} compatibility={compatibility} runtime={runtime} onExecute={onExecute} settings={settings} onSetting={onSetting} onHarnessSetting={onHarnessSetting} onToolSetting={onToolSetting} accounts={accounts} onAccountsChanged={onAccountsChanged} onExportUsageCsv={onExportUsageCsv} composer={composer} quota={quota} quotaStatus={quotaStatus} onRefreshQuota={onRefreshQuota} commandAvailability={commandAvailability} composerShortcutAvailability={composerShortcutAvailability} /></div></section>
  </main>;
}

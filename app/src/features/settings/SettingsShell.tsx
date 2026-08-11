import { useMemo, useState } from "react";

import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import type { AppSettings } from "../../types";
import {
  AboutSettings,
  AccountUsageSettings,
  AppearanceSettings,
  ComposerSettings,
  GeneralSettings,
  HarnessSettings,
  IntegrationsSettings,
  ModelsSettings,
  SecuritySettings,
  ShortcutsSettings,
} from "./SettingsPages";
import { isStudioSettingsSection, searchSettingsSections, settingsSections, type StudioSettingsSectionId } from "./settingsRegistry";
import "./settings.css";

function SettingsPage({ section, compatibility, settings, onSetting }: {
  readonly section: StudioSettingsSectionId;
  readonly compatibility: HarnessCompatibility;
  readonly settings?: AppSettings;
  readonly onSetting?: (key: keyof AppSettings, value: string | null) => void;
}) {
  switch (section) {
    case "general": return <GeneralSettings />;
    case "appearance": return <AppearanceSettings theme={settings?.theme ?? "system"} onTheme={(value) => onSetting?.("theme", value)} />;
    case "composer": return <ComposerSettings />;
    case "usage": return <AccountUsageSettings />;
    case "harness": return <HarnessSettings compatibility={compatibility} />;
    case "models": return <ModelsSettings compatibility={compatibility} />;
    case "integrations": return <IntegrationsSettings />;
    case "security": return <SecuritySettings compatibility={compatibility} />;
    case "shortcuts": return <ShortcutsSettings />;
    case "about": return <AboutSettings compatibility={compatibility} />;
  }
}

export function SettingsShell({ section, onSection, onBack, compatibility, settings, onSetting }: {
  readonly section: string | null;
  readonly onSection: (section: StudioSettingsSectionId) => void;
  readonly onBack: () => void;
  readonly compatibility: HarnessCompatibility;
  readonly settings?: AppSettings;
  readonly onSetting?: (key: keyof AppSettings, value: string | null) => void;
}) {
  const active = isStudioSettingsSection(section) ? section : "general";
  const [query, setQuery] = useState("");
  const visible = useMemo(() => searchSettingsSections(query), [query]);
  const definition = settingsSections.find((candidate) => candidate.id === active)!;
  const groups = [...new Set(visible.map((candidate) => candidate.group))];
  return <main className="studio-settings" aria-label="Settings">
    <aside className="studio-settings-nav" aria-label="Settings navigation">
      <button type="button" className="studio-settings-back" aria-label="Back to chat" onClick={onBack}>← <span>Back to chat</span></button>
      <label className="studio-settings-search"><span className="sr-only">Search settings</span><input type="search" aria-label="Search settings" value={query} onChange={(event) => setQuery(event.target.value.slice(0, 200))} placeholder="Search settings" /></label>
      <nav aria-label="Settings sections">{groups.map((group) => <section key={group}><h2>{group}</h2>{visible.filter((candidate) => candidate.group === group).map((candidate) => <button type="button" key={candidate.id} aria-current={active === candidate.id ? "page" : undefined} onClick={() => onSection(candidate.id)}><span>{candidate.label}</span><small>{candidate.description}</small></button>)}</section>)}</nav>
    </aside>
    <section className="studio-settings-content" aria-labelledby="studio-settings-title">
      <div className="studio-settings-page"><header><p>Settings</p><h1 id="studio-settings-title">{definition.label}</h1><span>{definition.description}</span></header><SettingsPage section={active} compatibility={compatibility} settings={settings} onSetting={onSetting} /></div>
    </section>
  </main>;
}

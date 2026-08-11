import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import type { ReactNode } from "react";
import { Accounts } from "../../components/Accounts";
import type { Account } from "../../types";

function SettingGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="studio-setting-group"><h2>{title}</h2><div className="studio-setting-card">{children}</div></section>;
}

function Row({ label, description, children }: { readonly label: string; readonly description: string; readonly children?: ReactNode }) {
  return <div className="studio-setting-row"><div><strong>{label}</strong><p>{description}</p></div>{children && <div className="studio-setting-control">{children}</div>}</div>;
}

function Unavailable({ children }: { readonly children: ReactNode }) {
  return <p className="studio-setting-unavailable" role="status">{children}</p>;
}

export function GeneralSettings() {
  return <><SettingGroup title="Workspace"><Row label="Default file open destination" description="Open files in the system default editor."><button type="button" disabled>System editor</button></Row><Row label="Language" description="Prime Studio currently follows the operating-system language."><button type="button" disabled>Auto detect</button></Row></SettingGroup><SettingGroup title="Window"><Row label="Panel layout" description="Panel widths and open states are saved locally and adapt to the available window size." /></SettingGroup></>;
}

export function AppearanceSettings({ theme, onTheme }: { readonly theme: string; readonly onTheme?: (theme: "dark" | "light" | "system") => void }) {
  return <SettingGroup title="Theme"><div className="studio-theme-options" role="radiogroup" aria-label="Theme">{(["system", "dark", "light"] as const).map((value) => <button type="button" role="radio" aria-checked={theme === value} key={value} onClick={() => onTheme?.(value)}><span className={`studio-theme-preview studio-theme-${value}`} />{value[0].toUpperCase() + value.slice(1)}</button>)}</div><Row label="Reduced motion" description="Prime Studio follows your operating-system motion preference."><button type="button" disabled>System</button></Row></SettingGroup>;
}

export function ComposerSettings() {
  return <><SettingGroup title="Sending"><Row label="Send shortcut" description="Press Enter to send. Use Shift+Enter for a new line."><button type="button" disabled>Enter</button></Row><Row label="Drafts" description="Draft text and attachments stay isolated to each chat." /></SettingGroup><SettingGroup title="Suggestions"><Row label="Suggested prompts" description="Suggestions require a connected Harness and are not synthesized locally."><button type="button" disabled>Unavailable</button></Row></SettingGroup></>;
}

export function AccountsSettings({ accounts, defaultAccount, onChanged, onDefaultAccount }: {
  readonly accounts: readonly Account[];
  readonly defaultAccount: string | null;
  readonly onChanged: (accounts?: Account[]) => void;
  readonly onDefaultAccount: (accountId: string | null) => void;
}) {
  return <div className="studio-accounts-settings"><Accounts
    accounts={[...accounts]}
    onChanged={onChanged}
    onUse={() => undefined}
    newSessionDisabledReason="New session activation is not connected yet."
    defaultAccount={defaultAccount}
    onDefaultAccount={onDefaultAccount}
  /></div>;
}

export function HarnessSettings({ compatibility }: { readonly compatibility: HarnessCompatibility }) {
  const connected = compatibility.status === "ready";
  return <><Unavailable>{connected ? "Harness settings are read-only until the runtime settings contract is enabled." : "A verified Harness connection is required before these controls can be changed."}</Unavailable><SettingGroup title="Agent runtime"><Row label="Maximum concurrent agents" description="The Harness remains the authority for concurrency and admission."><input aria-label="Maximum concurrent agents" type="number" value={1} disabled readOnly /></Row><Row label="Automatic retry" description="Retry policy is reported by the verified runtime."><button type="button" disabled>Unavailable</button></Row><Row label="Context discovery" description="Context sources appear only after capability negotiation."><button type="button" disabled>Unavailable</button></Row></SettingGroup></>;
}

export function ModelsSettings({ compatibility }: { readonly compatibility: HarnessCompatibility }) {
  return <><Unavailable>{compatibility.status === "ready" ? "No verified model catalog is attached to this settings route." : "Model availability requires a verified Harness connection."}</Unavailable><SettingGroup title="Default model"><Row label="Provider" description="No provider has been verified for new sessions."><button type="button" disabled>Unavailable</button></Row><Row label="Thinking level" description="Supported values come from the selected model, never a static local list."><button type="button" disabled>Unavailable</button></Row></SettingGroup></>;
}

export function IntegrationsSettings() {
  return <SettingGroup title="Connected capabilities"><Row label="Tools" description="Tool definitions and effects are projected from the verified Harness session."><button type="button" disabled>Not connected</button></Row><Row label="Git" description="No independent Git write authority is enabled."><button type="button" disabled>Unavailable</button></Row><Row label="Environments" description="Execution environments require explicit runtime capabilities."><button type="button" disabled>Unavailable</button></Row></SettingGroup>;
}

export function SecuritySettings({ compatibility }: { readonly compatibility: HarnessCompatibility }) {
  return <><SettingGroup title="Runtime identity"><Row label="Compatibility" description="Prime Studio binds runtime behavior to verified hashes, protocol schema, and capabilities."><span className="studio-setting-value">{compatibility.status.replace(/_/gu, " ")}</span></Row><Row label="Authority" description="Unavailable capabilities fail closed; the renderer cannot mint native authority."><span className="studio-setting-value">Phase zero</span></Row></SettingGroup><SettingGroup title="Diagnostics"><Row label="Credentials" description="Credential values remain outside renderer projections and logs."><span className="studio-setting-value">Protected</span></Row></SettingGroup></>;
}

export function ShortcutsSettings() {
  const rows = [["Open command palette", "Ctrl+K"], ["Open settings", "Ctrl+,"], ["Toggle projects", "Ctrl+B"], ["Toggle Harness", "Ctrl+J"], ["New chat", "Ctrl+N"]];
  return <SettingGroup title="Application"><div className="studio-shortcut-list">{rows.map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div></SettingGroup>;
}

export function AboutSettings({ compatibility }: { readonly compatibility: HarnessCompatibility }) {
  return <><SettingGroup title="Prime Studio"><Row label="Version" description="Development source snapshot."><span className="studio-setting-value">0.1.0</span></Row><Row label="Prime Harness" description="Connection status from the local verified adapter."><span className="studio-setting-value">{compatibility.status.replace(/_/gu, " ")}</span></Row><Row label="Updates" description="Automatic updates are not enabled in this source snapshot."><span className="studio-setting-value">Disabled</span></Row></SettingGroup><SettingGroup title="Open source"><Row label="License" description="Prime Studio source is available under the MIT License."><span className="studio-setting-value">MIT</span></Row><Row label="Third-party notices" description="Bundled dependency notices are included with the application." /></SettingGroup></>;
}

export { SettingGroup, Row };

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  NATIVE_BROWSER_UNAVAILABLE,
  nativeBrowserAdmissionClient,
} from "../browser/nativeClient";
import * as rpc from "../rpc";
import { PROVIDER_NAME } from "../accounts";
import { THINKING_LEVELS } from "../types";
import { Accounts } from "./Accounts";
import { CliSettings } from "./CliSettings";
import { PRIME_AGENT_URL } from "./primeAgent";
import { useTopmostSurfaceEscape } from "../surfaceEscape";
import { useModalSurfaceFocus } from "../modalSurface";
import { SECTIONS } from "./settingsSections";
import type { SettingsSection } from "./settingsSections";
import type { Account, AppSettings, CliStatus, KernelStatus, ModelInfo } from "../types";

export { isSection, SECTIONS } from "./settingsSections";
export type { SettingsSection } from "./settingsSections";

/** Describe connected capabilities at the boundary the current runtime exposes. */
function ConnectedTools() {
  const [browserStatus, setBrowserStatus] = useState(NATIVE_BROWSER_UNAVAILABLE);

  useEffect(() => {
    let mounted = true;
    nativeBrowserAdmissionClient
      .readSecurityStatus()
      .then((status) => {
        if (mounted) setBrowserStatus(status);
      })
      .catch(() => {
        if (mounted) setBrowserStatus(NATIVE_BROWSER_UNAVAILABLE);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <>
      <p className="pane-lede">
        Integrations reach Prime as Python packages imported into the kernel, not as separate
        tools — the model calls them from a cell, like anything else.
      </p>

      <div className="pane-label">HTTP MCP SERVERS</div>
      <p className="rail-empty">
        None configured. Prime reads these from its own settings file, so anything added there
        appears to the kernel as an importable skill.
      </p>

      <div className="pane-label">NATIVE BROWSER</div>
      <div className="acct">
        <div className="acct-main">
          <span className="acct-label">Intent admission boundary</span>
          <span className="pill pill-expired">{browserStatus.admissionReadiness}</span>
        </div>
        <div className="muted small">
          Executor: <code>{browserStatus.executorReadiness}</code>. No browser effect dispatch route
          is installed.
        </div>
      </div>

      <div className="pane-label">NOT SUPPORTED YET</div>
      <div className="warn-card">
        <p>
          Local <code>stdio</code> MCP servers are dropped before they reach the kernel, so an
          entry pointing at a local subprocess silently does nothing. Only HTTP servers arrive.
        </p>
        <p>
          Studio can report whether a native browser intent reaches its admission boundary, but it
          cannot execute that intent. There is no browser or computer-use tool, screenshot view, or
          click affordance to imply otherwise.
        </p>
      </div>
    </>
  );
}

const T3_CODE_URL = "https://github.com/pingdotgg/t3code";

const THEMES: { id: string; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

/** One labelled control per row. */
function Row({
  label,
  hint,
  controlId,
  children,
}: {
  label: string;
  hint?: string;
  controlId?: string;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      {controlId ? (
        <div className="set-label">
          <label htmlFor={controlId}>{label}</label>
          {hint && <div className="muted small">{hint}</div>}
        </div>
      ) : (
        <div className="set-label">
          {label}
          {hint && <div className="muted small">{hint}</div>}
        </div>
      )}
      <div className="set-control">{children}</div>
    </div>
  );
}

/**
 * Prime's only built-in tool is `ipython`, so this pane is not a nicety: a Python
 * without ipykernel means zero tool calls.
 *
 * Read-only by design — the prime child inherits Prime Studio's environment, so
 * `PRIME_AGENT_KERNEL_PYTHON` has to be set before the app starts. The pane says
 * so rather than offering a control that would silently do nothing.
 */
function Kernel() {
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setStatus(await rpc.kernelStatus());
    setBusy(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const ok = !!status?.ipykernel;

  return (
    <section className="acct-group">
      <h3>IPython kernel</h3>

      {!status ? (
        <div className="muted small pad">Probing…</div>
      ) : (
        <>
          <div className="acct">
            <div className="acct-main">
              <span className="acct-label">
                <code>{status.python || "—"}</code>
              </span>
              <span className={`pill pill-${ok ? "authed" : "expired"}`}>
                {ok ? "Working" : "Not usable"}
              </span>
            </div>
            <div className="muted small">
              Resolved from {status.source || "nothing"} · {status.exists ? "file exists" : "no such file"}
              {status.version ? ` · Python ${status.version}` : ""}
              {status.ipykernel ? ` · ipykernel ${status.ipykernel}` : ""}
            </div>
          </div>

          {status.error && <pre className="cli-error">{status.error}</pre>}

          {!ok && (
            <div className="empty-state">
              <strong>Prime cannot run a single tool call without this.</strong> Reading files,
              editing, running commands and spawning subagents all happen as code inside one
              IPython kernel — it is prime's only built-in tool, so a missing kernel is not a
              degraded mode, it is no tools at all.
              {status.exists ? (
                <>
                  {" "}
                  That interpreter runs but has no <code>ipykernel</code> — a half-bootstrapped
                  venv. prime finishes the job itself the next time it starts a session (it
                  installs ipykernel and its own runtime), so this usually clears on its own. If it
                  does not, point <code>PRIME_AGENT_KERNEL_PYTHON</code> at a Python that has
                  ipykernel and restart Prime Studio.
                </>
              ) : (
                <>
                  {" "}
                  Nothing is there yet. prime bootstraps this venv itself the first time it starts a
                  session — that needs internet once, and works offline afterwards.
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="acct-actions">
        <button className="btn" disabled={busy} onClick={() => void load()}>
          Re-check
        </button>
      </div>

      <p className="muted small">
        Resolution order is prime's own: <code>PRIME_AGENT_KERNEL_PYTHON</code> wins outright,
        otherwise prime uses the venv at <code>PRIME_AGENT_KERNEL_VENV</code> or{" "}
        <code>~/.prime/agent/kernel-venv</code>, bootstrapping it if needed.{" "}
        <strong>This is read-only.</strong> The prime child inherits Prime Studio's environment, so
        setting <code>PRIME_AGENT_KERNEL_PYTHON</code> means setting it before the app launches — a
        value typed here could not reach an already-running process, and a shell opened before you
        set it will not have it either.
      </p>
    </section>
  );
}

function About({ cli }: { cli: CliStatus | null }) {
  const [app, setApp] = useState<string | null>(null);
  const [prime, setPrime] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setApp)
      .catch(() => setApp(null));
  }, []);

  useEffect(() => {
    if (!cli?.path) return;
    rpc
      .checkPrimeCli(null)
      .then(setPrime)
      .catch(() => setPrime(null));
  }, [cli?.path]);

  return (
    <section className="acct-group">
      <h3>About</h3>
      <Row label="Prime Studio">
        <span className="muted">{app ?? "unknown"} · MIT licensed</span>
      </Row>
      <Row label="prime-agent" hint="Installed separately — Prime Studio ships none of its code.">
        <span className="muted">{prime ?? (cli?.path ? "checking…" : "not found")}</span>
      </Row>

      <div className="acct-actions">
        <button className="btn" onClick={() => void rpc.openExternal(PRIME_AGENT_URL)}>
          prime-agent repository
        </button>
        <button className="btn" onClick={() => void rpc.openExternal(T3_CODE_URL)}>
          T3 Code repository
        </button>
      </div>

      <p className="muted small">
        Prime Studio is a client for{" "}
        <strong>prime-agent</strong> — MIT, Copyright (c) 2025 Mario Zechner. All agent behaviour,
        tool execution and model access is prime-agent's; you install it yourself.
      </p>
      <p className="muted small">
        <strong>T3 Code</strong> — comparative product research only; no source, assets, generated
        output, or style values are imported. Its material remains outside this repository.
      </p>
      <p className="muted small">
        Prime Studio itself is MIT licensed. It adds no approval or permission gating, because
        prime's protocol has none to expose — every tool call executes immediately and the tool
        cards exist so that at least nothing is hidden.
      </p>
    </section>
  );
}

/**
 * The settings surface: persistent left nav, one pane at a time, and the section
 * you left it on comes back (persisted with everything else in the settings file).
 */
export function Settings({
  section,
  onSection,
  onClose,
  accounts,
  onAccountsChanged,
  onUse,
  cli,
  onCli,
  models,
  settings,
  onSetting,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  accounts: Account[];
  onAccountsChanged: (refreshed?: Account[]) => void;
  onUse: (id: string) => void;
  cli: CliStatus | null;
  onCli: (s: CliStatus) => void;
  models: ModelInfo[];
  settings: AppSettings;
  onSetting: (key: keyof AppSettings, value: string | null) => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useTopmostSurfaceEscape(backdropRef, onClose);
  const keepFocusInside = useModalSurfaceFocus(backdropRef, dialogRef, closeRef);

  const modelValue =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider} ${settings.defaultModel}`
      : "";

  return (
    <div ref={backdropRef} className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal-wide settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong id={titleId}>Settings</strong>
          <div className="spacer" />
          <button
            ref={closeRef}
            className="btn btn-icon"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item ${s.id === section ? "on" : ""}`}
                onClick={() => onSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {section === "accounts" && (
              <Accounts
                accounts={accounts}
                onChanged={onAccountsChanged}
                onUse={onUse}
                defaultAccount={settings.defaultAccount ?? null}
                onDefaultAccount={(id) => onSetting("defaultAccount", id)}
              />
            )}

            {section === "agent" && <CliSettings status={cli} onStatus={onCli} />}

            {section === "kernel" && <Kernel />}

            {section === "defaults" && (
              <section className="acct-group">
                <h3>New sessions</h3>

                <Row
                  label="Account"
                  hint="Which login new tabs open on."
                  controlId="settings-default-account"
                >
                  <select
                    id="settings-default-account"
                    className="picker"
                    value={settings.defaultAccount ?? ""}
                    onChange={(e) => onSetting("defaultAccount", e.target.value || null)}
                  >
                    <option value="">First account in the list</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label} · {PROVIDER_NAME[a.provider] ?? a.provider}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row
                  label="Provider &amp; model"
                  controlId="settings-default-model"
                  hint="Applied only when it matches the tab's account provider — a ChatGPT profile has no Claude credential."
                >
                  <select
                    id="settings-default-model"
                    className="picker"
                    value={modelValue}
                    onChange={(e) => {
                      const [provider, id] = e.target.value.split(" ");
                      onSetting("defaultProvider", provider || null);
                      onSetting("defaultModel", id || null);
                    }}
                  >
                    <option value="">prime's own default</option>
                    {models.map((m) => (
                      <option key={`${m.provider}/${m.model}`} value={`${m.provider} ${m.model}`}>
                        {m.provider} · {m.name ?? m.model}
                      </option>
                    ))}
                  </select>
                  {models.length === 0 && (
                    <div className="muted small">
                      No model list — it comes from prime-agent, which has not resolved yet.
                    </div>
                  )}
                </Row>

                <Row label="Thinking level" controlId="settings-default-thinking">
                  <select
                    id="settings-default-thinking"
                    className="picker picker-sm"
                    value={settings.defaultThinking ?? "high"}
                    onChange={(e) => onSetting("defaultThinking", e.target.value)}
                  >
                    {THINKING_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row label="Working directory" hint="prime binds cwd at spawn, so this applies to new sessions.">
                  <div className="acct-actions">
                    <code className="set-path">{settings.defaultCwd ?? "none — prime's own cwd"}</code>
                    <button
                      className="btn"
                      onClick={() =>
                        void rpc.pickDirectory().then((d) => d && onSetting("defaultCwd", d))
                      }
                    >
                      Browse…
                    </button>
                    <button
                      className="btn"
                      disabled={!settings.defaultCwd}
                      onClick={() => onSetting("defaultCwd", null)}
                    >
                      Clear
                    </button>
                  </div>
                </Row>
              </section>
            )}

            {section === "tools" && <ConnectedTools />}

            {section === "appearance" && (
              <section className="acct-group">
                <h3>Appearance</h3>
                <Row label="Theme" hint="System follows the OS light/dark setting live.">
                  <div className="seg">
                    {THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={`seg-btn ${(settings.theme ?? "dark") === t.id ? "on" : ""}`}
                        onClick={() => onSetting("theme", t.id)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </Row>
                <p className="muted small">
                  The ☀/☾ button in the top bar flips between dark and light directly; it does not
                  change this back to System.
                </p>
              </section>
            )}

            {section === "about" && <About cli={cli} />}
          </div>
        </div>
      </div>
    </div>
  );
}

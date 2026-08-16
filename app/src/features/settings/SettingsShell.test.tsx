import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessCompatibility, RuntimeIdentity } from "../../shared/ipc/harness.generated";
import type { StudioOperation, StudioOperationOutcome } from "../../contracts/studioOperations";
import { SettingsShell } from "./SettingsShell";
import { settingsSections } from "./settingsRegistry";

const appApi = vi.hoisted(() => ({ getVersion: vi.fn() }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: appApi.getVersion }));

const unavailable: HarnessCompatibility = { status: "unavailable", reason: "security_verification_failed" };

describe("SettingsShell", () => {
  beforeEach(() => {
    appApi.getVersion.mockReset();
    appApi.getVersion.mockResolvedValue("0.1.0");
  });

  it("reports the installed Studio version and exact verified Harness runtime identity", async () => {
    appApi.getVersion.mockResolvedValueOnce("9.8.7");
    const runtime: RuntimeIdentity = {
      packageName: "prime-agent",
      packageVersion: "0.7.1",
      packageDigest: `sha256:${"a".repeat(64)}`,
      entrypointDigest: `sha256:${"b".repeat(64)}`,
      protocolName: "prime-agent-daemon",
      protocolVersion: 7,
      schemaRevision: 13,
      schemaId: "prime-agent.schema.json",
      capabilities: ["attach_snapshot", "event_sequence"],
    };
    const onExecute = vi.fn(async () => ({ status: "updated" as const, revision: "licenses" }));

    render(<SettingsShell
      section="about"
      onBack={() => undefined}
      onSection={() => undefined}
      compatibility={{ status: "ready", profile: "verified-runtime", capabilities: runtime.capabilities }}
      runtime={runtime}
      onExecute={onExecute}
    />);

    expect(await screen.findByText("9.8.7", { exact: true })).toBeVisible();
    expect(screen.getByText("prime-agent 0.7.1", { exact: true })).toBeVisible();
    expect(screen.getByText(runtime.packageDigest, { exact: true })).toBeVisible();
    expect(screen.getByText(runtime.entrypointDigest, { exact: true })).toBeVisible();
    expect(screen.getByText("prime-agent-daemon v7", { exact: true })).toBeVisible();
    expect(screen.getByText("prime-agent.schema.json r13", { exact: true })).toBeVisible();
    expect(screen.getByText("Unavailable \u00b7 no signed update channel configured", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Open license notices" }));
    expect(onExecute).toHaveBeenCalledOnce();
    expect(onExecute).toHaveBeenCalledWith({ action: "route.external-docs.open", payload: { document: "licenses" } });
  });

  it("renders a top-level searchable settings route and returns to chat", async () => {
    const onBack = vi.fn();
    const onSection = vi.fn();
    render(<SettingsShell section="general" onBack={onBack} onSection={onSection} compatibility={unavailable} />);

    expect(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "runtime identity");
    expect(screen.getByRole("button", { name: /Privacy & security/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Appearance/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps unavailable Harness and model controls disabled with reasons", () => {
    render(<SettingsShell section="harness" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Harness" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Maximum concurrent agents" })).toBeDisabled();
    expect(screen.getAllByText(/verified Harness connection/i).length).toBeGreaterThan(0);
  });

  it("lists every registry shortcut with the same truthful availability used by execution", () => {
    render(<SettingsShell
      section="shortcuts"
      onBack={() => undefined}
      onSection={() => undefined}
      compatibility={unavailable}
      commandAvailability={{
        admissionConnected: false,
        disabledActions: { "catalog.chat.create": "Select a writable project before creating a chat." },
      }}
      settings={{ sendShortcut: "ctrl-enter" }}
      composerShortcutAvailability={{ enabled: false, reason: "Prompt admission is not connected." }}
    />);
    const application = screen.getByRole("heading", { name: "Application" }).parentElement!;
    const rows = Array.from(application.querySelectorAll("li"));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("New chat");
    expect(rows[0]).toHaveTextContent("Ctrl+N");
    expect(rows[0]).toHaveTextContent("Unavailable — Select a writable project before creating a chat.");
    expect(rows[0]).toHaveAttribute("aria-disabled", "true");
    expect(rows[1]).toHaveTextContent("Open command paletteAvailableCtrl+K");
    expect(rows[2]).toHaveTextContent("Toggle projectsAvailableCtrl+B");
    expect(rows[3]).toHaveTextContent("Toggle HarnessAvailableCtrl+J");
    expect(rows[4]).toHaveTextContent("Open settingsAvailableCtrl+,");
    expect(application).not.toHaveTextContent("Undo");
    const composer = screen.getByRole("heading", { name: "Composer" }).parentElement!;
    const composerRows = Array.from(composer.querySelectorAll("li"));
    expect(composerRows).toHaveLength(2);
    expect(composerRows[0]).toHaveTextContent("Send messageUnavailable — Prompt admission is not connected.Ctrl+Enter");
    expect(composerRows[0]).toHaveAttribute("aria-disabled", "true");
    expect(composerRows[1]).toHaveTextContent("New lineAvailableEnterShift+Enter");
  });

  it("keeps Harness and tool policy controls unavailable without a verified operation adapter", () => {
    const ready: HarnessCompatibility = { status: "ready", profile: "verified", capabilities: ["attach_snapshot", "event_sequence"] };
    const { rerender } = render(<SettingsShell section="harness" onBack={() => undefined} onSection={() => undefined} compatibility={ready} onSetting={vi.fn()} />);
    expect(screen.getByRole("spinbutton", { name: "Maximum concurrent agents" })).toBeDisabled();
    expect(screen.getByText(/verified settings adapter/i)).toBeVisible();

    rerender(<SettingsShell section="tools" onBack={() => undefined} onSection={() => undefined} compatibility={ready} onSetting={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Enable configurable tools" })).toBeDisabled();
    expect(screen.getByText(/verified settings adapter/i)).toBeVisible();
  });

  it("shows only verified session model choices and explains why creation defaults are disabled", () => {
    const ready: HarnessCompatibility = { status: "ready", profile: "verified", capabilities: ["model_catalog"] };
    render(<SettingsShell
      section="models"
      onBack={() => undefined}
      onSection={() => undefined}
      compatibility={ready}
      composer={{
        models: [{ id: "openai/gpt-live", label: "GPT Live", enabled: true }],
        selectedModel: "openai/gpt-live",
        thinkingLevels: ["low", "high"],
        selectedThinking: "high",
        supportedCommands: ["model", "effort", "compact", "fork", "export"],
      }}
    />);

    expect(screen.getByRole("option", { name: "GPT Live" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "OpenAI Codex" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default model" })).toBeDisabled();
    expect(screen.getByText(/creation route accepts workspace and title only/i)).toBeVisible();
    expect(screen.getByText(/compact · fork · export/i)).toBeVisible();
  });

  it("routes account-wide usage independently from current-chat usage", async () => {
    render(<SettingsShell section="usage" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
    expect(await screen.findByText(/No verified usage in this window/)).toBeVisible();
    expect(screen.queryByText(/^Current chat$/i)).not.toBeInTheDocument();
  });

  it("keeps Accounts Use unavailable until resident creation can bind an account identity", () => {
    const onSetting = vi.fn();
    render(<SettingsShell section="accounts" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} accounts={[{ id: "account-1", label: "Work", provider: "openai-codex", agentDir: "C:\\fixture", createdAt: 1 }]} onSetting={onSetting} />);
    expect(screen.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
    expect(screen.getByText("Work")).toBeVisible();
    const use = screen.getByRole("button", { name: "Use for new sessions" });
    expect(use).toBeDisabled();
    expect(use).toHaveAttribute("title", expect.stringMatching(/accepts workspace and title only/i));
    expect(onSetting).not.toHaveBeenCalled();
    expect(screen.getAllByText(/does not accept an account or profile identity/i)).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Account name" })).toBeVisible();
  });

  it("wires every General default through its owned persistence or dialog boundary", async () => {
    const onSetting = vi.fn();
    const onExecute = vi.fn(async (operation: StudioOperation): Promise<StudioOperationOutcome> => operation.action === "settings.default-workspace.pick"
      ? { status: "updated", revision: "C:\work\prime" }
      : { status: "updated", revision: "layout" });
    render(<SettingsShell
      section="general"
      onBack={() => undefined}
      onSection={() => undefined}
      compatibility={unavailable}
      onSetting={onSetting}
      onExecute={onExecute}
      settings={{ theme: "system", density: "comfortable", sendShortcut: "enter", reducedMotion: "disabled", defaultCwd: "D:\old" }}
      layout={{ schemaVersion: 1, sidebarOpen: true, sidebarWidth: 264, inspectorOpen: true, inspectorWidth: 384, editorOpen: false, editorWidth: 400, expandedProjectIds: [] }}
    />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "light");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Density" }), "compact");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Send shortcut" }), "ctrl-enter");
    await userEvent.click(screen.getByRole("switch", { name: "Reduced motion" }));
    fireEvent.change(screen.getByRole("slider", { name: "Projects panel width" }), { target: { value: "320" } });
    await userEvent.click(screen.getByRole("button", { name: "Browse default workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask each time" }));

    expect(onSetting).toHaveBeenCalledWith("theme", "light");
    expect(onSetting).toHaveBeenCalledWith("density", "compact");
    expect(onSetting).toHaveBeenCalledWith("sendShortcut", "ctrl-enter");
    expect(onSetting).toHaveBeenCalledWith("reducedMotion", "enabled");
    await waitFor(() => expect(onSetting).toHaveBeenCalledWith("defaultCwd", "C:\work\prime"));
    expect(onSetting).toHaveBeenCalledWith("defaultCwd", null);
    expect(onExecute).toHaveBeenCalledWith({ action: "settings.default-workspace.pick", payload: {} });
    expect(onExecute).toHaveBeenCalledWith({ action: "layout.sidebar.resize", payload: { width: 320 } });
    expect(onExecute).toHaveBeenCalledWith({ action: "layout.panels.reset", payload: {} });
    expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
  });

  it("wires appearance and composer controls to typed persistence instead of local cosmetic state", async () => {
    const onSetting = vi.fn();
    const base = { onBack: () => undefined, onSection: () => undefined, compatibility: unavailable, onSetting };
    const { rerender } = render(<SettingsShell section="appearance" {...base}
      settings={{ accent: "prime-violet", fontSize: "medium", timestamps: "enabled", bubbles: "disabled" }} />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Accent" }), "ember");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Font size" }), "large");
    await userEvent.click(screen.getByRole("switch", { name: "Show timestamps" }));
    await userEvent.click(screen.getByRole("switch", { name: "Compact message bubbles" }));

    expect(onSetting).toHaveBeenCalledWith("accent", "ember");
    expect(onSetting).toHaveBeenCalledWith("fontSize", "large");
    expect(onSetting).toHaveBeenCalledWith("timestamps", "disabled");
    expect(onSetting).toHaveBeenCalledWith("bubbles", "enabled");

    rerender(<SettingsShell section="composer" {...base}
      settings={{ sendShortcut: "enter", promptSuggestions: "enabled", tokenEstimate: "enabled", voice: "enabled", spell: "enabled" }} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Send shortcut" }), "ctrl-enter");
    await userEvent.click(screen.getByRole("switch", { name: "Suggested prompts" }));
    await userEvent.click(screen.getByRole("switch", { name: "Voice control" }));
    await userEvent.click(screen.getByRole("switch", { name: "Spell check" }));

    expect(onSetting).toHaveBeenCalledWith("sendShortcut", "ctrl-enter");
    expect(onSetting).toHaveBeenCalledWith("promptSuggestions", "disabled");
    expect(onSetting).toHaveBeenCalledWith("voice", "disabled");
    expect(onSetting).toHaveBeenCalledWith("spell", "disabled");
  });

  it("disables persisted settings whose runtime has no verified application path", () => {
    const onSetting = vi.fn();
    const base = { onBack: () => undefined, onSection: () => undefined, compatibility: unavailable, onSetting };
    const { rerender } = render(<SettingsShell section="general" {...base} />);
    expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
    expect(screen.getByText(/not applied by the current runtime/i)).toBeVisible();

    rerender(<SettingsShell section="composer" {...base} />);
    expect(screen.getByRole("switch", { name: "Drafts" })).toBeDisabled();

    rerender(<SettingsShell section="git" {...base} />);
    expect(screen.getByRole("switch", { name: "Automatic Git status refresh" })).toBeDisabled();

    rerender(<SettingsShell section="environments" {...base} />);
    expect(screen.getByRole("combobox", { name: "Agent environment" })).toBeDisabled();

    rerender(<SettingsShell section="privacy" {...base} />);
    expect(screen.getByRole("switch", { name: "Telemetry" })).toBeDisabled();
    expect(onSetting).not.toHaveBeenCalled();
  });

  it("shows each tools and safety destination as its own route", () => {
    const { rerender } = render(<SettingsShell section="tools" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Tools", level: 1 })).toBeVisible();
    rerender(<SettingsShell section="git" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Git", level: 1 })).toBeVisible();
    rerender(<SettingsShell section="environments" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Environments", level: 1 })).toBeVisible();
    rerender(<SettingsShell section="privacy" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Privacy & security", level: 1 })).toBeVisible();
  });

  it.each(settingsSections)("renders the $label destination from the 13-page registry", ({ id, label }) => {
    render(<SettingsShell section={id} onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: label, level: 1 })).toBeVisible();
    expect(document.querySelector('.studio-settings-content')).toHaveAttribute("data-settings-section", id);
  });

  it("maps every rendered settings-owned action to a stable control id", () => {
    const { rerender } = render(<SettingsShell section="general" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    for (const section of settingsSections) {
      rerender(<SettingsShell section={section.id} onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
      const actionControls = [...document.querySelectorAll<HTMLElement>('.studio-settings [data-action]')];
      expect(actionControls.length).toBeGreaterThan(0);
      for (const control of actionControls) {
        expect(control.dataset.controlId, `${section.id}: ${control.getAttribute("aria-label") ?? control.textContent}`).toBeTruthy();
      }
    }
  });

});

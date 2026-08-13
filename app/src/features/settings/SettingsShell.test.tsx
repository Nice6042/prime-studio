import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { SettingsShell } from "./SettingsShell";
import { settingsSections } from "./settingsRegistry";

const unavailable: HarnessCompatibility = { status: "unavailable", reason: "security_verification_failed" };

describe("SettingsShell", () => {
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

  it("lists only explicitly placed application shortcuts from the command registry", () => {
    render(<SettingsShell section="shortcuts" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    const application = screen.getByRole("heading", { name: "Application" }).parentElement!;
    expect(application).toHaveTextContent("New chatCtrl+N");
    expect(application).toHaveTextContent("Open command paletteCtrl+K");
    expect(application).toHaveTextContent("Toggle projectsCtrl+B");
    expect(application).toHaveTextContent("Toggle HarnessCtrl+J");
    expect(application).toHaveTextContent("Open settingsCtrl+,");
    expect(application).not.toHaveTextContent("Undo");
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

  it("persists Accounts Use as the selected new-session preference without claiming unsupported creation binding", async () => {
    const onSetting = vi.fn();
    render(<SettingsShell section="accounts" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} accounts={[{ id: "account-1", label: "Work", provider: "openai-codex", agentDir: "C:\\fixture", createdAt: 1 }]} onSetting={onSetting} />);
    expect(screen.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
    expect(screen.getByText("Work")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Use for new sessions" }));
    expect(onSetting).toHaveBeenCalledWith("defaultAccount", "account-1");
    expect(screen.getByText(/cannot pass an account identity during resident creation/i)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Account name" })).toBeVisible();
  });

  it("wires preference controls to typed persistence instead of local cosmetic state", async () => {
    const onSetting = vi.fn();
    render(<SettingsShell section="composer" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable}
      settings={{ sendShortcut: "enter", promptSuggestions: "enabled", tokenEstimate: "enabled" }} onSetting={onSetting} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Send shortcut" }), "ctrl-enter");
    await userEvent.click(screen.getByRole("switch", { name: "Suggested prompts" }));
    expect(onSetting).toHaveBeenCalledWith("sendShortcut", "ctrl-enter");
    expect(onSetting).toHaveBeenCalledWith("promptSuggestions", "disabled");
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

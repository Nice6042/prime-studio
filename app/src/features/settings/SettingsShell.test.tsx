import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HarnessCompatibility } from "../../shared/ipc/harness.generated";
import { SettingsShell } from "./SettingsShell";

const unavailable: HarnessCompatibility = { status: "unavailable", reason: "security_verification_failed" };

describe("SettingsShell", () => {
  it("renders a top-level searchable settings route and returns to chat", async () => {
    const onBack = vi.fn();
    const onSection = vi.fn();
    render(<SettingsShell section="general" onBack={onBack} onSection={onSection} compatibility={unavailable} />);

    expect(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "runtime identity");
    expect(screen.getByRole("button", { name: /Security/ })).toBeVisible();
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

  it("routes account-wide usage independently from current-chat usage", () => {
    render(<SettingsShell section="usage" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} />);
    expect(screen.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
    expect(screen.getByText(/Account-wide usage is unavailable/)).toBeVisible();
    expect(screen.queryByText(/^Current chat$/i)).not.toBeInTheDocument();
  });

  it("retains hardened account management while disabling unverified session creation", () => {
    render(<SettingsShell section="accounts" onBack={() => undefined} onSection={() => undefined} compatibility={unavailable} accounts={[{ id: "account-1", label: "Work", provider: "openai-codex", agentDir: "C:\\fixture", createdAt: 1 }]} />);
    expect(screen.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
    expect(screen.getByText("Work")).toBeVisible();
    expect(screen.getByRole("button", { name: "New session" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Account name" })).toBeVisible();
  });
});

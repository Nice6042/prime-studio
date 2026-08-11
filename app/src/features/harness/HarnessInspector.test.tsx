import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import { HarnessInspector } from "./HarnessInspector";
import { createInspectorState, reduceInspector } from "./inspectorStore";

const session: RootSessionProjection = {
  sessionId: "root-a", accountId: "account-a", projectId: "project-a", chatId: "chat-a",
  cursor: { runtimeGeneration: "g1", sequence: 10 }, state: "working", freshness: "live",
  parentMessages: [{
    channel: "parent", kind: "assistant", id: "a1", streaming: true, emittedAtMs: 10,
    blocks: [
      { kind: "thinking", text: "Checking the adapter boundary.", redacted: false },
      { kind: "tool_call", toolCallId: "call-1", toolId: "workspace.inspect", status: "running" },
    ],
  }],
  children: [
    { id: "child-1", status: "running", task: "Review protocol", provider: "OpenAI", model: "gpt-test", progress: null },
    { id: "child-2", status: "done", task: "Map files", provider: null, model: null, progress: 1 },
  ],
  queue: [{ id: "q1", label: "Follow up", state: "queued" }],
  tools: [{ id: "workspace.inspect", label: "Workspace inspect", enabled: true, configurable: false }],
  resources: [{ id: "r1", label: "Project files", kind: "workspace", availability: "available" }],
  usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165, cost: null },
};

const compatibility = {
  status: "ready" as const,
  profile: "fixture",
  capabilities: ["queue_management", "resource_snapshot"] as const,
};

describe("HarnessInspector", () => {
  it("renders truthful overview and opens child details only after selection", () => {
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} />);
    const inspector = screen.getByRole("region", { name: "Harness inspector content" });
    expect(within(inspector).getByText("2 agents")).toBeVisible();
    expect(within(inspector).queryByText("Provider")).not.toBeInTheDocument();

    fireEvent.click(within(inspector).getByRole("button", { name: /Review protocol/ }));
    expect(within(inspector).getByRole("heading", { name: "Review protocol" })).toBeVisible();
    expect(within(inspector).getByText("OpenAI")).toBeVisible();
    expect(within(inspector).getByText("Child transcript is not available until the verified child paging capability is connected.")).toBeVisible();
  });

  it("keeps Usage scoped to the current chat and unknown cost unavailable", () => {
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} />);
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(screen.getByText("165")).toBeVisible();
    expect(screen.getByText("Cost unavailable")).toBeVisible();
    expect(screen.getByText("Current chat only")).toBeVisible();
  });

  it("moves reasoning and tools into Activity instead of the parent chat", () => {
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} />);
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Checking the adapter boundary.")).toBeVisible();
    expect(screen.getByText("workspace.inspect")).toBeVisible();
  });

  it("renders a non-numeric unavailable state when no root session exists", () => {
    render(<HarnessInspector chatId="chat-a" session={null} compatibility={{ status: "unavailable", reason: "not_installed" }} />);
    expect(screen.getByText("No Harness session is attached to this chat.")).toBeVisible();
    expect(screen.queryByText("0 tokens")).not.toBeInTheDocument();
  });
});

describe("inspector route state", () => {
  it("returns to overview if the selected child disappears", () => {
    const selected = reduceInspector(createInspectorState(), { type: "child/open", childId: "child-1" });
    const reconciled = reduceInspector(selected, { type: "children/reconciled", childIds: [] });
    expect(reconciled.route).toEqual({ kind: "overview" });
    expect(reconciled.notice).toBe("The selected child is no longer available.");
  });
});

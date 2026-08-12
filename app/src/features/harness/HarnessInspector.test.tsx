import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RootSessionProjection } from "../../entities/harness/types";
import type { StudioOperation } from "../../contracts/studioOperations";
import { reconcileAttentionSnapshot } from "../../attention/attentionLedger";
import {
  type HarnessInspectorAdapter,
  type HarnessPanelDetails,
} from "./adapter";
import { HarnessInspector } from "./HarnessInspector";
import { createInspectorState, reduceInspector } from "./inspectorStore";

const session: RootSessionProjection = {
  sessionId: "root-a", accountId: "account-a", projectId: "project-a", chatId: "chat-a",
  cursor: { runtimeGeneration: "g1", sequence: 10 }, state: "working", freshness: "live",
  parentMessages: [{
    channel: "parent", kind: "assistant", id: "a1", streaming: true, emittedAtMs: 1_725_700_500_000,
    blocks: [
      { kind: "thinking", text: "Checking the adapter boundary.", redacted: false },
      { kind: "tool_call", toolCallId: "call-1", toolId: "workspace.inspect", status: "running" },
    ],
  }],
  children: [
    { id: "child-1", status: "running", task: "Review protocol", provider: "OpenAI", model: "gpt-test", progress: 0.42 },
    { id: "child-2", status: "done", task: "Map files", provider: null, model: null, progress: 1 },
    { id: "child-3", status: "error", task: "Verify release", provider: "OpenAI", model: "gpt-test", progress: 0.61 },
  ],
  queue: [{ id: "q1", label: "Follow up", state: "queued" }],
  tools: [{ id: "workspace.inspect", label: "Workspace inspect", enabled: true, configurable: true }],
  resources: [{ id: "r1", label: "AGENTS.md", kind: "context file", availability: "available" }],
  usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165, cost: null },
};

const details: HarnessPanelDetails = {
  observedAtMs: 1_725_700_800_000,
  startedAtMs: 1_725_700_000_000,
  context: { usedTokens: 15_200, capacityTokens: 40_000, turns: 12, samples: [0.18, 0.24, 0.31, 0.38] },
  contributions: [
    { id: "parent", label: "Main chat", tokens: 115 },
    { id: "children", label: "Subagents", tokens: 40 },
    { id: "tools", label: "Tools", tokens: 10 },
  ],
  notices: [{ id: "overload", kind: "warning", title: "Auto-compaction failed", detail: "server_is_overloaded", retryable: true, dismissible: true }],
  activity: [
    { id: "act-agent", occurredAtMs: 1_725_700_100_000, group: "Today", kind: "agent", title: "Review protocol spawned", detail: "rlm() child", childId: "child-1" },
    { id: "act-tool", occurredAtMs: 1_725_700_200_000, group: "Today", kind: "tool", title: "Workspace inspection", detail: "Completed", tool: { command: "rg --files", status: "succeeded", durationMs: 820, files: [{ candidateId: "candidate-tool-file", label: "src/protocol.ts" }] } },
    { id: "act-system", occurredAtMs: 1_725_700_250_000, group: "Today", kind: "system", title: "Snapshot synchronized", detail: "Harness projection refreshed" },
    { id: "act-file", occurredAtMs: 1_725_700_300_000, group: "Yesterday", kind: "file", title: "Protocol updated", detail: "src/protocol.ts", artifactCandidateId: "candidate-activity-file" },
  ],
  outputs: [{ id: "out-1", label: "Protocol report", candidateId: "candidate-output", kind: "file" }],
  sources: [{ id: "source-1", label: "Harness contract", detail: "Generated protocol schema", candidateId: "candidate-source", kind: "document" }],
  children: {
    "child-1": {
      summary: "Review the runtime protocol and report compatibility gaps.",
      startedAtMs: 1_725_700_040_000,
      context: { usedTokens: 6_400, capacityTokens: 40_000 },
      transcript: [
        { id: "child-msg-1", actor: "Harness", occurredAtMs: 1_725_700_050_000, text: "Task accepted." },
        { id: "child-msg-2", actor: "Agent", occurredAtMs: 1_725_700_060_000, text: "Reading the protocol schema." },
      ],
      activity: [{ id: "child-act-1", occurredAtMs: 1_725_700_070_000, label: "Opened protocol schema" }],
      files: [{ id: "child-file-1", label: "src/protocol.ts", candidateId: "candidate-child-file", change: "modified" }],
      error: null,
    },
    "child-3": {
      summary: "Verify the release candidate.", startedAtMs: 1_725_700_040_000,
      context: null, transcript: [], activity: [], files: [],
      error: { code: "worker_exited", message: "Worker exited without a final report.", retryable: true },
    },
  },
};

function adapter(commands: StudioOperation[] = []): HarnessInspectorAdapter {
  return {
    availability: { status: "available" },
    load: vi.fn(async () => details),
    execute: vi.fn(async (command) => {
      commands.push(command);
      return { status: "accepted" as const, commandId: `command-${commands.length}` };
    }),
  };
}

const compatibility = {
  status: "ready" as const,
  profile: "fixture",
  capabilities: ["queue_management", "resource_snapshot"] as const,
};

afterEach(() => localStorage.clear());

describe("HarnessInspector", () => {
  it("uses the product dispatcher seam for actions while retaining the adapter for projections", async () => {
    const source = adapter();
    const onExecute = vi.fn(async () => ({ status: "updated" as const, revision: 2 }));
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={source} onExecute={onExecute} />);
    await screen.findByText("This chat");

    await user.click(screen.getByRole("button", { name: "Compact context" }));

    expect(onExecute).toHaveBeenCalledWith({ action: "harness.session.compact", payload: { sessionId: "root-a" } });
    expect(source.execute).not.toHaveBeenCalled();
  });

  it("recreates the complete overview hierarchy from current-session projections", async () => {
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter()} />);
    const inspector = screen.getByRole("region", { name: "Harness inspector content" });

    expect(await within(inspector).findByText("This chat")).toBeVisible();
    expect(within(inspector).getByText("38%")).toBeVisible();
    expect(within(inspector).getByText("15.2k")).toBeVisible();
    expect(within(inspector).getByText("Active · 1")).toBeVisible();
    expect(within(inspector).getByText("Done · 2")).toBeVisible();
    expect(within(inspector).getByRole("button", { name: /Review protocol/ })).toBeVisible();
    expect(within(inspector).getByText("Queue")).toBeVisible();
    expect(within(inspector).getByText("Tools")).toBeVisible();
    expect(within(inspector).getAllByText("Context")).toHaveLength(2);
    expect(within(inspector).getByText("Outputs")).toBeVisible();
    expect(within(inspector).getByText("Sources")).toBeVisible();
  });

  it("routes every overview action through the typed adapter and reports success", async () => {
    const commands: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter(commands)} />);
    await screen.findByText("This chat");

    await user.click(screen.getByRole("button", { name: "Compact context" }));
    await user.click(screen.getByText("Queue"));
    await user.click(screen.getByRole("button", { name: "Run Follow up now" }));
    await user.click(screen.getByText("Tools"));
    await user.click(screen.getByRole("switch", { name: "Workspace inspect" }));

    expect(commands).toEqual(expect.arrayContaining([
      { action: "harness.session.compact", payload: { sessionId: "root-a" } },
      { action: "harness.queue.run-now", payload: { sessionId: "root-a", queueItemId: "q1" } },
      { action: "harness.tool.set-enabled", payload: { sessionId: "root-a", toolId: "workspace.inspect", enabled: false } },
    ]));
    expect(screen.getByText("Harness accepted the action.")).toBeVisible();
  });

  it("drills into private child chat, activity, and files and wires file open and stop", async () => {
    const commands: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter(commands)} />);
    await screen.findByText("This chat");

    await user.click(screen.getByRole("button", { name: /Review protocol/ }));
    expect(screen.getByRole("heading", { name: "Review protocol" })).toBeVisible();
    expect(screen.getByText("Task accepted.")).toBeVisible();
    expect(screen.getByText("Child tasks are managed by the harness")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Opened protocol schema")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    await user.click(screen.getByRole("button", { name: "Open src/protocol.ts" }));
    await user.click(screen.getByRole("button", { name: "Stop task" }));

    expect(commands).toEqual(expect.arrayContaining([
      { action: "editor.artifact.open", payload: { sessionId: "root-a", artifactId: "candidate-child-file" } },
      { action: "harness.child.stop", payload: { sessionId: "root-a", childId: "child-1" } },
    ]));
  });

  it("shows truthful child failure and exposes typed retry", async () => {
    const commands: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter(commands)} />);
    await screen.findByText("This chat");
    await user.click(screen.getByRole("button", { name: /Verify release/ }));

    expect(screen.getByRole("alert")).toHaveTextContent("Worker exited without a final report.");
    expect(screen.getByRole("button", { name: "Retry task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry task" })).toHaveAttribute("title", "The runtime did not provide a retry admission handle.");
    expect(commands).not.toContainEqual(expect.objectContaining({ action: "harness.overload.retry" }));
  });

  it("keeps Usage scoped to the current chat and separates account-wide usage", async () => {
    const onOpenAccountUsage = vi.fn();
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter()} onOpenAccountUsage={onOpenAccountUsage} />);
    await screen.findByText("This chat");
    await user.click(screen.getByRole("tab", { name: "Usage" }));

    expect(screen.getByText("Current chat")).toBeVisible();
    expect(screen.getByText("165")).toBeVisible();
    expect(screen.getByText("Cost unavailable")).toBeVisible();
    expect(screen.getByText("Main chat")).toBeVisible();
    expect(screen.getByText(/Subagent usage is included only when it belongs to this chat/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Settings.*Usage/ }));
    expect(onOpenAccountUsage).toHaveBeenCalledOnce();
  });

  it("filters activity, expands tool detail, copies commands, and opens affected files", async () => {
    const commands: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter(commands)} />);
    await screen.findByText("This chat");
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.queryByText("Review protocol spawned")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Workspace inspection/ }));
    expect(screen.getByText("rg --files")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    await user.click(screen.getByRole("button", { name: "Open src/protocol.ts" }));
    expect(commands).toEqual(expect.arrayContaining([
      { action: "activity.command.copy", payload: { activityId: "act-tool", command: "rg --files" } },
      { action: "activity.file.open", payload: { sessionId: "root-a", activityId: "act-tool", fileId: "candidate-tool-file" } },
    ]));
  });

  it("marks Activity seen only when broker-minted content evidence changes", async () => {
    const evidence = { runtimeGeneration: "g1", marker: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", occurredAtMs: 1_725_700_300_000 };
    const source = { ...adapter(), loadActivityEvidence: vi.fn(async () => evidence) };
    const attention = reconcileAttentionSnapshot({ revision: 7, records: [{ chatId: "chat-a", chatSeen: null, activitySeen: { ...evidence, marker: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }] });
    const onExecute = vi.fn(async () => ({ status: "updated" as const, revision: 8 }));
    const user = userEvent.setup();
    const view = render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={source} onExecute={onExecute} attention={attention} />);
    await screen.findByText("This chat");
    expect(await screen.findByRole("tab", { name: "Activity, unseen" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Activity, unseen" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith({ action: "activity.seen.mark", payload: { chatId: "chat-a", evidence } }));

    onExecute.mockClear();
    const seenAttention = reconcileAttentionSnapshot({ revision: 8, records: [{ chatId: "chat-a", chatSeen: null, activitySeen: evidence }] });
    view.rerender(<HarnessInspector chatId="chat-a" session={{ ...session, cursor: { ...session.cursor, sequence: 11 } }} compatibility={compatibility} adapter={source} onExecute={onExecute} attention={seenAttention} />);
    await waitFor(() => expect(source.loadActivityEvidence).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Activity, unseen" })).not.toBeInTheDocument();
    expect(onExecute).not.toHaveBeenCalledWith(expect.objectContaining({ action: "activity.seen.mark" }));

    view.unmount();
    onExecute.mockClear();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter()} onExecute={onExecute} attention={{ status: "unavailable", reason: "Activity content evidence unavailable." }} />);
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Activity content evidence unavailable.")).toBeVisible();
    expect(onExecute).not.toHaveBeenCalledWith(expect.objectContaining({ action: "activity.seen.mark" }));
  });

  it("routes system activity rows instead of leaving an interactive no-op", async () => {
    const commands: StudioOperation[] = [];
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter(commands)} />);
    await screen.findByText("This chat");
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    await user.click(screen.getByRole("button", { name: /Snapshot synchronized/ }));

    expect(commands).toContainEqual({ action: "activity.row.toggle", payload: { chatId: "chat-a", activityId: "act-system" } });
  });

  it("announces adapter errors and never presents an action as successful", async () => {
    const failing: HarnessInspectorAdapter = {
      availability: { status: "available" },
      load: vi.fn(async () => details),
      execute: vi.fn(async () => { throw new Error("Runtime disconnected"); }),
    };
    const user = userEvent.setup();
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={failing} />);
    await screen.findByText("This chat");
    await user.click(screen.getByRole("button", { name: "Compact context" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime disconnected");
  });

  it("renders explicit unavailable and loading states without invented zeroes", async () => {
    render(<HarnessInspector chatId="chat-a" session={null} compatibility={{ status: "unavailable", reason: "not_installed" }} />);
    expect(screen.getByText("No Harness session is attached to this chat.")).toBeVisible();
    expect(screen.queryByText("0 tokens")).not.toBeInTheDocument();

    const never = new Promise<HarnessPanelDetails>(() => undefined);
    const loading: HarnessInspectorAdapter = { availability: { status: "available" }, load: vi.fn(() => never), execute: vi.fn() };
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={loading} />);
    expect(screen.getByRole("status", { name: "Loading Harness details" })).toBeVisible();
  });

  it("shows the production silent-worker recovery blocker instead of a working retry claim", async () => {
    const source: HarnessInspectorAdapter = { ...adapter(), workerRecovery: {
      status: "unavailable",
      reason: "Prime Studio cannot safely retry a silent worker because the native Harness bridge does not expose a verified closure reason and retry identity.",
    } };
    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={source} />);

    expect(await screen.findByRole("status", { name: "Silent worker recovery unavailable" }))
      .toHaveTextContent("does not expose a verified closure reason and retry identity");
    expect(screen.queryByRole("button", { name: /retry silent worker/i })).not.toBeInTheDocument();
  });

  it("supports arrow-key tab navigation and restores the selected route per chat", async () => {
    const user = userEvent.setup();
    const view = render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter()} />);
    await screen.findByText("This chat");
    const harnessTab = screen.getByRole("tab", { name: "Harness" });
    harnessTab.focus();
    fireEvent.keyDown(harnessTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Usage" })).toHaveFocus();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    view.unmount();

    render(<HarnessInspector chatId="chat-a" session={session} compatibility={compatibility} adapter={adapter()} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true"));
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

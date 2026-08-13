import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HarnessPanelDetails } from "./adapter";
import { ActivityFeed } from "./ActivityFeed";

const day = 24 * 60 * 60 * 1000;
const observedAtMs = Date.UTC(2026, 7, 12, 12);
const base: HarnessPanelDetails = {
  observedAtMs, startedAtMs: null, context: null, extensionUi: { status: "available", requests: [] }, contributions: [], notices: [], outputs: [], sources: [], children: {},
  activity: [
    { id: "today", occurredAtMs: observedAtMs - 60_000, group: "Host supplied wrong group", kind: "tool", title: "Current tool", detail: "Running", seen: false },
    { id: "yesterday", occurredAtMs: observedAtMs - day, group: "Wrong", kind: "file", title: "Earlier file", detail: "Changed", seen: true },
  ],
};

const props = { sessionId: "session-1", filter: "all" as const, expandedId: null, onFilter: vi.fn(), onToggle: vi.fn(), onOpenChild: vi.fn(), onAction: vi.fn() };

describe("ActivityFeed", () => {
  it("groups by local calendar from observed evidence and distinguishes unseen from seen", () => {
    render(<ActivityFeed {...props} details={base} />);

    expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeVisible();
    expect(screen.queryByText("Host supplied wrong group")).not.toBeInTheDocument();
    expect(within(screen.getByText("Current tool").closest("article")!).getByText("New")).toBeVisible();
    expect(screen.getByText("Earlier file").closest("article")).toHaveAttribute("data-seen", "true");
  });

  it("states when activity or seen evidence is absent", () => {
    const { rerender } = render(<ActivityFeed {...props} details={null} />);
    expect(screen.getByText("Activity evidence is unavailable for this chat.")).toBeVisible();

    rerender(<ActivityFeed {...props} details={{ ...base, activity: [{ ...base.activity[0], seen: undefined }] }} />);
    expect(screen.getByText("Seen status is unavailable for this activity.")).toBeVisible();
  });

  it("uses one sanitized command for visible text, title, direction isolation, and copy outcome", async () => {
    const user = userEvent.setup();
    let resolveCopy!: (value: { status: "updated"; revision: number }) => void;
    const onAction = vi.fn(() => new Promise<{ status: "updated"; revision: number }>((resolve) => { resolveCopy = resolve; }));
    const command = "[escaped] run [REDACTED_SECRET] \\n \\u{202E}";
    const activity = [{
      ...base.activity[0], id: "tool-one", tool: {
        command, redacted: true, status: "succeeded" as const, durationMs: null,
        files: [{ candidateId: "candidate-one", label: "result.txt" }],
      },
    }];
    render(<ActivityFeed {...props} expandedId="tool-one" onAction={onAction} details={{ ...base, activity }} />);

    const chip = screen.getByTitle(command);
    expect(chip).toHaveTextContent(command);
    expect(chip.querySelector("bdi")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Redacted")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(screen.queryByText("Command copied.")).not.toBeInTheDocument();
    resolveCopy({ status: "updated", revision: 1 });
    expect(await screen.findByRole("status")).toHaveTextContent("Command copied.");
    expect(onAction).toHaveBeenCalledWith(
      { action: "activity.command.copy", payload: { activityId: "tool-one", command } },
      "copy:tool-one",
    );
  });

  it("keeps copy failure and unavailable raw file evidence bound to the expanded activity", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn(async () => ({ status: "rejected" as const, reason: "Clipboard permission was denied.", retryable: false }));
    const activity = [{
      ...base.activity[0], id: "tool-two", tool: {
        command: "safe command", redacted: false, status: "failed" as const, durationMs: 4, files: [],
      },
    }];
    render(<ActivityFeed {...props} expandedId="tool-two" onAction={onAction} details={{ ...base, activity }} />);

    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard permission was denied.");
    expect(screen.getByTitle("safe command")).toBeVisible();
    expect(screen.getByText(/Affected files are unavailable because no native artifact candidate was admitted/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
  });

  it("keeps similar tool rows and their opaque file candidates identity-bound", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn(async () => ({ status: "updated" as const, revision: 1 }));
    const tool = { command: "read report", redacted: false, status: "succeeded" as const, durationMs: 1 };
    const activity = [
      { ...base.activity[0], id: "read-one", title: "Read", tool: { ...tool, files: [{ candidateId: "candidate-one", label: "report.md" }] } },
      { ...base.activity[0], id: "read-two", title: "Read", occurredAtMs: base.activity[0].occurredAtMs - 1, tool: { ...tool, files: [{ candidateId: "candidate-two", label: "report.md" }] } },
    ];
    render(<ActivityFeed {...props} expandedId="read-two" onAction={onAction} details={{ ...base, activity }} />);

    expect(screen.getAllByRole("button", { name: /Read/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Open report.md" }));
    expect(onAction).toHaveBeenCalledWith(
      { action: "activity.file.open", payload: { sessionId: "session-1", activityId: "read-two", fileId: "candidate-two" } },
      "file:read-two:candidate-two",
    );
  });

  it("retires stale copy completion when the same activity refreshes to another command", async () => {
    let resolveCopy!: (value: { status: "updated"; revision: number }) => void;
    const onAction = vi.fn(() => new Promise<{ status: "updated"; revision: number }>((resolve) => { resolveCopy = resolve; }));
    const activity = (command: string) => [{ ...base.activity[0], id: "refreshing-tool", tool: { command, redacted: false, status: "succeeded" as const, durationMs: 1, files: [] } }];
    const view = render(<ActivityFeed {...props} expandedId="refreshing-tool" onAction={onAction} details={{ ...base, activity: activity("old command") }} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    view.rerender(<ActivityFeed {...props} expandedId="refreshing-tool" onAction={onAction} details={{ ...base, activity: activity("new command") }} />);
    resolveCopy({ status: "updated", revision: 1 });

    expect(await screen.findByTitle("new command")).toBeVisible();
    expect(screen.queryByText("Command copied.")).not.toBeInTheDocument();
  });

  it("admits one copy operation under same-tick duplicate activation", () => {
    const onAction = vi.fn(() => new Promise<{ status: "updated"; revision: number }>(() => undefined));
    const activity = [{ ...base.activity[0], id: "locked-tool", tool: { command: "safe", redacted: false, status: "succeeded" as const, durationMs: 1, files: [] } }];
    render(<ActivityFeed {...props} expandedId="locked-tool" onAction={onAction} details={{ ...base, activity }} />);
    const copy = screen.getByRole("button", { name: "Copy command" });

    fireEvent.click(copy);
    fireEvent.click(copy);

    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

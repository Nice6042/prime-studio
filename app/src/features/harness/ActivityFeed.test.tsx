import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HarnessPanelDetails } from "./adapter";
import { ActivityFeed } from "./ActivityFeed";

const day = 24 * 60 * 60 * 1000;
const observedAtMs = Date.UTC(2026, 7, 12, 12);
const base: HarnessPanelDetails = {
  observedAtMs, startedAtMs: null, context: null, contributions: [], notices: [], outputs: [], sources: [], children: {},
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
});

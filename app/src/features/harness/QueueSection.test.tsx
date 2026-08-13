import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueueSection } from "./QueueSection";

describe("QueueSection", () => {
  it("renders encoding-safe pending and remove controls", () => {
    render(<QueueSection sessionId="session-1" queue={[{ id: "q1", label: "Review changes", state: "queued" }]} enabled pendingKey="queue:q1" onAction={() => undefined} />);
    const pending = screen.getByRole("button", { name: "Run Review changes now" });
    const remove = screen.getByRole("button", { name: "Remove Review changes" });
    expect(pending).toHaveTextContent("Running\u2026");
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove).not.toHaveTextContent("\u00d7");
  });
});

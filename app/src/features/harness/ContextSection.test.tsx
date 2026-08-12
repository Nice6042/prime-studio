import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ContextSection, OutputSourceSections } from "./ContextSection";

describe("Harness context and output resources", () => {
  it("keeps summary-only context resources unavailable instead of forging artifact identity", () => {
    render(<ContextSection sessionId="session" resources={[{ id: "summary", label: "AGENTS.md", kind: "contextFiles", availability: "available" }]} onAction={() => undefined} />);
    expect(screen.getByRole("button", { name: /AGENTS.md/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /AGENTS.md/ })).toHaveAttribute("title", expect.stringMatching(/identity-bound/i));
  });

  it("dispatches the context-source action only for a native candidate", async () => {
    const onAction = vi.fn();
    render(<OutputSourceSections details={{ observedAtMs: 1, startedAtMs: null, context: null, contributions: [], notices: [], activity: [], outputs: [], sources: [
      { id: "bound", label: "Rules", detail: "contextFiles", kind: "contextFiles", candidateId: "candidate-bound" },
      { id: "summary", label: "Prompt", detail: "prompts", kind: "prompts" },
    ], children: {} }} sessionId="session" onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: /Rules/ }));
    expect(onAction).toHaveBeenCalledWith({ action: "harness.context-source.open", payload: { sessionId: "session", sourceId: "candidate-bound" } }, "source:candidate-bound");
    expect(screen.getByRole("button", { name: /Prompt/ })).toBeDisabled();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RootSessionProjection } from "../entities/harness/types";
import { Composer } from "./conversation/Composer";
import { ParentConversation } from "./conversation/ParentConversation";
import { RuntimeStatusBar } from "./shell/RuntimeStatusBar";

const COMMON_MOJIBAKE = /(?:\u00c2[\u0080-\u00bf]|\u00c3[\u0080-\u00bf]|\u00e2[\u0080-\u00bf\u0192\u02c6\u02dc\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]|\u00ef\u00bf\u00bd|\ufffd)/u;

function expectEncodingClean(element: HTMLElement) {
  expect(element.textContent).not.toMatch(COMMON_MOJIBAKE);
}

const session: RootSessionProjection = {
  sessionId: "session-1",
  accountId: "openai-codex",
  projectId: "project:personal",
  chatId: "chat-1",
  cursor: { runtimeGeneration: "generation-1", sequence: 1 },
  state: "working",
  parentMessages: [
    {
      channel: "parent",
      kind: "assistant",
      id: "assistant-1",
      blocks: [{ kind: "text", text: "Checking the renderer." }],
      streaming: true,
      emittedAtMs: 1,
    },
  ],
  children: [],
  queue: [],
  tools: [],
  resources: [],
  usage: { input: 1200, output: 340, cacheRead: 20, cacheWrite: 0, totalTokens: 1560, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId: "session-1", cursor: { runtimeGeneration: "generation-1", sequence: 1 }, reason: "event_chronology_unavailable" },
  freshness: "live",
};

describe("production renderer text integrity", () => {
  it("renders status delimiters as middle dots without mojibake", () => {
    render(<RuntimeStatusBar session={session} composer={{ sessionId: session.sessionId, cursor: session.cursor, model: "gpt-5.6-sol", thinking: "high" }} />);

    const status = screen.getByRole("status", { name: /Runtime status/ });
    expect(status).toHaveTextContent("openai-codex \u00b7 gpt-5.6-sol \u00b7 thinking high");
    expect(status).toHaveTextContent("working \u00b7 connected");
    expectEncodingClean(status);
  });

  it("renders conversation punctuation and progress ellipses without mojibake", () => {
    const view = render(<ParentConversation title="Renderer audit" session={null} archived={false} />);

    const conversation = screen.getByRole("log", { name: "Renderer audit conversation" });
    expect(conversation).toHaveTextContent(
      "Prime Assistant runs on the Prime Harness \u2014 it can fan out subagents, run tools, and keep big data out of context.",
    );
    expectEncodingClean(conversation);

    view.rerender(<ParentConversation title="Renderer audit" session={session} archived={false} />);
    expect(screen.getByText("streaming\u2026")).toBeVisible();
    expectEncodingClean(screen.getByRole("log", { name: "Renderer audit conversation" }));
  });

  it("keeps the composer placeholder encoding-clean", () => {
    render(
      <Composer
        draft=""
        state={{ kind: "idle", draft: "", canSend: false }}
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onAbort={() => undefined}
        onOpenUsage={() => undefined}
      />,
    );

    const textbox = screen.getByRole("textbox", { name: "Message Prime Studio" });
    expect(textbox).toHaveAttribute("placeholder", "Message Prime Studio \u2014 try / for commands");
    expectEncodingClean(textbox);
  });
});

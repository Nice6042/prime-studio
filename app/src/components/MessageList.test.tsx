import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_RESIDENT_TIMELINE_ITEMS } from "../reducer";
import { MessageList } from "./MessageList";
import type { TimelineItem } from "../types";

const assistant = (streaming: boolean, text: string, key = "answer-1"): TimelineItem => ({
  kind: "assistant",
  key,
  streaming,
  blocks: [{ type: "text", text }],
});

it("announces a completed final answer once instead of streaming partial text", () => {
  const common = {
    tools: {},
    children: [],
    actions: { onMessageChild: vi.fn(), onOpenChild: vi.fn() },
    omittedItems: 0,
    totalItems: 0,
    payloadTruncated: false,
    empty: null,
  };
  const view = render(
    <MessageList {...common} timeline={[assistant(true, "Partial")]} busy />,
  );

  const responseStatus = screen.getByRole("status", { name: "Response status" });
  expect(responseStatus).toBeEmptyDOMElement();

  view.rerender(
    <MessageList
      {...common}
      timeline={[assistant(false, "The complete answer")]}
      busy={false}
    />,
  );

  expect(responseStatus).toHaveTextContent("Prime finished responding. The final answer is ready.");
});

it("does not announce a stale answer when a later turn fails before assistant output", () => {
  const common = {
    tools: {},
    children: [],
    actions: { onMessageChild: vi.fn(), onOpenChild: vi.fn() },
    omittedItems: 0,
    totalItems: 0,
    payloadTruncated: false,
    empty: null,
  };
  const priorAnswer = assistant(false, "Answer from the prior turn", "answer-old");
  const view = render(
    <MessageList {...common} timeline={[priorAnswer]} busy={false} />,
  );
  const responseStatus = screen.getByRole("status", { name: "Response status" });

  view.rerender(
    <MessageList
      {...common}
      timeline={[priorAnswer, { kind: "user", key: "user-new", text: "Try again" }]}
      busy
    />,
  );
  view.rerender(
    <MessageList
      {...common}
      timeline={[
        priorAnswer,
        { kind: "user", key: "user-new", text: "Try again" },
        { kind: "notice", key: "failure", text: "The turn failed before responding." },
      ]}
      busy={false}
    />,
  );

  expect(responseStatus).toBeEmptyDOMElement();
});

const actions = { onMessageChild: vi.fn(), onOpenChild: vi.fn() };
const transcriptStatus = () =>
  screen
    .getAllByRole("status")
    .find((node) => node.getAttribute("aria-label") !== "Response status")!;

describe("MessageList resident window", () => {
  it("mounts at most 300 rows and exposes archive omission to assistive technology", () => {
    const timeline: TimelineItem[] = Array.from({ length: 50_000 }, (_, index) => ({
      kind: "user",
      key: `m-${index}`,
      text: `message-${index}`,
    }));

    const { container } = render(
      <MessageList
        timeline={timeline}
        tools={{}}
        children={[]}
        busy={false}
        actions={actions}
        omittedItems={0}
        totalItems={50_000}
        payloadTruncated={false}
        empty={null}
      />,
    );

    expect(container.querySelectorAll(".user-msg")).toHaveLength(MAX_RESIDENT_TIMELINE_ITEMS);
    expect(screen.queryByText("message-49699")).not.toBeInTheDocument();
    expect(screen.getByText("message-49700")).toBeInTheDocument();
    expect(screen.getByText("message-49999")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Conversation transcript" })).toBeInTheDocument();
    expect(transcriptStatus()).toHaveTextContent(
      "Showing the latest 300 of 50,000 messages",
    );
  }, 20_000);

  it("discloses state-level omissions and clipped oversized content", () => {
    render(
      <MessageList
        timeline={[{ kind: "user", key: "last", text: "latest" }]}
        tools={{}}
        children={[]}
        busy={false}
        actions={actions}
        omittedItems={49_999}
        totalItems={50_000}
        payloadTruncated
        empty={null}
      />,
    );

    expect(transcriptStatus()).toHaveTextContent(
      "Showing the latest 1 of 50,000 messages",
    );
    expect(transcriptStatus()).toHaveTextContent("Very large message content was clipped");
  });

  it("mounts at most 300 assistant content rows across message boundaries", () => {
    const blocks = (prefix: string) =>
      Array.from({ length: 256 }, (_, index) => ({
        type: "toolCall" as const,
        id: `${prefix}-${index}`,
        name: "shell",
        arguments: { command: `${prefix}-${index}` },
      }));
    const timeline: TimelineItem[] = [
      { kind: "assistant", key: "first", blocks: blocks("first"), streaming: false },
      { kind: "assistant", key: "second", blocks: blocks("second"), streaming: false },
    ];

    const { container } = render(
      <MessageList
        timeline={timeline}
        tools={{}}
        children={[]}
        busy={false}
        actions={actions}
        omittedItems={0}
        totalItems={2}
        payloadTruncated={false}
        empty={null}
      />,
    );

    expect(container.querySelectorAll(".cell").length).toBeLessThanOrEqual(300);
  });

  it("labels an evicted tool result as unavailable instead of running", () => {
    render(
      <MessageList
        timeline={[
          {
            kind: "assistant",
            key: "assistant",
            streaming: false,
            blocks: [{ type: "toolCall", id: "evicted", name: "shell", arguments: {} }],
          },
        ]}
        tools={{}}
        children={[]}
        busy={false}
        actions={actions}
        omittedItems={0}
        totalItems={1}
        payloadTruncated={false}
        empty={null}
      />,
    );

    expect(screen.getByText("result not resident in this view")).toBeInTheDocument();
    expect(screen.queryByText("running…")).not.toBeInTheDocument();
  });

  it("offers keyboard-accessible older and latest page navigation", () => {
    const onOlder = vi.fn();
    const onLatest = vi.fn();
    render(
      <MessageList
        timeline={[{ kind: "user", key: "page", text: "paged" }]}
        tools={{}}
        children={[]}
        busy={false}
        actions={actions}
        omittedItems={49_999}
        totalItems={50_000}
        payloadTruncated={false}
        windowStart={49_400}
        windowEnd={49_700}
        hasOlder
        hasNewer
        onOlder={onOlder}
        onLatest={onLatest}
        empty={null}
      />,
    );

    screen.getByRole("button", { name: "Previous 300 messages" }).click();
    screen.getByRole("button", { name: "Jump to latest messages" }).click();
    expect(onOlder).toHaveBeenCalledOnce();
    expect(onLatest).toHaveBeenCalledOnce();
    expect(transcriptStatus()).toHaveTextContent(
      "Showing messages 49,401–49,700 of 50,000",
    );
  });

  it("does not classify an assistant on a historical page as the transcript close", () => {
    const conclusion = "This is a sufficiently long historical assistant paragraph that would otherwise be styled as the final verdict in the transcript.";
    const { container } = render(
      <MessageList
        timeline={[
          {
            kind: "assistant",
            key: "historical",
            streaming: false,
            blocks: [{ type: "text", text: conclusion }],
          },
        ]}
        tools={{ "historical-tool": { id: "historical-tool", name: "shell", args: {}, status: "ok", output: "", cellNo: 1 } }}
        children={[{ id: "makes-not-quiet", name: "child", status: "retained", cost: 0, cell: 1 }]}
        busy={false}
        actions={actions}
        omittedItems={399}
        totalItems={400}
        windowStart={0}
        windowEnd={1}
        payloadTruncated={false}
        hasNewer
        empty={null}
      />,
    );

    expect(container.querySelector(".verdict")).not.toBeInTheDocument();
  });

  it("includes child rows in the shared 300-row mounted budget", () => {
    const children = Array.from({ length: 300 }, (_, index) => ({
      id: `child-${index}`,
      name: `child-${index}`,
      status: "queued",
      cost: 0,
      cell: 1,
    }));
    const { container } = render(
      <MessageList
        timeline={[
          {
            kind: "assistant",
            key: "parent",
            streaming: false,
            blocks: [{ type: "toolCall", id: "parent-tool", name: "shell", arguments: {} }],
          },
        ]}
        tools={{
          "parent-tool": {
            id: "parent-tool",
            name: "shell",
            args: {},
            status: "ok",
            output: "done",
            cellNo: 1,
          },
        }}
        children={children}
        busy={false}
        actions={actions}
        omittedItems={0}
        totalItems={1}
        payloadTruncated={false}
        empty={null}
      />,
    );

    expect(container.querySelectorAll(".cell, .child")).toHaveLength(300);
    expect(transcriptStatus()).toHaveTextContent(
      "Older child rows are not mounted",
    );
  });
});

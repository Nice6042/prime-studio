import { describe, expect, it } from "vitest";
import {
  MAX_RESIDENT_TIMELINE_ITEMS,
  MAX_RESIDENT_TEXT_CHARS,
  empty,
  reduce,
} from "./reducer";
import type { PrimeMessage } from "./types";

const userMessage = (text: string): PrimeMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

function retainedStringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + retainedStringChars(entry), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (total, entry) => total + retainedStringChars(entry),
      0,
    );
  }
  return 0;
}

describe("bounded transcript residency", () => {
  it("loads only the latest 300 of a 50k-message archive and preserves truthful totals", () => {
    const messages = Array.from({ length: 50_000 }, (_, index) => userMessage(`message-${index}`));

    const state = reduce(empty, { t: "load", messages });

    expect(state.timeline).toHaveLength(MAX_RESIDENT_TIMELINE_ITEMS);
    expect(state.timeline[0]).toMatchObject({ kind: "user", text: "message-49700" });
    expect(state.timeline[state.timeline.length - 1]).toMatchObject({
      kind: "user",
      text: "message-49999",
    });
    expect(state.retention).toEqual({
      totalItems: 50_000,
      omittedItems: 49_700,
      totalTurns: 50_000,
      firstUserText: "message-0",
      payloadTruncated: false,
      windowStart: 49_700,
      windowEnd: 50_000,
      windowContiguous: true,
    });
  }, 20_000);

  it("reloads an older bounded archive page without retaining the other 49,700 messages", () => {
    const messages = Array.from({ length: 50_000 }, (_, index) => userMessage(`message-${index}`));

    const state = reduce(empty, { t: "load", messages, endAt: 49_700 });

    expect(state.timeline).toHaveLength(300);
    expect(state.timeline[0]).toMatchObject({ kind: "user", text: "message-49400" });
    expect(state.timeline[299]).toMatchObject({ kind: "user", text: "message-49699" });
    expect(state.retention).toMatchObject({
      totalItems: 50_000,
      omittedItems: 49_700,
      windowStart: 49_400,
      windowEnd: 49_700,
      totalTurns: 50_000,
      firstUserText: "message-0",
    });
  }, 20_000);

  it("clips a hostile 32 MiB message instead of retaining it in React state", () => {
    const huge = "x".repeat(32 * 1024 * 1024);

    const state = reduce(empty, { t: "load", messages: [userMessage(huge)] });
    const item = state.timeline[0];

    expect(item).toMatchObject({ kind: "user" });
    expect(item.kind === "user" ? item.text.length : Infinity).toBeLessThanOrEqual(
      MAX_RESIDENT_TEXT_CHARS,
    );
    expect(state.retention.payloadTruncated).toBe(true);
    expect(state.retention.totalItems).toBe(1);
    expect(state.retention.omittedItems).toBe(0);
  });

  it("keeps a 50k-event live chat bounded while retaining the real turn count", () => {
    let state = empty;
    for (let index = 0; index < 50_000; index += 1) {
      state = reduce(state, { t: "user", text: `live-${index}` });
    }

    expect(state.timeline).toHaveLength(MAX_RESIDENT_TIMELINE_ITEMS);
    expect(state.timeline[0]).toMatchObject({ kind: "user", text: "live-49700" });
    expect(state.retention.totalTurns).toBe(50_000);
    expect(state.retention.totalItems).toBe(50_000);
    expect(state.retention.omittedItems).toBe(49_700);
    expect(state.retention.firstUserText).toBe("live-0");
  }, 20_000);

  it("does not evict the in-flight assistant while bounded queued user turns arrive", () => {
    let state = reduce(empty, {
      t: "event",
      e: { type: "message_start", message: { role: "assistant" } },
    });
    for (let index = 0; index < 301; index += 1) {
      state = reduce(state, { t: "user", text: `queued-${index}` });
    }

    expect(state.timeline).toHaveLength(MAX_RESIDENT_TIMELINE_ITEMS);
    expect(state.timeline.filter((item) => item.kind === "assistant" && item.streaming)).toHaveLength(1);

    state = reduce(state, {
      t: "event",
      e: {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "still running" }] },
      },
    });

    expect(state.timeline.filter((item) => item.kind === "assistant")).toHaveLength(1);
    expect(state.retention.totalItems).toBe(302);
    expect(state.retention.omittedItems).toBe(2);
  });

  it("bounds the blocks and text retained by a streaming assistant update", () => {
    const started = reduce(empty, {
      t: "event",
      e: { type: "message_start", message: { role: "assistant" } },
    });
    const blocks = Array.from({ length: 1_000 }, (_, index) => ({
      type: "text" as const,
      text: `${index}:${"z".repeat(4_096)}`,
    }));

    const state = reduce(started, {
      t: "event",
      e: { type: "message_update", message: { role: "assistant", content: blocks } },
    });
    const item = state.timeline[0];

    expect(item.kind === "assistant" ? item.blocks.length : Infinity).toBeLessThanOrEqual(256);
    expect(
      item.kind === "assistant"
        ? item.blocks.reduce(
            (total, block) =>
              total +
              (block.type === "text"
                ? String((block as { text?: string }).text ?? "").length
                : block.type === "thinking"
                  ? String((block as { thinking?: string }).thinking ?? "").length
                  : 0),
            0,
          )
        : Infinity,
    ).toBeLessThanOrEqual(MAX_RESIDENT_TEXT_CHARS);
    expect(state.retention.payloadTruncated).toBe(true);
  });

  it("clips hostile metadata on every retained protocol block field", () => {
    const huge = "m".repeat(32 * 1024 * 1024);
    const state = reduce(empty, {
      t: "load",
      messages: [
        {
          role: "assistant",
          model: huge,
          provider: huge,
          content: [
            { type: "text", text: "ok", index: 0, extension: huge },
            {
              type: "thinking",
              thinking: "bounded",
              thinkingSignature: huge,
              signature: huge,
              index: 1,
            },
            {
              type: "toolCall",
              id: huge,
              name: huge,
              arguments: { code: "ok" },
              partialJson: huge,
              index: 2,
            },
            { type: huge, index: 3, payload: huge },
          ],
        },
      ],
    });
    const item = state.timeline[0];
    expect(item.kind).toBe("assistant");
    if (item.kind !== "assistant") return;

    expect(item.model?.length).toBeLessThanOrEqual(512);
    expect(item.provider?.length).toBeLessThanOrEqual(512);
    expect(Object.keys(item.blocks[0]).sort()).toEqual(["index", "text", "type"]);
    expect(String((item.blocks[1] as { signature?: string }).signature).length).toBeLessThanOrEqual(4_096);
    expect(
      String((item.blocks[1] as { thinkingSignature?: string }).thinkingSignature).length,
    ).toBeLessThanOrEqual(4_096);
    expect(String((item.blocks[2] as { id?: string }).id).length).toBeLessThanOrEqual(1_024);
    expect(String((item.blocks[2] as { name?: string }).name).length).toBeLessThanOrEqual(512);
    expect(String((item.blocks[2] as { partialJson?: string }).partialJson).length).toBeLessThanOrEqual(16_384);
    expect(item.blocks[3].type.length).toBeLessThanOrEqual(512);
    expect(state.retention.payloadTruncated).toBe(true);
  });

  it("discloses clipping in partial tool details even when content output is small", () => {
    const started = reduce(empty, {
      t: "event",
      e: {
        type: "tool_execution_start",
        toolCallId: "tool-details",
        toolName: "shell",
        args: {},
      },
    });
    const state = reduce(started, {
      t: "event",
      e: {
        type: "tool_execution_update",
        toolCallId: "tool-details",
        toolName: "shell",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "small" }],
          details: { stdout: "s".repeat(32 * 1024 * 1024) },
        },
      },
    });

    expect(state.tools["tool-details"].output).toBe("small");
    expect(state.tools["tool-details"].details?.stdout?.length).toBeLessThanOrEqual(64 * 1024);
    expect(state.retention.payloadTruncated).toBe(true);
  });

  it("enforces one aggregate budget across deeply nested live tool arguments", () => {
    const shared = "a".repeat(2_048);
    const args = Object.fromEntries(
      Array.from({ length: 128 }, (_, outer) => [
        `outer-${outer}`,
        Object.fromEntries(
          Array.from({ length: 128 }, (_, inner) => [`inner-${inner}`, shared]),
        ),
      ]),
    );

    const state = reduce(empty, {
      t: "event",
      e: {
        type: "tool_execution_start",
        toolCallId: "aggregate",
        toolName: "shell",
        args,
      },
    });

    expect(retainedStringChars(state.tools.aggregate.args)).toBeLessThanOrEqual(64 * 1024);
    expect(state.retention.payloadTruncated).toBe(true);
  });

  it("bounds child event strings and tool detail status with disclosure", () => {
    const huge = "c".repeat(32 * 1024 * 1024);
    let state = reduce(empty, {
      t: "event",
      e: {
        type: "rlm_child_update",
        child: { id: "child", sessionName: huge, status: huge, model: huge, sessionDir: huge },
      },
    });
    state = reduce(state, {
      t: "event",
      e: {
        type: "tool_execution_end",
        toolCallId: "status-tool",
        toolName: "shell",
        result: { details: { status: huge } },
      },
    });

    expect(retainedStringChars(state.children)).toBeLessThanOrEqual(64 * 1024);
    expect(state.tools["status-tool"].details?.status?.length).toBeLessThanOrEqual(512);
    expect(state.retention.payloadTruncated).toBe(true);
  });

  it("preserves live child state while reloading a bounded history page", () => {
    const withChild = reduce(empty, {
      t: "event",
      e: {
        type: "rlm_child_update",
        child: { id: "child-1", sessionName: "worker", status: "retained" },
      },
    });
    const state = reduce(withChild, {
      t: "load",
      messages: Array.from({ length: 400 }, (_, index) => userMessage(`message-${index}`)),
      endAt: 300,
      preserveChildren: true,
    });

    expect(state.children["child-1"]?.name).toBe("worker");
    expect(state.retention).toMatchObject({ windowStart: 0, windowEnd: 300 });
  });

  it("keeps dense-message page cursors contiguous under the shared 300-row budget", () => {
    const messages: PrimeMessage[] = [
      ...Array.from({ length: 299 }, (_, index) => userMessage(`message-${index}`)),
      {
        role: "assistant",
        content: Array.from({ length: 256 }, (_, index) => ({
          type: "text" as const,
          text: `block-${index}`,
        })),
      },
    ];

    const latest = reduce(empty, { t: "load", messages });
    expect(latest.retention).toMatchObject({ windowStart: 255, windowEnd: 300 });
    expect(latest.timeline).toHaveLength(45);

    const previous = reduce(empty, {
      t: "load",
      messages,
      endAt: latest.retention.windowStart,
    });
    expect(previous.retention).toMatchObject({ windowStart: 0, windowEnd: 255 });
    expect(previous.timeline).toHaveLength(255);
  });

  it("exposes a previous-page cursor after dense live assistant messages settle", () => {
    const blocks = (prefix: string) =>
      Array.from({ length: 256 }, (_, index) => ({
        type: "text" as const,
        text: `${prefix}-${index}`,
      }));
    let state = empty;
    for (const prefix of ["first", "second"]) {
      state = reduce(state, {
        t: "event",
        e: { type: "message_start", message: { role: "assistant" } },
      });
      state = reduce(state, {
        t: "event",
        e: {
          type: "message_update",
          message: { role: "assistant", content: blocks(prefix) },
        },
      });
      state = reduce(state, {
        t: "event",
        e: {
          type: "message_end",
          message: { role: "assistant", content: blocks(prefix) },
        },
      });
    }

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ kind: "assistant" });
    expect(state.retention).toMatchObject({
      totalItems: 2,
      omittedItems: 1,
      windowStart: 1,
      windowEnd: 2,
    });
  });

  it("settles a sparse streaming window into a truthful contiguous suffix", () => {
    const blocks = Array.from({ length: 256 }, (_, index) => ({
      type: "text" as const,
      text: `stream-${index}`,
    }));
    let state = reduce(empty, {
      t: "event",
      e: { type: "message_start", message: { role: "assistant" } },
    });
    state = reduce(state, {
      t: "event",
      e: { type: "message_update", message: { role: "assistant", content: blocks } },
    });
    for (let index = 0; index < 301; index += 1) {
      state = reduce(state, { t: "user", text: `queued-${index}` });
    }
    expect(state.retention.windowContiguous).toBe(false);

    state = reduce(state, {
      t: "event",
      e: { type: "message_end", message: { role: "assistant", content: blocks } },
    });

    expect(state.timeline).toHaveLength(44);
    expect(state.timeline[0]).toMatchObject({ kind: "user", text: "queued-257" });
    expect(state.timeline[43]).toMatchObject({ kind: "user", text: "queued-300" });
    expect(state.retention).toMatchObject({
      totalItems: 302,
      omittedItems: 258,
      windowStart: 258,
      windowEnd: 302,
      windowContiguous: true,
    });
  });

  it("preserves truncation disclosure with clipped live children across paging", () => {
    const huge = "p".repeat(32 * 1024 * 1024);
    const withChild = reduce(empty, {
      t: "event",
      e: {
        type: "rlm_child_update",
        child: { id: "clipped-child", sessionName: huge, status: "retained" },
      },
    });
    const paged = reduce(withChild, {
      t: "load",
      messages: [userMessage("history")],
      preserveChildren: true,
    });

    expect(paged.children["clipped-child"]).toBeDefined();
    expect(paged.retention.payloadTruncated).toBe(true);
  });

  it("bounds live tool state and oversized tool payloads", () => {
    let state = empty;
    for (let index = 0; index < 1_000; index += 1) {
      state = reduce(state, {
        t: "event",
        e: {
          type: "tool_execution_start",
          toolCallId: `tool-${index}`,
          toolName: "shell",
          args: { command: `command-${index}` },
        },
      });
    }

    expect(Object.keys(state.tools)).toHaveLength(600);
    expect(state.tools["tool-399"]).toBeUndefined();
    expect(state.tools["tool-400"]?.cellNo).toBe(401);
    expect(state.tools["tool-999"]?.cellNo).toBe(1_000);

    state = reduce(state, {
      t: "event",
      e: {
        type: "tool_execution_end",
        toolCallId: "tool-999",
        toolName: "shell",
        result: { content: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }] },
      },
    });

    expect(state.tools["tool-999"].output.length).toBeLessThanOrEqual(64 * 1024);
    expect(state.retention.payloadTruncated).toBe(true);
  }, 20_000);
});

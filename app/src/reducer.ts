// Pure transcript reducer: no React, no Tauri — replayable against a raw
// prime JSONL stream (see scripts note in reducer.check.mjs).
import type {
  ChildState,
  ContentBlock,
  PrimeEvent,
  PrimeMessage,
  TimelineItem,
  ToolResult,
  ToolState,
} from "./types";

let keySeq = 0;
const newKey = () => `i${++keySeq}`;

export const MAX_RESIDENT_TIMELINE_ITEMS = 300;
export const MAX_RESIDENT_TEXT_CHARS = 128 * 1024;
export const MAX_RESIDENT_CONTENT_BLOCKS = 256;
const MAX_RESIDENT_TOOL_STATES = 600;
const MAX_RESIDENT_CHILDREN = 300;
const CLIPPED = "\n\n[Content clipped in this view]";

interface TranscriptRetention {
  totalItems: number;
  omittedItems: number;
  totalTurns: number;
  firstUserText: string;
  payloadTruncated: boolean;
  windowStart: number;
  windowEnd: number;
  windowContiguous: boolean;
}

const emptyRetention = (): TranscriptRetention => ({
  totalItems: 0,
  omittedItems: 0,
  totalTurns: 0,
  firstUserText: "",
  payloadTruncated: false,
  windowStart: 0,
  windowEnd: 0,
  windowContiguous: true,
});

function clipText(value: unknown, limit = MAX_RESIDENT_TEXT_CHARS): {
  text: string;
  truncated: boolean;
} {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= limit) return { text, truncated: false };
  const suffix = CLIPPED.slice(0, Math.max(0, limit));
  return {
    text: `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`,
    truncated: true,
  };
}

interface ValueBudget {
  chars: number;
  nodes: number;
  truncated: boolean;
}

function boundedValue(
  value: unknown,
  depth = 0,
  budget: ValueBudget = { chars: 64 * 1024, nodes: 4_096, truncated: false },
): { value: unknown; truncated: boolean } {
  budget.nodes -= 1;
  if (budget.nodes < 0) {
    budget.truncated = true;
    return { value: null, truncated: true };
  }
  if (typeof value === "string") {
    const clipped = clipText(value, Math.min(16 * 1024, budget.chars));
    budget.chars -= clipped.text.length;
    budget.truncated ||= clipped.truncated;
    return { value: clipped.text, truncated: budget.truncated };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, truncated: false };
  }
  if (depth >= 6) {
    budget.truncated = true;
    return { value: null, truncated: true };
  }
  if (Array.isArray(value)) {
    budget.truncated ||= value.length > 128;
    const next: unknown[] = [];
    for (const entry of value.slice(0, 128)) {
      if (budget.nodes <= 0 || budget.chars <= 0) {
        budget.truncated = true;
        break;
      }
      next.push(boundedValue(entry, depth + 1, budget).value);
    }
    return { value: next, truncated: budget.truncated };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    budget.truncated ||= entries.length > 128;
    const next = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of entries.slice(0, 128)) {
      if (budget.nodes <= 0 || budget.chars <= 0) {
        budget.truncated = true;
        break;
      }
      const boundedKey = clipText(key, Math.min(512, budget.chars));
      budget.chars -= boundedKey.text.length;
      const bounded = boundedValue(entry, depth + 1, budget);
      next[boundedKey.text] = bounded.value;
      budget.truncated ||= boundedKey.truncated || bounded.truncated;
    }
    return { value: next, truncated: budget.truncated };
  }
  budget.truncated = true;
  return { value: null, truncated: true };
}

function boundedBlocks(blocks: ContentBlock[] | undefined): {
  blocks: ContentBlock[];
  truncated: boolean;
} {
  const source = blocks ?? [];
  let remaining = MAX_RESIDENT_TEXT_CHARS;
  let truncated = source.length > MAX_RESIDENT_CONTENT_BLOCKS;
  const next: ContentBlock[] = [];

  for (const block of source.slice(-MAX_RESIDENT_CONTENT_BLOCKS)) {
    if (block.type === "text") {
      const clipped = clipText((block as { text?: string }).text, remaining);
      next.push({ type: "text", text: clipped.text, index: block.index });
      remaining -= clipped.text.length;
      truncated ||= clipped.truncated || Object.keys(block).some((key) => !["type", "text", "index"].includes(key));
      continue;
    }
    if (block.type === "thinking") {
      const clipped = clipText((block as { thinking?: string }).thinking, remaining);
      const thinking = block as {
        thinking?: string;
        thinkingSignature?: string;
        signature?: string;
        redacted?: boolean;
      };
      const thinkingSignature = clipText(thinking.thinkingSignature, 4 * 1024);
      const signature = clipText(thinking.signature, 4 * 1024);
      next.push({
        type: "thinking",
        thinking: clipped.text,
        thinkingSignature: thinkingSignature.text || undefined,
        signature: signature.text || undefined,
        redacted: typeof thinking.redacted === "boolean" ? thinking.redacted : undefined,
        index: block.index,
      });
      remaining -= clipped.text.length;
      truncated ||= clipped.truncated || thinkingSignature.truncated || signature.truncated;
      continue;
    }
    if (block.type === "toolCall") {
      const toolCall = block as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        partialJson?: string;
      };
      const args = boundedValue(toolCall.arguments ?? {});
      const id = clipText(toolCall.id, 1_024);
      const name = clipText(toolCall.name, 512);
      const partialJson = clipText(toolCall.partialJson, 16 * 1024);
      next.push({
        type: "toolCall",
        id: id.text,
        name: name.text,
        arguments: args.value as Record<string, unknown>,
        partialJson: partialJson.text || undefined,
        index: block.index,
      });
      truncated ||= args.truncated || id.truncated || name.truncated || partialJson.truncated;
      continue;
    }
    // Unknown extension blocks are not rendered. Retain their identity, not an
    // arbitrarily large untrusted payload the UI cannot use.
    const type = clipText(block.type, 512);
    next.push({ type: type.text, index: block.index });
    truncated ||= type.truncated;
    truncated ||= Object.keys(block).some((key) => key !== "type" && key !== "index");
  }
  return { blocks: next, truncated };
}

function resultText(r: ToolResult | undefined): string {
  if (!r) return "";
  const fromContent = (r.content ?? [])
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("");
  if (fromContent) return fromContent;
  const d = r.details;
  return [d?.stdout, d?.stderr].filter(Boolean).join("\n");
}

export interface ChatState {
  timeline: TimelineItem[];
  tools: Record<string, ToolState>;
  /** Subagents seen via `child_usage_attributed`; empty in the common case. */
  children: Record<string, ChildState>;
  busy: boolean;
  /** Truthful totals for content intentionally omitted from resident UI state. */
  retention: TranscriptRetention;
}

/** Next cell number: cells are numbered in the order the session ran them. */
const nextCell = (tools: Record<string, ToolState>) =>
  Object.values(tools).reduce((highest, tool) => Math.max(highest, tool.cellNo), 0) + 1;

function boundedRecord<T>(record: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  return Object.fromEntries(keys.slice(-limit).map((key) => [key, record[key]]));
}

const boundedTools = (tools: Record<string, ToolState>) =>
  boundedRecord(tools, MAX_RESIDENT_TOOL_STATES);

function boundedTimeline(timeline: TimelineItem[]): {
  timeline: TimelineItem[];
  contiguous: boolean;
} {
  const streaming = [...timeline]
    .reverse()
    .find((item) => item.kind === "assistant" && item.streaming);
  const rowsFor = (item: TimelineItem) =>
    item.kind === "assistant" ? Math.max(1, item.blocks.length) : 1;
  const selected = new Set<string>();
  let rows = 0;
  if (streaming) {
    selected.add(streaming.key);
    rows = rowsFor(streaming);
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (selected.has(item.key)) continue;
    const itemRows = rowsFor(item);
    if (rows > 0 && rows + itemRows > MAX_RESIDENT_TIMELINE_ITEMS) break;
    selected.add(item.key);
    rows += itemRows;
  }
  const retained = timeline.filter((item) => selected.has(item.key));
  const first = timeline.findIndex((item) => selected.has(item.key));
  return {
    timeline: retained,
    contiguous: first < 0 || retained.length === timeline.length - first,
  };
}

function rewindowTimeline(state: ChatState, timeline: TimelineItem[]): ChatState {
  const bounded = boundedTimeline(timeline);
  return {
    ...state,
    timeline: bounded.timeline,
    retention: {
      ...state.retention,
      omittedItems: state.retention.totalItems - bounded.timeline.length,
      windowStart: Math.max(0, state.retention.totalItems - bounded.timeline.length),
      windowEnd: state.retention.totalItems,
      windowContiguous: bounded.contiguous,
    },
  };
}

function appendTimeline(
  state: ChatState,
  item: TimelineItem,
  options: { turn?: boolean; truncated?: boolean; firstUserText?: string } = {},
): ChatState {
  const bounded = boundedTimeline([...state.timeline, item]);
  const timeline = bounded.timeline;
  const totalItems = state.retention.totalItems + 1;
  return {
    ...state,
    timeline,
    retention: {
      totalItems,
      omittedItems: totalItems - timeline.length,
      totalTurns: state.retention.totalTurns + (options.turn ? 1 : 0),
      firstUserText:
        state.retention.firstUserText ||
        (options.firstUserText ? options.firstUserText.slice(0, 48) : ""),
      payloadTruncated: state.retention.payloadTruncated || Boolean(options.truncated),
      windowStart: Math.max(0, totalItems - timeline.length),
      windowEnd: totalItems,
      windowContiguous: bounded.contiguous,
    },
  };
}

const markTruncated = (state: ChatState, truncated: boolean): ChatState =>
  truncated && !state.retention.payloadTruncated
    ? { ...state, retention: { ...state.retention, payloadTruncated: true } }
    : state;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/**
 * Merge a subagent event into the child map.
 *
 * `rlm_child_update` is the verified source (see `ChildState`); its `child`
 * object carries id, sessionName, model, sessionDir and a real `status`.
 * `child_usage_attributed` adds cost, and its field names are NOT verified, so
 * several spellings are tried and a nameless child is dropped rather than
 * rendered as "unknown".
 */
function mergeChild(
  children: Record<string, ChildState>,
  e: Record<string, unknown>,
  cell: number,
): Record<string, ChildState> {
  const c = (e.child ?? e.childAgent ?? {}) as Record<string, unknown>;
  const id = str(c.id) ?? str(e.childId) ?? str(e.rlmChildId) ?? str(c.sessionName);
  if (!id) return children;
  const prev = children[id];
  const name = str(c.sessionName) ?? str(c.name) ?? str(e.childName) ?? prev?.name;
  if (!name) return children;

  const usage = (e.childUsage ?? {}) as Record<string, unknown>;
  const cost = (usage.cost ?? {}) as Record<string, unknown>;
  const spent = num(cost.total) ?? num(e.cost);

  return {
    ...children,
    [id]: {
      id,
      name,
      model: str(c.model) ?? str(e.model) ?? prev?.model,
      status: str(c.status) ?? prev?.status ?? "running",
      // Usage events are per-delta, so they accumulate; a status update must not
      // re-add the last figure.
      cost: (prev?.cost ?? 0) + (spent ?? 0),
      sessionDir: str(c.sessionDir) ?? prev?.sessionDir,
      cell: prev?.cell ?? cell,
    },
  };
}

export type Action =
  | { t: "event"; e: PrimeEvent }
  | { t: "user"; text: string }
  | { t: "notice"; text: string }
  | { t: "busy"; on: boolean }
  | { t: "reset" }
  | {
      t: "load";
      messages: PrimeMessage[];
      endAt?: number;
      preserveChildren?: boolean;
    };

export const empty: ChatState = {
  timeline: [],
  tools: {},
  children: {},
  busy: false,
  retention: emptyRetention(),
};

/**
 * Patch the most recent still-streaming assistant item, creating one if absent.
 * Searches backwards rather than checking only the tail: a steer pushes a user
 * bubble mid-turn, and the stream that follows must keep filling the *existing*
 * assistant bubble instead of forking a duplicate below it.
 */
function withAssistant(
  state: ChatState,
  patch: (prev: Extract<TimelineItem, { kind: "assistant" }>) => Extract<TimelineItem, { kind: "assistant" }>,
): ChatState {
  const timeline = state.timeline.slice();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "assistant" && item.streaming) {
      const patched = patch(item);
      timeline[i] = patched;
      if (!state.retention.windowContiguous && !patched.streaming) timeline.splice(i, 1);
      return rewindowTimeline(state, timeline);
    }
  }
  return appendTimeline(
    state,
    patch({ kind: "assistant", key: newKey(), blocks: [], streaming: true }),
  );
}

function applyToolResult(state: ChatState, id: string, name: string, r: ToolResult, isError: boolean): ChatState {
  const safeId = clipText(id, 1_024);
  const safeName = clipText(name, 512);
  const prev = state.tools[safeId.text];
  const output = clipText(resultText(r), 64 * 1024);
  const detailStatus = clipText(r.details?.status, 512);
  const details = r.details
    ? {
        status: detailStatus.text,
        durationMs: r.details.durationMs,
        stdout: clipText(r.details.stdout, 64 * 1024).text,
        stderr: clipText(r.details.stderr, 64 * 1024).text,
      }
    : undefined;
  return {
    ...state,
    tools: boundedTools({
      ...state.tools,
      [safeId.text]: {
        id: safeId.text,
        name: safeName.text || prev?.name || "tool",
        args: prev?.args ?? {},
        status: isError ? "error" : "ok",
        output: output.text,
        details,
        cellNo: prev?.cellNo ?? nextCell(state.tools),
      },
    }),
    retention: {
      ...state.retention,
      payloadTruncated:
        state.retention.payloadTruncated ||
        safeId.truncated ||
        safeName.truncated ||
        detailStatus.truncated ||
        output.truncated ||
        Boolean(r.details?.stdout && r.details.stdout.length > 64 * 1024) ||
        Boolean(r.details?.stderr && r.details.stderr.length > 64 * 1024),
    },
  };
}

export function reduce(state: ChatState, a: Action): ChatState {
  switch (a.t) {
    case "reset":
      return empty;
    case "busy":
      return { ...state, busy: a.on };
    case "user":
      {
        const clipped = clipText(a.text);
        return appendTimeline(
          state,
          { kind: "user", key: newKey(), text: clipped.text },
          { turn: true, truncated: clipped.truncated, firstUserText: a.text },
        );
      }
    case "notice":
      {
        const clipped = clipText(a.text);
        return appendTimeline(
          state,
          { kind: "notice", key: newKey(), text: clipped.text },
          { truncated: clipped.truncated },
        );
      }
    case "load":
      {
        const loaded = loadMessages(a.messages, a.endAt);
        return a.preserveChildren
          ? {
              ...loaded,
              children: state.children,
              retention: {
                ...loaded.retention,
                payloadTruncated:
                  loaded.retention.payloadTruncated || state.retention.payloadTruncated,
              },
            }
          : loaded;
      }
    case "event":
      return applyEvent(state, a.e);
  }
}

function applyEvent(state: ChatState, e: PrimeEvent): ChatState {
  switch (e.type) {
    case "agent_start":
      return { ...state, busy: true };

    // Prime echoes message_start/end for `user` and `toolResult` roles too; we
    // render those ourselves, so only assistant messages drive the bubble.
    case "message_start": {
      const m = (e as { message: PrimeMessage }).message;
      if (m?.role !== "assistant") return state;
      const model = clipText(m.model, 512);
      const provider = clipText(m.provider, 512);
      return appendTimeline(
        state,
        {
          kind: "assistant",
          key: newKey(),
          blocks: [],
          streaming: true,
          model: model.text || undefined,
          provider: provider.text || undefined,
        },
        { truncated: model.truncated || provider.truncated },
      );
    }
    case "message_update": {
      const m = (e as { message: PrimeMessage }).message;
      if (m?.role !== "assistant") return state;
      const bounded = boundedBlocks((m.content ?? []) as ContentBlock[]);
      const model = clipText(m.model, 512);
      const provider = clipText(m.provider, 512);
      // content[i].text is full-so-far, not a delta — replace wholesale.
      return markTruncated(
        withAssistant(state, (prev) => ({
          ...prev,
          blocks: bounded.blocks,
          model: model.text || prev.model,
          provider: provider.text || prev.provider,
        })),
        bounded.truncated || model.truncated || provider.truncated,
      );
    }
    case "message_end": {
      const m = (e as { message: PrimeMessage }).message;
      if (m?.role !== "assistant") return state;
      const bounded = m.content
        ? boundedBlocks(m.content as ContentBlock[])
        : { blocks: undefined, truncated: false };
      const model = clipText(m.model, 512);
      const provider = clipText(m.provider, 512);
      return markTruncated(
        withAssistant(state, (prev) => ({
          ...prev,
          blocks: bounded.blocks ?? prev.blocks,
          model: model.text || prev.model,
          provider: provider.text || prev.provider,
          cost: m.usage?.cost?.total,
          streaming: false,
        })),
        bounded.truncated || model.truncated || provider.truncated,
      );
    }

    case "tool_execution_start": {
      const ev = e as { toolCallId: string; toolName: string; args: Record<string, unknown> };
      const args = boundedValue(ev.args ?? {});
      const id = clipText(ev.toolCallId, 1_024);
      const name = clipText(ev.toolName, 512);
      return {
        ...state,
        tools: boundedTools({
          ...state.tools,
          [id.text]: {
            id: id.text,
            name: name.text,
            args: args.value as Record<string, unknown>,
            status: "running",
            output: "",
            cellNo: state.tools[id.text]?.cellNo ?? nextCell(state.tools),
          },
        }),
        retention: {
          ...state.retention,
          payloadTruncated:
            state.retention.payloadTruncated || args.truncated || id.truncated || name.truncated,
        },
      };
    }
    case "tool_execution_update": {
      const ev = e as { toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult?: ToolResult };
      const id = clipText(ev.toolCallId, 1_024);
      const name = clipText(ev.toolName, 512);
      const prev = state.tools[id.text];
      const args = boundedValue(ev.args ?? prev?.args ?? {});
      const output = clipText(resultText(ev.partialResult) || prev?.output || "", 64 * 1024);
      const stdout = clipText(ev.partialResult?.details?.stdout, 64 * 1024);
      const stderr = clipText(ev.partialResult?.details?.stderr, 64 * 1024);
      const detailStatus = clipText(ev.partialResult?.details?.status, 512);
      return {
        ...state,
        tools: boundedTools({
          ...state.tools,
          [id.text]: {
            id: id.text,
            name: name.text || prev?.name || "tool",
            args: args.value as Record<string, unknown>,
            status: "running",
            output: output.text,
            details: ev.partialResult?.details
              ? {
                  status: detailStatus.text,
                  durationMs: ev.partialResult.details.durationMs,
                  stdout: stdout.text,
                  stderr: stderr.text,
                }
              : prev?.details,
            cellNo: prev?.cellNo ?? nextCell(state.tools),
          },
        }),
        retention: {
          ...state.retention,
          payloadTruncated:
            state.retention.payloadTruncated ||
            args.truncated ||
            id.truncated ||
            name.truncated ||
            output.truncated ||
            stdout.truncated ||
            stderr.truncated ||
            detailStatus.truncated,
        },
      };
    }
    case "tool_execution_end": {
      const ev = e as { toolCallId: string; toolName: string; result: ToolResult; isError?: boolean };
      return applyToolResult(state, ev.toolCallId, ev.toolName, ev.result ?? {}, Boolean(ev.isError ?? ev.result?.isError));
    }

    // Fan-out. `rlm_child_update` announces a subagent and its status;
    // `child_usage_attributed` attributes its spend to this parent.
    case "rlm_child_update":
    case "child_usage_attributed": {
      const boundedEvent = boundedValue(e);
      return {
        ...state,
        // The newest cell is the one in flight, so it is the one that spawned it.
        children: boundedRecord(
          mergeChild(
            state.children,
            boundedEvent.value as Record<string, unknown>,
            Object.keys(state.tools).length,
          ),
          MAX_RESIDENT_CHILDREN,
        ),
        retention: {
          ...state.retention,
          payloadTruncated:
            state.retention.payloadTruncated || boundedEvent.truncated,
        },
      };
    }

    case "agent_end":
      {
        const timeline = state.retention.windowContiguous
          ? state.timeline.map(closeStream)
          : state.timeline.filter(
              (item) => item.kind !== "assistant" || !item.streaming,
            );
      return rewindowTimeline(
        { ...state, busy: false },
        timeline,
      );
      }
    default:
      return state;
  }
}

const closeStream = (i: TimelineItem): TimelineItem =>
  i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i;

/** Rebuild a transcript from a persisted / replayed message list. */
function loadMessages(messages: PrimeMessage[], endAt?: number): ChatState {
  const timelineMessages = (messages ?? []).filter((message) => {
    if (message.role === "assistant") return true;
    if (message.role !== "user") return false;
    return (message.content ?? []).some(
      (block) => block.type === "text" && String((block as { text?: string }).text ?? "").trim(),
    );
  });
  const totalItems = timelineMessages.length;
  const windowEnd = Math.min(
    totalItems,
    Math.max(0, Number.isSafeInteger(endAt) ? (endAt as number) : totalItems),
  );
  let windowStart = windowEnd;
  let residentRows = 0;
  while (windowStart > 0) {
    const message = timelineMessages[windowStart - 1];
    const rows =
      message.role === "assistant"
        ? Math.max(
            1,
            Math.min(message.content?.length ?? 0, MAX_RESIDENT_CONTENT_BLOCKS),
          )
        : 1;
    if (residentRows > 0 && residentRows + rows > MAX_RESIDENT_TIMELINE_ITEMS) break;
    residentRows += rows;
    windowStart -= 1;
  }
  const selectedMessages = new Set(timelineMessages.slice(windowStart, windowEnd));
  const selectedToolIds = new Set<string>();
  for (const message of selectedMessages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type === "toolCall" && typeof (block as { id?: unknown }).id === "string") {
        selectedToolIds.add((block as { id: string }).id);
      }
    }
  }
  const cellNumbers = new Map<string, number>();
  let originalCell = 0;
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall") continue;
      originalCell += 1;
      const id = (block as { id?: unknown }).id;
      if (typeof id === "string" && selectedToolIds.has(id)) {
        cellNumbers.set(clipText(id, 1_024).text, originalCell);
      }
    }
  }
  const selected = (messages ?? []).filter(
    (message) =>
      selectedMessages.has(message) ||
      (message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        selectedToolIds.has(message.toolCallId)),
  );
  let state: ChatState = {
    timeline: [],
    tools: {},
    children: {},
    busy: false,
    retention: emptyRetention(),
  };
  for (const m of selected) {
    if (m.role === "user") {
      const text = (m.content ?? [])
        .map((c) => (c.type === "text" ? String((c as { text?: string }).text ?? "") : ""))
        .join("");
      if (text.trim()) {
        const clipped = clipText(text);
        state = appendTimeline(
          state,
          { kind: "user", key: newKey(), text: clipped.text },
          { turn: true, truncated: clipped.truncated, firstUserText: text },
        );
      }
    } else if (m.role === "assistant") {
      const bounded = boundedBlocks((m.content ?? []) as ContentBlock[]);
      const model = clipText(m.model, 512);
      const provider = clipText(m.provider, 512);
      for (const block of bounded.blocks) {
        if (block.type !== "toolCall") continue;
        const toolCall = block as { id: string; name: string; arguments?: Record<string, unknown> };
        const prev = state.tools[toolCall.id];
        state = {
          ...state,
          tools: boundedTools({
            ...state.tools,
            [toolCall.id]: {
              id: toolCall.id,
              name: toolCall.name,
              args: toolCall.arguments ?? {},
              status: prev?.status ?? "running",
              output: prev?.output ?? "",
              details: prev?.details,
              cellNo: cellNumbers.get(toolCall.id) ?? 0,
            },
          }),
        };
      }
      state = appendTimeline(
        state,
        {
          kind: "assistant",
          key: newKey(),
          blocks: bounded.blocks,
          model: model.text || undefined,
          provider: provider.text || undefined,
          cost: m.usage?.cost?.total,
          streaming: false,
        },
        {
          truncated:
            bounded.truncated || model.truncated || provider.truncated,
        },
      );
    } else if (m.role === "toolResult" && m.toolCallId) {
      state = applyToolResult(
        state,
        m.toolCallId,
        m.toolName ?? "tool",
        { content: (m.content ?? []) as never, details: m.details },
        Boolean(m.isError),
      );
    }
  }
  // Tool args and original session-order cell numbers are captured as each
  // bounded assistant block is admitted above.
  const firstUser = timelineMessages.find((message) => message.role === "user");
  const firstUserText = (firstUser?.content ?? [])
    .map((block) =>
      block.type === "text" ? String((block as { text?: string }).text ?? "") : "",
    )
    .join("")
    .slice(0, 48);
  return {
    ...state,
    retention: {
      ...state.retention,
      totalItems,
      omittedItems: totalItems - state.timeline.length,
      totalTurns: timelineMessages.filter((message) => message.role === "user").length,
      firstUserText,
      windowStart,
      windowEnd,
      windowContiguous: true,
    },
  };
}

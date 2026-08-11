import type { MessageBlock, ParentMessage } from "../../shared/ipc/harness.generated";
import type { ParentTranscriptEvent, ParentTranscriptState } from "./types";

export const MAX_PARENT_MESSAGES = 300;
export const MAX_PARENT_TEXT_CHARS = 128 * 1024;

export function createEmptyParentTranscript(): ParentTranscriptState {
  return { cursor: null, messages: [], omittedBefore: 0, payloadClipped: false };
}

function clipText(value: string, limit: number): { value: string; clipped: boolean } {
  const points = Array.from(value);
  if (points.length <= limit) return { value, clipped: false };
  const suffix = Array.from("\n\n[Content clipped in this view]").slice(0, Math.max(0, limit)).join("");
  return {
    value: `${points.slice(0, Math.max(0, limit - suffix.length)).join("")}${suffix}`,
    clipped: true,
  };
}

function boundAggregateText(messages: readonly ParentMessage[]): {
  messages: readonly ParentMessage[];
  dropped: number;
  clipped: boolean;
} {
  let remaining = MAX_PARENT_TEXT_CHARS;
  let clipped = false;
  let dropped = 0;
  const retained: ParentMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (remaining === 0) {
      dropped += 1;
      clipped = true;
      continue;
    }
    if (message.kind === "user" || message.kind === "notice") {
      const text = clipText(message.text, remaining);
      retained.push({ ...message, text: text.value });
      remaining -= Array.from(text.value).length;
      clipped ||= text.clipped;
      continue;
    }
    const textBlocks = message.blocks.filter((block) => block.kind === "text");
    if (textBlocks.length === 0) {
      if (message.streaming) retained.push({ ...message, blocks: [] });
      continue;
    }
    const blocks: MessageBlock[] = [];
    for (const block of textBlocks) {
      if (remaining === 0) {
        clipped = true;
        break;
      }
      const text = clipText(block.text, remaining);
      blocks.push({ kind: "text", text: text.value });
      remaining -= Array.from(text.value).length;
      clipped ||= text.clipped;
    }
    retained.push({ ...message, blocks });
  }
  return { messages: retained.reverse(), dropped, clipped };
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function sanitizeMessage(value: unknown): { message: ParentMessage; clipped: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.channel !== "parent" || !validIdentity(message.id)) return null;
  if (typeof message.emittedAtMs !== "number" || !Number.isFinite(message.emittedAtMs) || message.emittedAtMs < 0) return null;

  if (message.kind === "user" || message.kind === "notice") {
    if (typeof message.text !== "string") return null;
    const text = clipText(message.text, MAX_PARENT_TEXT_CHARS);
    return {
      message: { channel: "parent", kind: message.kind, id: message.id, text: text.value, emittedAtMs: message.emittedAtMs },
      clipped: text.clipped,
    };
  }
  if (message.kind !== "assistant" || typeof message.streaming !== "boolean" || !Array.isArray(message.blocks)) return null;

  let remaining = MAX_PARENT_TEXT_CHARS;
  let clipped = message.blocks.length > 256;
  const blocks: MessageBlock[] = [];
  for (const candidate of message.blocks.slice(0, 256)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const block = candidate as Record<string, unknown>;
    if (block.kind === "text" && typeof block.text === "string") {
      const text = clipText(block.text, remaining);
      blocks.push({ kind: "text", text: text.value });
      remaining = Math.max(0, remaining - Array.from(text.value).length);
      clipped ||= text.clipped;
    } else if (block.kind === "thinking" && typeof block.text === "string" && typeof block.redacted === "boolean") {
      const text = clipText(block.text, remaining);
      blocks.push({ kind: "thinking", text: text.value, redacted: block.redacted });
      remaining = Math.max(0, remaining - Array.from(text.value).length);
      clipped ||= text.clipped;
    } else if (
      block.kind === "tool_call" && validIdentity(block.toolCallId) && validIdentity(block.toolId) &&
      ["pending", "running", "blocked", "succeeded", "failed"].includes(String(block.status))
    ) {
      blocks.push({
        kind: "tool_call",
        toolCallId: block.toolCallId,
        toolId: block.toolId,
        status: block.status as "pending" | "running" | "blocked" | "succeeded" | "failed",
      });
    } else {
      clipped = true;
    }
  }
  return {
    message: { channel: "parent", kind: "assistant", id: message.id, blocks, streaming: message.streaming, emittedAtMs: message.emittedAtMs },
    clipped,
  };
}

function cursorAdvances(state: ParentTranscriptState, event: ParentTranscriptEvent): boolean {
  if (!validIdentity(event.cursor.runtimeGeneration) || !Number.isSafeInteger(event.cursor.sequence) || event.cursor.sequence < 0) return false;
  if (!state.cursor) return event.type === "snapshot";
  if (event.cursor.runtimeGeneration !== state.cursor.runtimeGeneration) return event.type === "snapshot";
  return event.cursor.sequence > state.cursor.sequence;
}

export function reduceParentTranscript(
  state: ParentTranscriptState,
  event: ParentTranscriptEvent,
): ParentTranscriptState {
  if (!cursorAdvances(state, event)) return state;
  if (event.type === "snapshot") {
    if (!Number.isSafeInteger(event.omittedBefore) || event.omittedBefore < 0) return state;
    const sanitized = event.messages.map(sanitizeMessage).filter((entry) => entry !== null);
    const retained = sanitized.slice(-MAX_PARENT_MESSAGES);
    const bounded = boundAggregateText(retained.map((entry) => entry.message));
    return {
      cursor: event.cursor,
      messages: bounded.messages,
      omittedBefore: event.omittedBefore + Math.max(0, sanitized.length - retained.length) + bounded.dropped,
      payloadClipped: bounded.clipped || sanitized.some((entry) => entry.clipped) || sanitized.length !== event.messages.length,
    };
  }

  const sanitized = sanitizeMessage(event.message);
  if (!sanitized) return state;
  const existingIndex = state.messages.findIndex((message) => message.id === sanitized.message.id);
  let nextMessages: readonly ParentMessage[];
  let omittedBefore = state.omittedBefore;
  if (existingIndex >= 0) {
    if (state.messages[existingIndex]?.kind !== "assistant" || sanitized.message.kind !== "assistant") return state;
    nextMessages = state.messages.map((message, index) => index === existingIndex ? sanitized.message : message);
  } else {
    const appended = [...state.messages, sanitized.message];
    omittedBefore += Math.max(0, appended.length - MAX_PARENT_MESSAGES);
    nextMessages = appended.slice(-MAX_PARENT_MESSAGES);
  }
  const bounded = boundAggregateText(nextMessages);
  omittedBefore += bounded.dropped;
  return {
    cursor: event.cursor,
    messages: bounded.messages,
    omittedBefore,
    payloadClipped: state.payloadClipped || sanitized.clipped || bounded.clipped,
  };
}

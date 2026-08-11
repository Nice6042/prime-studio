import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  eventCallback: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import {
  bootstrapHarness,
  decodeBootProjection,
  decodeHarnessProjectionEvent,
  subscribeHarnessEvents,
} from "./client";

const unavailable = {
  compatibility: { status: "unavailable", reason: "security_verification_failed" },
  sessions: [],
};
const readyCapabilities = [
  "attach_snapshot",
  "event_sequence",
  "resident_sessions",
  "session_input_admission",
  "model_catalog",
] as const;

const session = {
  sessionId: "root",
  accountId: "account",
  projectId: "project",
  chatId: "chat",
  cursor: { runtimeGeneration: "generation", sequence: 1 },
  state: "idle",
  freshness: "live",
  parentMessages: [],
  children: [],
  queue: [],
  tools: [],
  resources: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
};

describe("Harness IPC client", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockImplementation(async (_name: string, callback: (event: { payload: unknown }) => void) => {
      mocks.eventCallback = callback;
      return () => undefined;
    });
    mocks.eventCallback = null;
  });

  it("strictly decodes and deeply freezes an unavailable bootstrap", async () => {
    mocks.invoke.mockResolvedValue(unavailable);
    const projection = await bootstrapHarness();
    expect(projection).toEqual(unavailable);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.compatibility)).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("harness_bootstrap");
  });

  it("rejects extras, impossible capabilities, huge strings, and accessors", () => {
    expect(() => decodeBootProjection({ ...unavailable, extra: true })).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: {
          status: "ready",
          profile: "profile",
          capabilities: ["attach_snapshot", "attach_snapshot"],
        },
        sessions: [],
      }),
    ).toThrow();
    expect(() =>
      decodeBootProjection({
        compatibility: { status: "ready", profile: "x".repeat(129), capabilities: [] },
        sessions: [],
      }),
    ).toThrow();
    const hostile = Object.defineProperty({}, "compatibility", {
      enumerable: true,
      get: () => unavailable.compatibility,
    });
    Object.defineProperty(hostile, "sessions", { enumerable: true, value: [] });
    expect(() => decodeBootProjection(hostile)).toThrow();
  });

  it("rejects proxy inputs without invoking their getters", () => {
    let reads = 0;
    const hostile = new Proxy(unavailable, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => decodeBootProjection(hostile)).toThrow();
    expect(reads).toBe(0);
  });

  it("decodes bounded live sessions and rejects unsafe integer chronology", () => {
    expect(decodeBootProjection({
      compatibility: { status: "ready", profile: "profile", capabilities: readyCapabilities },
      sessions: [session],
    }).sessions).toHaveLength(1);
    expect(() => decodeBootProjection({
      compatibility: { status: "ready", profile: "profile", capabilities: readyCapabilities },
      sessions: [{ ...session, cursor: { ...session.cursor, sequence: Number.MAX_SAFE_INTEGER + 1 } }],
    })).toThrow();
    expect(() => decodeBootProjection({
      compatibility: { status: "ready", profile: "profile", capabilities: readyCapabilities },
      sessions: [{ ...session, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 99, cost: null } }],
    })).toThrow();
    expect(() => decodeBootProjection({
      compatibility: unavailable.compatibility,
      sessions: [session],
    })).toThrow();
    expect(() => decodeBootProjection({
      compatibility: { status: "ready", profile: "profile", capabilities: readyCapabilities },
      sessions: [
        { ...session, children: [{ id: "child", status: "running", task: "task", provider: null, model: null, progress: null }] },
        { ...session, sessionId: "root-2", chatId: "chat-2", children: [{ id: "child", status: "done", task: "task", provider: null, model: null, progress: 1 }] },
      ],
    })).toThrow();
  });

  it("decodes exact projection events", () => {
    expect(decodeHarnessProjectionEvent({ schemaVersion: 1, sequence: 1, type: "session_projection", session })).toEqual({
      schemaVersion: 1, sequence: 1, type: "session_projection", session,
    });
    expect(() => decodeHarnessProjectionEvent({ schemaVersion: 1, sequence: 1, type: "session_projection", session, extra: true })).toThrow();
  });

  it("uses one listener and stops delivery after a sequence gap", async () => {
    const received: number[] = [];
    mocks.invoke.mockResolvedValue({
      compatibility: { status: "ready", profile: "profile", capabilities: readyCapabilities },
      sessions: [session],
    });
    await bootstrapHarness();
    const unsubscribe = subscribeHarnessEvents((event) => received.push(event.sequence));
    await vi.waitFor(() => expect(mocks.eventCallback).not.toBeNull());
    const next = { ...session, cursor: { ...session.cursor, sequence: 2 } };
    mocks.eventCallback?.({ payload: { schemaVersion: 1, sequence: 1, type: "session_projection", session: next } });
    mocks.eventCallback?.({ payload: { schemaVersion: 1, sequence: 3, type: "session_projection", session: { ...next, cursor: { ...next.cursor, sequence: 3 } } } });
    mocks.eventCallback?.({ payload: { schemaVersion: 1, sequence: 2, type: "session_projection", session: { ...next, cursor: { ...next.cursor, sequence: 3 } } } });
    expect(received).toEqual([1]);
    unsubscribe();
  });

  it("can install the global listener after a transient registration failure", async () => {
    vi.resetModules();
    const isolatedClient = await import("./client");
    mocks.invoke.mockResolvedValue(unavailable);
    await isolatedClient.bootstrapHarness();
    mocks.listen.mockRejectedValueOnce(new Error("transient"));
    const unsubscribeFirst = isolatedClient.subscribeHarnessEvents(() => undefined);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
    await isolatedClient.bootstrapHarness();
    const unsubscribeSecond = isolatedClient.subscribeHarnessEvents(() => undefined);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
    expect(mocks.eventCallback).not.toBeNull();
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

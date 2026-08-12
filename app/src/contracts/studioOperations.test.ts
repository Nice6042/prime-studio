import { describe, expect, it } from "vitest";

import {
  createControlBinding,
  dispatchStudioOperation,
  STUDIO_ACTIONS,
  validateControlBindings,
  type StudioActionId,
  type StudioOperation,
  type StudioOperationExecutors,
  type StudioOperationOutcome,
} from "./studioOperations";

const updated: StudioOperationOutcome = { status: "updated", revision: "rev-2" };

function executors(calls: string[]): StudioOperationExecutors {
  const run = async (owner: string) => {
    calls.push(owner);
    return updated;
  };
  return {
    harness: () => run("harness"),
    studioDurable: () => run("studio_durable"),
    renderer: () => run("renderer"),
    native: () => run("native"),
    unsupported: async () => {
      calls.push("unsupported");
      return { status: "unavailable", reason: "Not implemented upstream." };
    },
  };
}

describe("Studio operation contract", () => {
  it("routes one representative operation to each declared authority", async () => {
    const cases: readonly [StudioOperation, string][] = [
      [{ action: "harness.session.prompt", payload: { sessionId: "s1", text: "go" } }, "harness"],
      [{ action: "catalog.chat.create", payload: { projectId: "p1" } }, "studio_durable"],
      [{ action: "layout.sidebar.toggle", payload: {} }, "renderer"],
      [{ action: "window.minimize", payload: {} }, "native"],
      [{ action: "composer.voice.start", payload: {} }, "unsupported"],
    ];

    for (const [operation, expectedOwner] of cases) {
      const calls: string[] = [];
      const outcome = await dispatchStudioOperation(operation, executors(calls));
      expect(outcome.status).toBe(expectedOwner === "unsupported" ? "unavailable" : "updated");
      expect(calls).toEqual([expectedOwner]);
    }
  });

  it("turns an undefined executor result into a contract failure instead of a no-op", async () => {
    const broken = executors([]);
    broken.renderer = async () => undefined as never;

    await expect(dispatchStudioOperation(
      { action: "layout.inspector.toggle", payload: {} },
      broken,
    )).rejects.toThrow("returned no outcome");
  });

  it("requires every interactive binding to name a known action and every disabled binding to explain why", () => {
    expect(validateControlBindings([
      createControlBinding("new-chat", "catalog.chat.create"),
      createControlBinding("voice", "composer.voice.start", "Voice capture is not implemented upstream."),
      createControlBinding("file-menu", "surface.popover.toggle"),
      createControlBinding("queue-accordion", "surface.accordion.toggle"),
    ])).toEqual({ valid: true, count: 4 });

    expect(() => validateControlBindings([
      { controlId: "missing-action", action: "" as StudioActionId, disabledReason: null },
    ])).toThrow("known Studio action");
    expect(() => validateControlBindings([
      { controlId: "disabled-without-truth", action: "composer.voice.start", disabledReason: "" },
    ])).toThrow("disabled reason");
  });

  it("catalogues all controls with a non-noop authority and a result contract", () => {
    const descriptors = Object.values(STUDIO_ACTIONS);
    expect(descriptors).toHaveLength(121);
    expect(descriptors.every((descriptor) => String(descriptor.owner.kind) !== "noop")).toBe(true);
    expect(descriptors.every((descriptor) => descriptor.outcomes.length > 0)).toBe(true);
  });
});

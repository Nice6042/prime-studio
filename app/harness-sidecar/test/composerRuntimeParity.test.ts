import assert from "node:assert/strict";
import test from "node:test";

test("composer runtime operations admit only the exact current catalog and thinking choices", async () => {
  const { dispatchStudioHarnessOperation } = await import("../src/studioHarnessOperations.js");
  const cursor = { runtimeGeneration: "generation-1", sequence: 9 };
  const calls: string[] = [];
  const port = {
    currentCursor: cursor,
    connection: {
      async getModelCatalog() {
        return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }] };
      },
      async getState() {
        return { availableThinkingLevels: ["low", "high"] };
      },
      async setModel(provider: string, model: string) { calls.push(`model:${provider}/${model}`); },
      async setThinkingLevel(level: string) { calls.push(`thinking:${level}`); },
    },
  };

  const model = await dispatchStudioHarnessOperation(port, {
    operationId: "composer-model-1", action: "composer.model.select",
    payload: { chatId: "chat-1", modelId: "openai-codex/gpt-5.6-sol" }, expectedCursor: cursor, idempotencyKey: "composer-model-key-1",
  });
  assert.equal(model.status, "updated");

  const thinking = await dispatchStudioHarnessOperation(port, {
    operationId: "composer-thinking-1", action: "composer.thinking.select",
    payload: { chatId: "chat-1", level: "high" }, expectedCursor: cursor, idempotencyKey: "composer-thinking-key-1",
  });
  assert.equal(thinking.status, "updated");
  assert.deepEqual(calls, ["model:openai-codex/gpt-5.6-sol", "thinking:high"]);
});

test("composer runtime operations reject stale or invented catalog and thinking selections without mutation", async () => {
  const { dispatchStudioHarnessOperation } = await import("../src/studioHarnessOperations.js");
  const cursor = { runtimeGeneration: "generation-1", sequence: 9 };
  let mutations = 0;
  const port = {
    currentCursor: cursor,
    connection: {
      async getModelCatalog() { return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }] }; },
      async getState() { return { availableThinkingLevels: ["low"] }; },
      async setModel() { mutations += 1; },
      async setThinkingLevel() { mutations += 1; },
      async prompt() { mutations += 1; },
    },
  };

  const unknownModel = await dispatchStudioHarnessOperation(port, {
    operationId: "composer-model-unknown", action: "composer.model.select",
    payload: { chatId: "chat-1", modelId: "openai-codex/gpt-5.6-luna" }, expectedCursor: cursor, idempotencyKey: "composer-model-unknown-key",
  });
  assert.equal(unknownModel.status, "unavailable");

  const staleThinking = await dispatchStudioHarnessOperation(port, {
    operationId: "composer-thinking-unknown", action: "composer.thinking.select",
    payload: { chatId: "chat-1", level: "high" }, expectedCursor: cursor, idempotencyKey: "composer-thinking-unknown-key",
  });
  assert.equal(staleThinking.status, "unavailable");

  const rawSlash = await dispatchStudioHarnessOperation(port, {
    operationId: "composer-slash-1", action: "composer.slash.execute",
    payload: { chatId: "chat-1", commandId: "compact", argument: "" }, expectedCursor: cursor, idempotencyKey: "composer-slash-key-1",
  });
  assert.equal(rawSlash.status, "unavailable");
  assert.equal(mutations, 0);
});

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
        return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }], configuredProviders: ["openai-codex"] };
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
      async getModelCatalog() { return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }], configuredProviders: ["openai-codex"] }; },
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

test("unconfigured catalog providers and preflight transport failures never admit composer mutations", async () => {
  const { StudioHarnessOperationDispatcher } = await import("../src/studioHarnessOperations.js");
  const cursor = { runtimeGeneration: "generation-1", sequence: 9 };
  const operation = {
    operationId: "composer-preflight-model", action: "composer.model.select" as const,
    payload: { chatId: "chat-1", modelId: "openai-codex/gpt-5.6-sol" }, expectedCursor: cursor, idempotencyKey: "composer-preflight-model-key",
  };
  let mutations = 0;
  let attempts = 0;
  const dispatcher = new StudioHarnessOperationDispatcher();
  const port = {
    currentCursor: cursor,
    connection: {
      async getModelCatalog() {
        attempts += 1;
        if (attempts === 1) throw new Error("catalog transport interrupted before admission");
        return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }], configuredProviders: ["openai-codex"] };
      },
      async getState() { throw new Error("thinking transport interrupted before admission"); },
      async setModel() { mutations += 1; },
      async setThinkingLevel() { mutations += 1; },
    },
  };

  const unavailableProvider = await dispatcher.dispatch({
    ...port,
    connection: {
      ...port.connection,
      async getModelCatalog() { return { models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }], configuredProviders: [] }; },
    },
  }, { ...operation, operationId: "composer-unconfigured-provider", idempotencyKey: "composer-unconfigured-provider-key" });
  assert.equal(unavailableProvider.status, "unavailable");
  assert.equal(mutations, 0);

  const preflightFailure = await dispatcher.dispatch(port, operation);
  assert.deepEqual(preflightFailure, {
    status: "rejected", reason: "Verified model catalog could not be refreshed before admission.", retryable: true,
  });
  assert.equal(mutations, 0);
  const retry = await dispatcher.dispatch(port, operation);
  assert.equal(retry.status, "updated");
  assert.equal(mutations, 1);

  const effort = await dispatcher.dispatch(port, {
    operationId: "composer-preflight-effort", action: "composer.thinking.select",
    payload: { chatId: "chat-1", level: "high" }, expectedCursor: cursor, idempotencyKey: "composer-preflight-effort-key",
  });
  assert.deepEqual(effort, {
    status: "rejected", reason: "Verified thinking levels could not be refreshed before admission.", retryable: true,
  });
  assert.equal(mutations, 1);
});

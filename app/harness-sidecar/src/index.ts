import { stdout, stderr, stdin } from "node:process";

import { encodeFrame, FrameStreamDecoder, parseClosedJson } from "./framing.js";
import { decideCompatibility } from "./compatibility.js";
import { FakeDaemonController, loadFakeDaemonScenario, type ScenarioRequest } from "./fakeDaemonScenario.js";
import { sanitizeDiagnostic } from "./redaction.js";
import { discoverRuntime } from "./runtimeDiscovery.js";
import { loadVerifiedPrimeDaemonBridge, type PrimeDaemonBridge } from "./primeDaemonBridge.js";
import { STUDIO_HARNESS_ACTIONS, type StudioHarnessAction } from "./studioHarnessOperations.js";

type Mode = Readonly<{ runtimeRoot: string; fixture: null }> | Readonly<{ runtimeRoot: null; fixture: FakeDaemonController }>;

async function modeArgument(argv: readonly string[]): Promise<Mode> {
  const runtimeIndex = argv.indexOf("--runtime-root");
  const fixtureIndex = argv.indexOf("--fixture-scenario");
  const runtimeRoot = runtimeIndex >= 0 ? argv[runtimeIndex + 1] : undefined;
  const fixturePath = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : undefined;
  if (argv.length !== 2 || Boolean(runtimeRoot) === Boolean(fixturePath)) throw new Error("exactly one sidecar mode is required");
  if (fixturePath) return Object.freeze({ runtimeRoot: null, fixture: new FakeDaemonController(await loadFakeDaemonScenario(fixturePath)) });
  return Object.freeze({ runtimeRoot: runtimeRoot!, fixture: null });
}

type ClosedRequest = { studioProtocol: 1; requestId: string; payload: ScenarioRequest };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[!-~]{1,128}$/u.test(value);
}

function validText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) return false;
    if (++count > 131_072) return false;
  }
  return true;
}

const studioHarnessActions = new Set<string>(STUDIO_HARNESS_ACTIONS);

function closedCursor(value: unknown): { runtimeGeneration: string; sequence: number } | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request payload is invalid");
  const cursor = value as Record<string, unknown>;
  if (!exactKeys(cursor, ["runtimeGeneration", "sequence"]) || !validId(cursor.runtimeGeneration) || !Number.isSafeInteger(cursor.sequence) || (cursor.sequence as number) < 0) throw new Error("request payload is invalid");
  return { runtimeGeneration: cursor.runtimeGeneration, sequence: cursor.sequence as number };
}

function closedPayload(value: unknown): ScenarioRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request payload is invalid");
  const payload = value as Record<string, unknown>;
  if ((payload.type === "discover_runtime" || payload.type === "bootstrap") && exactKeys(payload, ["type"])) {
    return { type: payload.type };
  }
  if (payload.type === "create_resident" && exactKeys(payload, ["type", "creationId", "name", "cwd"]) && validId(payload.creationId) && validText(payload.name) && validText(payload.cwd)) {
    if ([...payload.name].length > 200 || [...payload.cwd].length > 4096) throw new Error("request payload is invalid");
    return { type: "create_resident", creationId: payload.creationId, name: payload.name, cwd: payload.cwd };
  }
  if (payload.type === "branch_resident" && exactKeys(payload, ["type", "creationId", "sourceSessionId", "entryId", "name"]) && validId(payload.creationId) && validId(payload.sourceSessionId) && validId(payload.entryId) && validText(payload.name)) {
    if ([...payload.name].length > 200) throw new Error("request payload is invalid");
    return { type: "branch_resident", creationId: payload.creationId, sourceSessionId: payload.sourceSessionId, entryId: payload.entryId, name: payload.name };
  }
  if (payload.type === "attach_session" && exactKeys(payload, ["type", "sessionId"]) && validId(payload.sessionId)) {
    return { type: "attach_session", sessionId: payload.sessionId };
  }
  if (payload.type === "retry_worker" && exactKeys(payload, ["type", "sessionId", "observationId"]) && validId(payload.sessionId) && validId(payload.observationId)) {
    return { type: "retry_worker", sessionId: payload.sessionId, observationId: payload.observationId };
  }
  if (payload.type === "refresh_session" && exactKeys(payload, ["type", "sessionId", "knownCursor"]) && validId(payload.sessionId)) {
    const knownCursor = closedCursor(payload.knownCursor);
    if (!knownCursor) throw new Error("request payload is invalid");
    return { type: "refresh_session", sessionId: payload.sessionId, knownCursor };
  }
  if (payload.type === "inspector" && exactKeys(payload, ["type", "sessionId"]) && validId(payload.sessionId)) {
    return { type: "inspector", sessionId: payload.sessionId };
  }
  if (payload.type === "studio_operation" && exactKeys(payload, ["type", "sessionId", "operationId", "action", "payloadJson", "expectedCursor", "idempotencyKey"]) && validId(payload.sessionId) && validId(payload.operationId) && typeof payload.action === "string" && studioHarnessActions.has(payload.action) && validText(payload.payloadJson) && (payload.idempotencyKey === null || validId(payload.idempotencyKey))) {
    return {
      type: "studio_operation", sessionId: payload.sessionId, operationId: payload.operationId,
      action: payload.action as StudioHarnessAction, payloadJson: payload.payloadJson,
      expectedCursor: closedCursor(payload.expectedCursor), idempotencyKey: payload.idempotencyKey,
    };
  }
  if (payload.type === "session_command" && exactKeys(payload, ["type", "sessionId", "commandId", "expectedCursor", "kind", "text"]) && validId(payload.sessionId) && validId(payload.commandId) && validText(payload.text)) {
    const expectedCursor = payload.expectedCursor;
    if (!expectedCursor || typeof expectedCursor !== "object" || Array.isArray(expectedCursor)) throw new Error("request payload is invalid");
    const cursor = expectedCursor as Record<string, unknown>;
    if (!exactKeys(cursor, ["runtimeGeneration", "sequence"]) || !validId(cursor.runtimeGeneration) || !Number.isSafeInteger(cursor.sequence) || (cursor.sequence as number) < 0) {
      throw new Error("request payload is invalid");
    }
    if (!(["prompt", "steer", "follow_up", "abort"] as const).includes(payload.kind as "prompt" | "steer" | "follow_up" | "abort")) throw new Error("request payload is invalid");
    return {
      type: "session_command",
      sessionId: payload.sessionId,
      commandId: payload.commandId,
      expectedCursor: { runtimeGeneration: cursor.runtimeGeneration, sequence: cursor.sequence as number },
      kind: payload.kind as "prompt" | "steer" | "follow_up" | "abort",
      text: payload.text,
    };
  }
  throw new Error("request payload is invalid");
}

function closedRequest(value: unknown): ClosedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== "payload,requestId,studioProtocol" || request.studioProtocol !== 1) {
    throw new Error("request envelope is invalid");
  }
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(request.requestId)) {
    throw new Error("request ID is invalid");
  }
  return { studioProtocol: 1, requestId: request.requestId, payload: closedPayload(request.payload) };
}

async function main(): Promise<void> {
  const mode = await modeArgument(process.argv.slice(2));
  const decoder = new FrameStreamDecoder();
  let bridge: PrimeDaemonBridge | null = null;
  for await (const chunk of stdin) {
    for (const raw of decoder.push(chunk)) {
      const request = closedRequest(raw);
      try {
        if (mode.fixture) {
          stdout.write(encodeFrame({
            studioProtocol: 1,
            requestId: request.requestId,
            payload: mode.fixture.handle(request.payload),
          }));
          continue;
        }
        const runtime = await discoverRuntime(mode.runtimeRoot);
        if (request.payload.type !== "discover_runtime") {
          bridge ??= await loadVerifiedPrimeDaemonBridge(mode.runtimeRoot);
          if (request.payload.type === "inspector") {
            const detailsJson = JSON.stringify(await bridge.inspector(request.payload.sessionId));
            if ([...detailsJson].length > 131_072) throw new Error("inspector response exceeds its bound");
            stdout.write(encodeFrame({ studioProtocol: 1, requestId: request.requestId, payload: { type: "inspector_result", detailsJson } }));
            continue;
          }
          if (request.payload.type === "studio_operation") {
            const payload = parseClosedJson(request.payload.payloadJson);
            const outcome = await bridge.executeOperation(request.payload.sessionId, {
              operationId: request.payload.operationId, action: request.payload.action, payload,
              expectedCursor: request.payload.expectedCursor, idempotencyKey: request.payload.idempotencyKey,
            });
            const snapshot = ["accepted", "queued", "updated", "cancelled"].includes(outcome.status)
              ? await bridge.snapshot(request.payload.sessionId)
              : null;
            const normalized = {
              type: "studio_operation_result", operationId: request.payload.operationId, status: outcome.status,
              commandId: "commandId" in outcome ? outcome.commandId : null,
              position: "position" in outcome ? outcome.position : null,
              revision: "revision" in outcome ? String(outcome.revision) : null,
              reason: "reason" in outcome ? outcome.reason.slice(0, 200) : null,
              retryable: "retryable" in outcome ? outcome.retryable : null,
              snapshot,
            };
            stdout.write(encodeFrame({ studioProtocol: 1, requestId: request.requestId, payload: normalized }));
            continue;
          }
          stdout.write(encodeFrame({ studioProtocol: 1, requestId: request.requestId, payload: await bridge.handle(request.payload) }));
          continue;
        }
        stdout.write(encodeFrame({
          studioProtocol: 1,
          requestId: request.requestId,
          payload: {
            type: "discover_runtime_result",
            runtime,
            compatibility: decideCompatibility(runtime),
          },
        }));
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "transport_unavailable";
        stdout.write(encodeFrame({
          studioProtocol: 1,
          requestId: request.requestId,
          payload: { type: "error", code, message: "Harness runtime operation failed" },
        }));
        stderr.write(`${sanitizeDiagnostic(error)}\n`);
      }
    }
  }
  if (bridge) await bridge.close();
}

main().catch((error) => {
  stderr.write(`${sanitizeDiagnostic(error)}\n`);
  process.exitCode = 1;
});

import { stdout, stderr, stdin } from "node:process";

import { encodeFrame, FrameStreamDecoder } from "./framing.js";
import { FakeDaemonController, loadFakeDaemonScenario, type ScenarioRequest } from "./fakeDaemonScenario.js";
import { sanitizeDiagnostic } from "./redaction.js";
import { discoverRuntime } from "./runtimeDiscovery.js";

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

function closedPayload(value: unknown): ScenarioRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request payload is invalid");
  const payload = value as Record<string, unknown>;
  if ((payload.type === "discover_runtime" || payload.type === "bootstrap") && exactKeys(payload, ["type"])) {
    return { type: payload.type };
  }
  if (payload.type === "attach_session" && exactKeys(payload, ["type", "sessionId"]) && validId(payload.sessionId)) {
    return { type: "attach_session", sessionId: payload.sessionId };
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
        if (request.payload.type !== "discover_runtime") {
          stdout.write(encodeFrame({
            studioProtocol: 1,
            requestId: request.requestId,
            payload: { type: "error", code: "security_verification_failed", message: "Harness activation is unavailable" },
          }));
          continue;
        }
        const runtime = await discoverRuntime(mode.runtimeRoot);
        stdout.write(encodeFrame({
          studioProtocol: 1,
          requestId: request.requestId,
          payload: {
            type: "discover_runtime_result",
            runtime,
            compatibility: { status: "read_only", reason: "security_verification_failed", runtime },
          },
        }));
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "transport_unavailable";
        stdout.write(encodeFrame({
          studioProtocol: 1,
          requestId: request.requestId,
          payload: { type: "error", code, message: "Harness runtime discovery failed" },
        }));
        stderr.write(`${sanitizeDiagnostic(error)}\n`);
      }
    }
  }
}

main().catch((error) => {
  stderr.write(`${sanitizeDiagnostic(error)}\n`);
  process.exitCode = 1;
});

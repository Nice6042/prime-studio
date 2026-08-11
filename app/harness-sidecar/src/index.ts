import { stdout, stderr, stdin } from "node:process";

import { encodeFrame, FrameStreamDecoder } from "./framing.js";
import { loadFakeDaemonScenario, replyToFakeDaemonRequest, type FakeDaemonScenario } from "./fakeDaemonScenario.js";
import { sanitizeDiagnostic } from "./redaction.js";
import { discoverRuntime } from "./runtimeDiscovery.js";

type Mode = Readonly<{ runtimeRoot: string; fixture: null }> | Readonly<{ runtimeRoot: null; fixture: FakeDaemonScenario }>;

async function modeArgument(argv: readonly string[]): Promise<Mode> {
  const runtimeIndex = argv.indexOf("--runtime-root");
  const fixtureIndex = argv.indexOf("--fixture-scenario");
  const runtimeRoot = runtimeIndex >= 0 ? argv[runtimeIndex + 1] : undefined;
  const fixturePath = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : undefined;
  if (argv.length !== 2 || Boolean(runtimeRoot) === Boolean(fixturePath)) throw new Error("exactly one sidecar mode is required");
  if (fixturePath) return Object.freeze({ runtimeRoot: null, fixture: await loadFakeDaemonScenario(fixturePath) });
  return Object.freeze({ runtimeRoot: runtimeRoot!, fixture: null });
}

type ClosedRequest = { studioProtocol: 1; requestId: string; payload: { type: "discover_runtime" | "bootstrap" } };

function closedRequest(value: unknown): ClosedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== "payload,requestId,studioProtocol" || request.studioProtocol !== 1) {
    throw new Error("request envelope is invalid");
  }
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(request.requestId)) {
    throw new Error("request ID is invalid");
  }
  const payload = request.payload;
  const type = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { type?: unknown }).type : undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).join(",") !== "type" || (type !== "discover_runtime" && type !== "bootstrap")) {
    throw new Error("request payload is invalid");
  }
  return request as ClosedRequest;
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
            payload: replyToFakeDaemonRequest(mode.fixture, request.payload),
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

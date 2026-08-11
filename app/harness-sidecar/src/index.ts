import { stdout, stderr, stdin } from "node:process";

import { encodeFrame, FrameStreamDecoder } from "./framing.js";
import { sanitizeDiagnostic } from "./redaction.js";
import { discoverRuntime } from "./runtimeDiscovery.js";

function runtimeRootArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--runtime-root");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("runtime root is required");
  return value;
}

function closedRequest(value: unknown): { studioProtocol: 1; requestId: string; payload: { type: "discover_runtime" } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== "payload,requestId,studioProtocol" || request.studioProtocol !== 1) {
    throw new Error("request envelope is invalid");
  }
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(request.requestId)) {
    throw new Error("request ID is invalid");
  }
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).join(",") !== "type" || (payload as { type?: unknown }).type !== "discover_runtime") {
    throw new Error("request payload is invalid");
  }
  return request as { studioProtocol: 1; requestId: string; payload: { type: "discover_runtime" } };
}

async function main(): Promise<void> {
  const root = runtimeRootArgument(process.argv.slice(2));
  const decoder = new FrameStreamDecoder();
  for await (const chunk of stdin) {
    for (const raw of decoder.push(chunk)) {
      const request = closedRequest(raw);
      try {
        const runtime = await discoverRuntime(root);
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

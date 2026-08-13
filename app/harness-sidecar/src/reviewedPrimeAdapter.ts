import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const REVIEWED_PRIME_ADAPTER_DIGEST =
  "sha256:8097d080916562ffb8c1c80e2cc4a0640418fa5ec8e09456077d3cffb9c785e3";

const ADAPTER_DIRECTORY = new URL("./vendor/", import.meta.url);
const ADAPTER_RESOURCE = new URL("prime-daemon-adapter-v0.7.1.mjs", ADAPTER_DIRECTORY);
const MAX_ADAPTER_BYTES = 8 * 1024 * 1024;

export interface ReviewedPrimeAdapter {
  readonly DaemonClient: new (socketPath: string) => unknown;
  readonly DaemonAgentConnection: Readonly<{
    attach(client: unknown, sessionId: string, options: object): Promise<unknown>;
  }>;
  readonly AuthStorage: new (...arguments_: never[]) => unknown;
  readonly ModelRegistry: new (...arguments_: never[]) => unknown;
  readonly DAEMON_PROTOCOL_INFO: Readonly<{ name: "prime-agent.daemon"; version: 7 }>;
  readonly defaultDaemonSocketPath: () => string;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validate(namespace: Record<string, unknown>): ReviewedPrimeAdapter {
  const Client = namespace.DaemonClient;
  const Connection = namespace.DaemonAgentConnection;
  const AuthStorage = namespace.AuthStorage;
  const ModelRegistry = namespace.ModelRegistry;
  const protocol = namespace.DAEMON_PROTOCOL_INFO;
  const socket = namespace.defaultDaemonSocketPath;
  if (typeof Client !== "function" || typeof Connection !== "function" || typeof AuthStorage !== "function" || typeof ModelRegistry !== "function" || typeof socket !== "function") {
    throw new Error("reviewed Prime adapter exports are unavailable");
  }
  if (typeof (Connection as unknown as Readonly<Record<string, unknown>>).attach !== "function") {
    throw new Error("reviewed Prime adapter attach export is unavailable");
  }
  if (!protocol || typeof protocol !== "object" || (protocol as { name?: unknown }).name !== "prime-agent.daemon" || (protocol as { version?: unknown }).version !== 7) {
    throw new Error("reviewed Prime adapter protocol identity is unavailable");
  }
  return Object.freeze({
    DaemonClient: Client as ReviewedPrimeAdapter["DaemonClient"],
    DaemonAgentConnection: Connection as unknown as ReviewedPrimeAdapter["DaemonAgentConnection"],
    AuthStorage: AuthStorage as ReviewedPrimeAdapter["AuthStorage"],
    ModelRegistry: ModelRegistry as ReviewedPrimeAdapter["ModelRegistry"],
    DAEMON_PROTOCOL_INFO: protocol as ReviewedPrimeAdapter["DAEMON_PROTOCOL_INFO"],
    defaultDaemonSocketPath: socket as ReviewedPrimeAdapter["defaultDaemonSocketPath"],
  });
}

/**
 * Evaluates only the exact bytes whose digest was checked. A data URL avoids
 * the check-then-import path race that exists when importing a mutable file.
 */
export async function loadReviewedPrimeAdapterBytes(
  bytes: Uint8Array,
  expectedDigest: string = REVIEWED_PRIME_ADAPTER_DIGEST,
): Promise<ReviewedPrimeAdapter> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ADAPTER_BYTES) {
    throw new Error("reviewed Prime adapter size is invalid");
  }
  if (digest(bytes) !== expectedDigest) throw new Error("reviewed Prime adapter integrity mismatch");
  const source = Buffer.from(bytes).toString("base64");
  const priorPackageDirectory = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = fileURLToPath(ADAPTER_DIRECTORY);
  try {
    const namespace = await import(`data:text/javascript;base64,${source}`) as Record<string, unknown>;
    return validate(namespace);
  } finally {
    if (priorPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = priorPackageDirectory;
  }
}

export async function loadReviewedPrimeAdapter(): Promise<ReviewedPrimeAdapter> {
  return loadReviewedPrimeAdapterBytes(await readFile(ADAPTER_RESOURCE));
}

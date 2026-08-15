python - <<'PY'
from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:80]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")

replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    'import { loadReviewedPrimeAdapter } from "./reviewedPrimeAdapter.js";\n',
    'import { loadReviewedPrimeAdapter } from "./reviewedPrimeAdapter.js";\nimport { profileForRuntimeIdentity } from "./profiles/index.js";\n',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    'function rootState(state: Record<string, unknown>): FakeRootSessionSnapshot["state"] {\n  if (state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true) return "working";\n  return "idle";\n}',
    'function rootState(state: Record<string, unknown>): FakeRootSessionSnapshot["state"] {\n  if (state.workerState === "stopping") return "stopped";\n  if (state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true) return "working";\n  return "idle";\n}',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    'if (state !== "starting" && state !== "ready" && state !== "recovering" && state !== "failed") throw new Error("daemon worker recovery state is invalid");',
    'if (state !== "starting" && state !== "stopping" && state !== "ready" && state !== "recovering" && state !== "failed") throw new Error("daemon worker recovery state is invalid");',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    '    if (state === "starting") {\n      projection = { status: "starting", closureReason: null, observationId: null, automaticRetryCount: 0, detail: "The verified supervisor is starting this worker." };\n    } else if (state === "ready") {',
    '    if (state === "starting") {\n      projection = { status: "starting", closureReason: null, observationId: null, automaticRetryCount: 0, detail: "The verified supervisor is starting this worker." };\n    } else if (state === "stopping") {\n      projection = { status: "stopping", closureReason: null, observationId: null, automaticRetryCount: 0, detail: "The verified supervisor is stopping this worker." };\n    } else if (state === "ready") {',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    '      state: "failed" as const,\n      workerRecovery: Object.freeze({ ...recovery }),',
    '      state: recovery.status === "stopping" ? "stopped" as const : "failed" as const,\n      workerRecovery: Object.freeze({ ...recovery }),',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    '  if (compatibility.status !== "ready" && compatibility.status !== "degraded") throw new Error("runtime identity is incompatible");\n  const root = await realpath(packageRoot);',
    '  if (compatibility.status !== "ready" && compatibility.status !== "degraded") throw new Error("runtime identity is incompatible");\n  const profile = profileForRuntimeIdentity(identity);\n  if (!profile || profile.id !== compatibility.profile) throw new Error("runtime compatibility profile is unavailable");\n  const root = await realpath(packageRoot);',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    '  const { DAEMON_V7_SCHEMA13_PROFILE } = await import("./profiles/daemon-v7-schema13.js");\n  if (daemonDigest !== DAEMON_V7_SCHEMA13_PROFILE.daemonEntrypointDigest) throw new Error("daemon entrypoint identity mismatch");\n  const runtimeClosure = await lockVerifiedRuntimeClosure(root);',
    '  if (daemonDigest !== profile.daemonEntrypointDigest) throw new Error("daemon entrypoint identity mismatch");\n  const runtimeClosure = await lockVerifiedRuntimeClosure(root, {\n    digest: profile.distJavascriptClosureDigest,\n    files: profile.distJavascriptClosureFiles,\n  });',
)
replace_once(
    "app/harness-sidecar/src/primeDaemonBridge.ts",
    '    const namespace = await loadReviewedPrimeAdapter();',
    '    const namespace = await loadReviewedPrimeAdapter(profile);',
)
replace_once(
    "app/harness-sidecar/src/fakeDaemonScenario.ts",
    'readonly status: "starting" | "ready" | "recovering" | "retryable_failure" | "retrying" | "recovered" | "terminal_failure";',
    'readonly status: "starting" | "stopping" | "ready" | "recovering" | "retryable_failure" | "retrying" | "recovered" | "terminal_failure";',
)
replace_once(
    "app/scripts/generate-harness-contract.mjs",
    '  status: "starting" | "ready" | "recovering" | "retryable_failure" | "retrying" | "recovered" | "terminal_failure";',
    '  status: "starting" | "stopping" | "ready" | "recovering" | "retryable_failure" | "retrying" | "recovered" | "terminal_failure";',
)
replace_once(
    "app/scripts/generate-harness-contract.mjs",
    'pub enum WorkerRecoveryStatus { Starting, Ready, Recovering, RetryableFailure, Retrying, Recovered, TerminalFailure }',
    'pub enum WorkerRecoveryStatus { Starting, Stopping, Ready, Recovering, RetryableFailure, Retrying, Recovered, TerminalFailure }',
)
replace_once(
    "app/src/features/harness/HarnessInspector.tsx",
    '{session?.workerRecovery.status === "starting" && <p className="harness-recovery-status" role="status"><strong>Worker starting.</strong> The verified supervisor has not reported this worker ready yet.</p>}\n',
    '{session?.workerRecovery.status === "starting" && <p className="harness-recovery-status" role="status"><strong>Worker starting.</strong> The verified supervisor has not reported this worker ready yet.</p>}\n    {session?.workerRecovery.status === "stopping" && <p className="harness-recovery-status" role="status"><strong>Worker stopping.</strong> The verified supervisor is closing this worker and Studio will not report it ready.</p>}\n',
)

schema_path = Path("app/contracts/harness-v1.schema.json")
schema = schema_path.read_text(encoding="utf-8")
pattern = r'("status"\s*:\s*\{\s*"type"\s*:\s*"string"\s*,\s*"enum"\s*:\s*\[\s*"starting"\s*,\s*)("ready")'
updated, count = re.subn(pattern, r'\1"stopping", \2', schema, count=1)
if count != 1:
    raise SystemExit(f"worker recovery schema enum match count: {count}")
schema_path.write_text(updated, encoding="utf-8")
PY

cd app
npm ci
npm run generate:harness-contract
npm run test:harness-sidecar
npm test -- src/features/harness/HarnessInspector.test.tsx src/shared/ipc/client.test.ts --maxWorkers=1 --no-file-parallelism
npm run check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check

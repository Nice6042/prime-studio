import { describe, expect, it } from "vitest";
import * as computerUseModule from "./computerUse";

import {
  COMPUTER_USE_LIMITS,
  acknowledgeActionCancellation,
  appendActionLedgerRecord as appendActionLedgerRecordTransport,
  applyTakeoverEvent as applyTakeoverEventTransport,
  bindForeground,
  createActionLedger,
  createComputerUseTestHarness,
  createTakeoverState,
  decodeApprovalGrant,
  decodeComputerUseIntent,
  decodeComputerUseTarget,
  decodeDisplayMetadata,
  decodeForegroundBinding,
  decodeTakeoverState,
  digestExecutableIdentity,
  evaluateComputerUseIntent as evaluateComputerUseIntentTransport,
  getActionOutcome,
  markOutcomeUnknown,
  requestActionCancellation,
  recordWorkerOutcome,
  resolveScreenCoordinate,
  revalidateBeforeExecution as revalidateBeforeExecutionTransport,
  revokeApproval as revokeApprovalTransport,
  sameControlIdentity,
  sameProcessIdentity,
  sameWindowIdentity,
  type ActionLedger,
  type ActionLedgerRecordInput,
  type ApprovalGrant,
  type AuthorityBinding,
  type ClipboardIntent,
  type ComputerUseAllowLists,
  type ComputerUseBroker,
  type ComputerUseIntent,
  type ComputerUsePolicyContext,
  type DataHandlingPolicy,
  type DisplayMetadata,
  type ExecutableIdentity,
  type ExecutableIntent,
  type InputIntent,
  type ProcessIdentity,
  type ProcessIntent,
  type ScreenshotIntent,
  type SecurityReadiness,
  type UiPreState,
  type WindowIdentity,
} from "./computerUse";

const hex = (character: string): string => character.repeat(64);
const transport = (value: unknown): string => JSON.stringify(value);
const computerUseTestHarness = createComputerUseTestHarness();
const createComputerUseBroker = computerUseTestHarness.createBroker;
const createSecurityReadiness = computerUseTestHarness.createReadiness;
const createApprovalGrant = computerUseTestHarness.createApproval;
const evaluateComputerUseIntent = (
  intent: ComputerUseIntent,
  context: ComputerUsePolicyContext,
  broker: ComputerUseBroker,
) => evaluateComputerUseIntentTransport(transport(intent), transport(context), broker);
const revalidateBeforeExecution = (
  decision: ReturnType<typeof evaluateComputerUseIntentTransport>,
  intent: ComputerUseIntent,
  context: ComputerUsePolicyContext,
  broker: ComputerUseBroker,
) => revalidateBeforeExecutionTransport(decision, transport(intent), transport(context), broker);
const revokeApproval = (
  context: ComputerUsePolicyContext,
  approvalId: string,
  atMs: number,
  broker: ComputerUseBroker,
) => revokeApprovalTransport(transport(context), approvalId, atMs, broker);
const applyTakeoverEvent = (
  state: ReturnType<typeof createTakeoverState>,
  event: unknown,
  broker: ComputerUseBroker,
) => applyTakeoverEventTransport(transport(state), transport(event), broker);
const appendActionLedgerRecord = (
  ledger: ActionLedger,
  input: ActionLedgerRecordInput,
  broker: ComputerUseBroker,
) => appendActionLedgerRecordTransport(ledger, transport(input), broker);

const authority = (overrides: Partial<AuthorityBinding> = {}): AuthorityBinding => ({
  accountId: "account-1",
  projectId: "project-1",
  chatId: "chat-1",
  sessionId: "session-1",
  principalId: "principal-1",
  policyId: "policy-1",
  brokerId: "broker-1",
  workerId: "worker-1",
  accountEpoch: 1,
  projectEpoch: 1,
  chatEpoch: 1,
  sessionEpoch: 1,
  principalEpoch: 1,
  policyEpoch: 1,
  brokerEpoch: 1,
  workerEpoch: 1,
  readinessEpoch: 1,
  ...overrides,
});

const fileExecutable = (overrides: Partial<Extract<ExecutableIdentity, { readonly kind: "file" }>> = {}): Extract<ExecutableIdentity, { readonly kind: "file" }> => ({
  kind: "file",
  canonicalPath: "C:\\Windows\\System32\\notepad.exe",
  volumeSerialNumber: "volume-system",
  fileId: "file-notepad",
  signerSha256: hex("a"),
  sha256: hex("b"),
  ...overrides,
});

const packagedExecutable = (overrides: Partial<Extract<ExecutableIdentity, { readonly kind: "packaged" }>> = {}): Extract<ExecutableIdentity, { readonly kind: "packaged" }> => ({
  kind: "packaged",
  aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  packageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
  packageFullName: "Microsoft.WindowsCalculator_11.0.0.0_x64__8wekyb3d8bbwe",
  publisherId: "CN=Microsoft Corporation",
  packagePublisherSha256: hex("c"),
  ...overrides,
});

const processIdentity = (
  overrides: Partial<ProcessIdentity> = {},
  executable: ExecutableIdentity = fileExecutable(),
): ProcessIdentity => ({
  pid: 41,
  creationTimeMs: 10_000,
  executable,
  ...overrides,
});

const windowIdentity = (
  overrides: Partial<WindowIdentity> = {},
  process = processIdentity(),
): WindowIdentity => ({
  hwnd: "0x1001",
  process,
  className: "Notepad",
  title: "Notes",
  ...overrides,
});

const uiPreState = (overrides: Partial<UiPreState> = {}): UiPreState => ({
  observedAtMs: 190,
  windowBounds: { left: 0, top: 0, right: 800, bottom: 600 },
  windowState: "normal",
  visible: true,
  enabled: true,
  foreground: true,
  occlusion: "none",
  uiaSnapshotSha256: hex("d"),
  ...overrides,
});

const target = (overrides: Record<string, unknown> = {}) => {
  const process = processIdentity();
  const window = windowIdentity({}, process);
  const control = {
    window,
    runtimeId: [7, 8],
    boundingRect: { left: 10, top: 10, right: 790, bottom: 590 },
    automationId: "Editor",
    controlType: "Edit",
    frameworkId: "Win32",
    name: "Text editor",
    passwordField: false,
  } as const;
  return { process, window, control, preState: uiPreState(), ...overrides } as ReturnType<typeof targetShape>;
};

const targetShape = () => {
  const process = processIdentity();
  const window = windowIdentity({}, process);
  return {
    process,
    window,
    control: {
      window,
      runtimeId: [7, 8] as readonly number[],
      boundingRect: { left: 10, top: 10, right: 790, bottom: 590 },
      automationId: "Editor",
      controlType: "Edit",
      frameworkId: "Win32",
      name: "Text editor",
      passwordField: false,
    },
    preState: uiPreState(),
  };
};

const display: DisplayMetadata = {
  monitors: [
    {
      id: "primary",
      bounds: { left: 0, top: 0, right: 1920, bottom: 1080 },
      workArea: { left: 0, top: 0, right: 1920, bottom: 1040 },
      scaleFactor: 1,
      dpi: 96,
      primary: true,
    },
    {
      id: "left",
      bounds: { left: -2560, top: 0, right: -640, bottom: 1440 },
      workArea: { left: -2560, top: 0, right: -640, bottom: 1400 },
      scaleFactor: 1.25,
      dpi: 120,
      primary: false,
    },
  ],
  virtualBounds: { left: -2560, top: 0, right: 1920, bottom: 1440 },
};

const dataPolicy = (overrides: Partial<DataHandlingPolicy> = {}): DataHandlingPolicy => ({
  category: "workspace",
  redaction: "required",
  redactorId: "redactor-v1",
  persistence: "ephemeral",
  maxBytes: 1_000_000,
  retentionMs: 60_000,
  ...overrides,
});

const screenshotIntent = (
  binding: AuthorityBinding,
  overrides: Partial<ScreenshotIntent> = {},
): ScreenshotIntent => ({
  kind: "screenshot",
  intentId: "screenshot-1",
  authority: binding,
  target: target(),
  dataPolicy: dataPolicy(),
  ...overrides,
});

const inputIntent = (
  binding: AuthorityBinding,
  overrides: Partial<InputIntent> = {},
): InputIntent => ({
  kind: "input",
  intentId: "input-1",
  authority: binding,
  target: target(),
  action: {
    type: "mouse",
    action: "click",
    coordinate: { monitorId: "primary", x: 10, y: 20, space: "physical" },
  },
  ...overrides,
});

const defaultAllowlists: ComputerUseAllowLists = {
  clipboardOperations: [],
  processOperations: [],
  executableAuthorities: [],
  dataCategories: ["public", "workspace", "personal", "confidential"],
};

const readinessOptions = {
  status: "enforced" as const,
  checkedAtMs: 100,
  expiresAtMs: 500,
  runtimeSha256: hex("1"),
  securityExtensionSha256: hex("2"),
  brokerBinarySha256: hex("3"),
  workerBinarySha256: hex("4"),
};

const policyContext = (
  binding: AuthorityBinding,
  readiness: SecurityReadiness,
  overrides: Partial<ComputerUsePolicyContext> = {},
): ComputerUsePolicyContext => {
  const currentTarget = target();
  return {
    nowMs: 200,
    authority: binding,
    readiness,
    foreground: bindForeground(currentTarget.window, currentTarget.preState, 100, 500, {
      bindingId: "foreground-1",
      epoch: 1,
      focusedControl: currentTarget.control,
    }),
    display,
    security: {
      passwordField: false,
      secureDesktop: false,
      callerIntegrity: "medium",
      targetIntegrity: "medium",
    },
    approvals: [],
    takeover: createTakeoverState(),
    approvalEpoch: 1,
    freshnessEpoch: 1,
    allowlists: defaultAllowlists,
    ...overrides,
  };
};

interface Setup<TIntent extends ComputerUseIntent> {
  readonly authority: AuthorityBinding;
  readonly broker: ComputerUseBroker;
  readonly readiness: SecurityReadiness;
  readonly intent: TIntent;
  readonly grant: ApprovalGrant;
  readonly context: ComputerUsePolicyContext;
}

const setup = <TIntent extends ComputerUseIntent>(
  buildIntent: (binding: AuthorityBinding) => TIntent,
  contextOverrides: Partial<ComputerUsePolicyContext> = {},
): Setup<TIntent> => {
  const binding = authority();
  const broker = createComputerUseBroker(binding);
  const readiness = createSecurityReadiness(broker, readinessOptions);
  const intent = buildIntent(binding);
  const grant = createApprovalGrant(intent, {
    approvalId: `approval-${intent.intentId}`,
    epoch: 1,
    grantedAtMs: 100,
    expiresAtMs: 500,
    display,
  }, broker);
  const context = policyContext(binding, readiness, { approvals: [grant], ...contextOverrides });
  return { authority: binding, broker, readiness, intent, grant, context };
};

const deniedReason = (decision: ReturnType<typeof evaluateComputerUseIntent>): string => {
  if (decision.allowed) throw new Error("Expected denial");
  return decision.reason;
};

describe("broker-bound authority and readiness", () => {
  it.each([
    "accountId", "projectId", "chatId", "sessionId", "principalId", "policyId", "brokerId", "workerId",
    "accountEpoch", "projectEpoch", "chatEpoch", "sessionEpoch", "principalEpoch", "policyEpoch", "brokerEpoch", "workerEpoch", "readinessEpoch",
  ] as const)("binds %s into intent, approval, broker, worker, and policy authority", (field) => {
    const prepared = setup((binding) => screenshotIntent(binding));
    const changed = typeof prepared.authority[field] === "number"
      ? { ...prepared.authority, [field]: (prepared.authority[field] as number) + 1 }
      : { ...prepared.authority, [field]: `${prepared.authority[field]}-other` };
    const hostileIntent = { ...prepared.intent, authority: changed } as ScreenshotIntent;

    expect(deniedReason(evaluateComputerUseIntent(hostileIntent, prepared.context, prepared.broker))).toBe("authority-mismatch");
  });

  it("denies unavailable, admission-only, expired, or forged readiness", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding);
    const intent = screenshotIntent(binding);

    for (const status of ["unavailable", "admission_only"] as const) {
      const readiness = createSecurityReadiness(broker, { ...readinessOptions, status });
      expect(deniedReason(evaluateComputerUseIntent(intent, policyContext(binding, readiness), broker))).toBe("readiness-not-enforced");
    }

    const expired = createSecurityReadiness(broker, { ...readinessOptions, expiresAtMs: 200 });
    expect(deniedReason(evaluateComputerUseIntent(intent, policyContext(binding, expired), broker))).toBe("readiness-expired");

    const valid = createSecurityReadiness(broker, readinessOptions);
    const forged = { ...valid, workerBinarySha256: hex("9") } as SecurityReadiness;
    expect(deniedReason(evaluateComputerUseIntent(intent, policyContext(binding, forged), broker))).toBe("default-deny");
  });

  it("rejects a different broker instance and emits keyed SHA-256 evidence", () => {
    const prepared = setup((binding) => screenshotIntent(binding));
    const otherBroker = createComputerUseBroker(prepared.authority);
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.brokerEvidence).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(decision.leaseToken.brokerEvidence).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(deniedReason(evaluateComputerUseIntent(prepared.intent, prepared.context, otherBroker))).toBe("broker-unbound");
  });
});

describe("atomic approval lease and start", () => {
  it("performs a single broker-owned leased-to-started CAS", () => {
    const prepared = setup((binding) => inputIntent(binding));
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);

    expect(decision).toMatchObject({ allowed: true, leaseToken: { state: "leased", version: 1 } });
    const first = revalidateBeforeExecution(decision, prepared.intent, prepared.context, prepared.broker);
    const raced = revalidateBeforeExecution({ ...decision }, prepared.intent, prepared.context, prepared.broker);

    expect(first).toMatchObject({ allowed: true, startedToken: { state: "started", version: 2 } });
    expect(raced).toEqual({ allowed: false, reason: "stale-decision" });
    expect(deniedReason(evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker))).toBe("approval-used");
  });

  it("rejects a forged grant and revocation wins over a cached lease", () => {
    const prepared = setup((binding) => inputIntent(binding));
    const forged = { ...prepared.grant, targetDigest: hex("f") } as ApprovalGrant;
    expect(decodeApprovalGrant(transport(forged), prepared.broker)).toBeNull();

    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
    const revoked = revokeApproval(prepared.context, prepared.grant.approvalId, 210, prepared.broker);
    expect(revalidateBeforeExecution(decision, prepared.intent, revoked, prepared.broker)).toEqual({
      allowed: false,
      reason: "approval-revoked",
    });
  });
});

describe("Windows executable, process, window, and UIA identity", () => {
  it("binds packaged AUMID identity or canonical file/signer/hash identity plus PID creation time", () => {
    const fileProcess = processIdentity();
    expect(sameProcessIdentity(fileProcess, processIdentity({ creationTimeMs: 10_001 }))).toBe(false);
    expect(sameProcessIdentity(fileProcess, processIdentity({}, fileExecutable({ fileId: "other-file" })))).toBe(false);
    expect(sameProcessIdentity(fileProcess, processIdentity({}, fileExecutable({ signerSha256: hex("e") })))).toBe(false);
    expect(sameProcessIdentity(fileProcess, processIdentity({}, fileExecutable({ sha256: hex("e") })))).toBe(false);
    expect(sameProcessIdentity(processIdentity({}, packagedExecutable()), processIdentity({}, packagedExecutable({ aumid: "Other!App" })))).toBe(false);
    expect(digestExecutableIdentity(fileExecutable())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects non-canonical executable paths and mismatched process/executable authority", () => {
    const invalid = target({
      process: processIdentity({}, fileExecutable({ canonicalPath: "C:\\Windows\\System32\\..\\calc.exe" })),
    });
    expect(decodeComputerUseTarget(transport(invalid))).toBeNull();

    const binding = authority();
    const mismatched = {
      kind: "process",
      intentId: "process-1",
      authority: binding,
      target: target(),
      operation: "terminate",
      executable: fileExecutable({ canonicalPath: "C:\\Windows\\System32\\calc.exe", fileId: "file-calc", sha256: hex("e") }),
    } as ProcessIntent;
    expect(decodeComputerUseIntent(transport(mismatched))).toBeNull();

    const broker = createComputerUseBroker(binding);
    const readiness = createSecurityReadiness(broker, readinessOptions);
    expect(deniedReason(evaluateComputerUseIntent(mismatched, policyContext(binding, readiness, {
      allowlists: {
        ...defaultAllowlists,
        processOperations: ["terminate"],
        executableAuthorities: [mismatched.executable],
      },
    }), broker))).toBe("default-deny");
  });

  it("matches exact HWND/process/control identity and rejects stale UIA pre-state", () => {
    const currentTarget = target();
    expect(sameWindowIdentity(currentTarget.window, windowIdentity({ title: "Other" }, currentTarget.process))).toBe(false);
    expect(sameControlIdentity(currentTarget.control, { ...currentTarget.control, runtimeId: [7, 9] })).toBe(false);

    const prepared = setup((binding) => inputIntent(binding));
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
    const changedForeground = bindForeground(prepared.intent.target.window, uiPreState({ uiaSnapshotSha256: hex("e") }), 100, 500, {
      bindingId: "foreground-changed",
      epoch: 2,
      focusedControl: prepared.intent.target.control,
    });
    expect(revalidateBeforeExecution(decision, prepared.intent, { ...prepared.context, foreground: changedForeground, freshnessEpoch: 2 }, prepared.broker)).toEqual({
      allowed: false,
      reason: "stale-decision",
    });
  });

  it("rejects a UIA observation from the future", () => {
    const futureTarget = target({ preState: uiPreState({ observedAtMs: 250 }) });
    const prepared = setup((binding) => inputIntent(binding, { target: futureTarget }));
    const foreground = bindForeground(futureTarget.window, futureTarget.preState, 100, 500, {
      bindingId: "foreground-future",
      epoch: 1,
      focusedControl: futureTarget.control,
    });

    expect(deniedReason(evaluateComputerUseIntent(
      prepared.intent,
      { ...prepared.context, foreground },
      prepared.broker,
    ))).toBe("stale-decision");
  });

  it.each([
    ["minimized", uiPreState({ windowState: "minimized" }), "target-not-visible"],
    ["closed", uiPreState({ windowState: "closed", visible: false }), "target-not-visible"],
    ["hidden", uiPreState({ visible: false }), "target-not-visible"],
    ["occluded", uiPreState({ occlusion: "full" }), "target-occluded"],
    ["unknown occlusion", uiPreState({ occlusion: "unknown" }), "target-occluded"],
  ] as const)("denies a %s target", (_label, preState, reason) => {
    const prepared = setup((binding) => inputIntent(binding, { target: target({ preState }) }));
    expect(deniedReason(evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker))).toBe(reason);
  });

  it("requires the exact focused control for keyboard input", () => {
    const prepared = setup((binding) => inputIntent(binding, {
      action: { type: "keyboard", action: "text_input", value: "hello" },
    }));
    const wrongControl = { ...prepared.intent.target.control!, name: "Other editor" };
    const foreground = bindForeground(prepared.intent.target.window, prepared.intent.target.preState, 100, 500, {
      bindingId: "foreground-wrong-control",
      epoch: 1,
      focusedControl: wrongControl,
    });
    expect(deniedReason(evaluateComputerUseIntent(prepared.intent, { ...prepared.context, foreground }, prepared.broker))).toBe("focused-control-mismatch");
  });
});

describe("capture and clipboard data boundaries", () => {
  it("requires bounded screenshot redaction and non-durable persistence", () => {
    for (const policy of [
      dataPolicy({ redaction: "none", redactorId: null }),
      dataPolicy({ category: "credential" }),
      dataPolicy({ persistence: "durable" as never }),
      dataPolicy({ maxBytes: COMPUTER_USE_LIMITS.maxScreenshotBytes + 1 }),
      dataPolicy({ retentionMs: COMPUTER_USE_LIMITS.maxRetentionMs + 1 }),
    ]) {
      const prepared = setup((binding) => screenshotIntent(binding, { dataPolicy: policy }));
      expect(evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker).allowed).toBe(false);
    }
  });

  it("binds screenshot region and data policy into the approval digest", () => {
    const prepared = setup((binding) => screenshotIntent(binding, {
      region: { monitorId: "primary", x: 20, y: 30, width: 400, height: 200, space: "physical" },
    }));
    expect(evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker).allowed).toBe(true);
    const changed = { ...prepared.intent, dataPolicy: dataPolicy({ retentionMs: 30_000 }) };
    expect(deniedReason(evaluateComputerUseIntent(changed, prepared.context, prepared.broker))).toBe("approval-action-mismatch");
  });

  it("denies secret clipboard categories and bounds clipboard text", () => {
    const binding = authority();
    const secretRead: ClipboardIntent = {
      kind: "clipboard",
      intentId: "clipboard-secret",
      authority: binding,
      target: target(),
      operation: "read",
      dataPolicy: dataPolicy({ category: "secret" }),
    };
    const hugeWrite = {
      kind: "clipboard",
      intentId: "clipboard-huge",
      authority: binding,
      target: target(),
      operation: "write",
      text: "x".repeat(COMPUTER_USE_LIMITS.maxClipboardTextBytes + 1),
      dataPolicy: dataPolicy({ maxBytes: COMPUTER_USE_LIMITS.maxClipboardTextBytes }),
    } as ClipboardIntent;
    expect(decodeComputerUseIntent(transport(hugeWrite))).toBeNull();

    const broker = createComputerUseBroker(binding);
    const readiness = createSecurityReadiness(broker, readinessOptions);
    const grant = createApprovalGrant(secretRead, { approvalId: "approval-secret", epoch: 1, grantedAtMs: 100, expiresAtMs: 500 }, broker);
    const context = policyContext(binding, readiness, {
      approvals: [grant],
      allowlists: { ...defaultAllowlists, clipboardOperations: ["read"] },
    });
    expect(deniedReason(evaluateComputerUseIntent(secretRead, context, broker))).toBe("sensitive-data-category");

    const capped = setup((scope) => ({
      kind: "clipboard",
      intentId: "clipboard-capped",
      authority: scope,
      target: target(),
      operation: "write",
      text: "four",
      dataPolicy: dataPolicy({ maxBytes: 3 }),
    }), {
      allowlists: { ...defaultAllowlists, clipboardOperations: ["write"] },
    });
    expect(deniedReason(evaluateComputerUseIntent(capped.intent, capped.context, capped.broker))).toBe("data-limit-exceeded");
  });
});

describe("user takeover revocation and bounded worker shutdown", () => {
  it("immediately revokes a leased action and requires a bounded worker acknowledgement", () => {
    const prepared = setup((binding) => inputIntent(binding));
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
    computerUseTestHarness.setTrustedNow(prepared.broker, 210);
    const takeover = applyTakeoverEvent(createTakeoverState(), computerUseTestHarness.createTakeoverEvent(prepared.broker, {
      type: "takeover",
      takeoverId: "takeover-1",
      workerId: prepared.authority.workerId,
      atMs: 210,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }), prepared.broker);

    expect(takeover).toMatchObject({ status: "revocation_pending", acknowledgementDeadlineMs: 260, terminationDeadlineMs: 360 });
    computerUseTestHarness.setTrustedNow(prepared.broker, 220);
    expect(revalidateBeforeExecution(decision, prepared.intent, { ...prepared.context, nowMs: 220, takeover }, prepared.broker)).toEqual({
      allowed: false,
      reason: "approval-revoked",
    });

    computerUseTestHarness.setTrustedNow(prepared.broker, 250);
    const acknowledged = applyTakeoverEvent(takeover, computerUseTestHarness.createTakeoverWorkerEvent(prepared.broker, {
      type: "worker_ack",
      takeoverId: "takeover-1",
      workerId: prepared.authority.workerId,
      acknowledgementId: "ack-1",
      atMs: 250,
    }), prepared.broker);
    expect(acknowledged).toMatchObject({ status: "acknowledged", acknowledgementId: "ack-1" });
  });

  it("escalates a missed acknowledgement to termination and fails closed if termination is unconfirmed", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding, 100);
    const pending = applyTakeoverEvent(createTakeoverState(), computerUseTestHarness.createTakeoverEvent(broker, {
      type: "takeover",
      takeoverId: "takeover-timeout",
      workerId: binding.workerId,
      atMs: 100,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }), broker);
    computerUseTestHarness.setTrustedNow(broker, 150);
    const terminationRequired = applyTakeoverEvent(pending, computerUseTestHarness.createTakeoverEvent(broker, { type: "timeout", atMs: 150 }), broker);
    expect(terminationRequired).toMatchObject({ status: "termination_required", terminationDeadlineMs: 250 });
    computerUseTestHarness.setTrustedNow(broker, 250);
    const unconfirmed = applyTakeoverEvent(terminationRequired, computerUseTestHarness.createTakeoverEvent(broker, { type: "timeout", atMs: 250 }), broker);
    expect(unconfirmed).toMatchObject({ status: "termination_unconfirmed", atMs: 250 });
  });

  it("accepts a bound termination acknowledgement before its deadline", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding, 100);
    const pending = applyTakeoverEvent(createTakeoverState(), computerUseTestHarness.createTakeoverEvent(broker, {
      type: "takeover",
      takeoverId: "takeover-terminated",
      workerId: binding.workerId,
      atMs: 100,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }), broker);
    computerUseTestHarness.setTrustedNow(broker, 150);
    const required = applyTakeoverEvent(pending, computerUseTestHarness.createTakeoverEvent(broker, { type: "timeout", atMs: 150 }), broker);
    computerUseTestHarness.setTrustedNow(broker, 200);
    const terminated = applyTakeoverEvent(required, computerUseTestHarness.createTakeoverWorkerEvent(broker, {
      type: "terminated",
      takeoverId: "takeover-terminated",
      workerId: binding.workerId,
      terminationId: "termination-1",
      atMs: 200,
    }), broker);
    expect(terminated).toMatchObject({ status: "terminated", terminationId: "termination-1" });
  });
});

const startedScope = () => {
  const prepared = setup((binding) => inputIntent(binding));
  const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
  if (!decision.allowed) throw new Error(`Expected allowed decision, got ${decision.reason}`);
  const started = revalidateBeforeExecution(decision, prepared.intent, prepared.context, prepared.broker);
  if (!started.allowed) throw new Error(`Expected started decision, got ${started.reason}`);
  return { ...prepared, decision, started, scope: decision.ledgerScope };
};

const ledgerRecord = (
  prepared: { readonly intent: Pick<ComputerUseIntent, "intentId" | "kind">; readonly scope: ActionLedgerRecordInput["scope"] },
  overrides: Partial<ActionLedgerRecordInput> = {},
): ActionLedgerRecordInput => ({
  actionId: "action-1",
  intentId: prepared.intent.intentId,
  kind: prepared.intent.kind,
  scope: prepared.scope,
  status: "requested",
  atMs: 100,
  ...overrides,
});

describe("tamper-evident action ledger", () => {
  it("starts at requested and preserves full authority scope and epochs through legal transitions", () => {
    const prepared = startedScope();
    let ledger = createActionLedger(prepared.broker);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared), prepared.broker);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "approved", atMs: 110 }), prepared.broker);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "leased", atMs: 120 }), prepared.broker);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "started", atMs: 130 }), prepared.broker);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "dispatched", atMs: 140 }), prepared.broker);
    ledger = recordWorkerOutcome(ledger, "action-1", computerUseTestHarness.createWorkerOutcome(prepared.broker, {
      outcome: "completed",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: prepared.decision.leaseToken.attemptId,
      workerId: prepared.authority.workerId,
      atMs: 200,
    }), prepared.broker);

    expect(ledger.integrity).toBe("healthy");
    expect(ledger.records.map(({ status }) => status)).toEqual(["requested", "approved", "leased", "started", "dispatched", "completed"]);
    expect(ledger.records[0].scope.authority).toEqual(prepared.authority);
    expect(ledger.records[0].scope).toMatchObject({
      intentId: prepared.intent.intentId,
      approvalEpoch: 1,
      freshnessEpoch: 1,
      takeoverEpoch: 0,
      foregroundEpoch: 1,
    });
    expect(ledger.records[0].scope.readinessDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledger.records[0].scope.foregroundDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledger.records[0].scope.displayDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledger.records[0].scope.takeoverDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledger.records.every(({ brokerEvidence }) => /^hmac-sha256:[0-9a-f]{64}$/.test(brokerEvidence))).toBe(true);
    expect(getActionOutcome(ledger, "action-1", prepared.broker)).toBe("completed");
  });

  it("rejects start-first, scope substitution, and a second terminal state", () => {
    const prepared = startedScope();
    const changedIntent: InputIntent = {
      ...prepared.intent,
      action: {
        type: "mouse",
        action: "double_click",
        coordinate: { monitorId: "primary", x: 10, y: 20, space: "physical" },
      },
    };
    expect(deniedReason(evaluateComputerUseIntent(changedIntent, prepared.context, prepared.broker))).toBe("approval-action-mismatch");

    const empty = createActionLedger(prepared.broker);
    expect(appendActionLedgerRecord(empty, ledgerRecord(prepared, { status: "started" }), prepared.broker)).toEqual(empty);

    let ledger = appendActionLedgerRecord(empty, ledgerRecord(prepared), prepared.broker);
    const otherScope = { ...prepared.scope, freshnessEpoch: 2 };
    expect(appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "approved", atMs: 110, scope: otherScope }), prepared.broker)).toEqual(ledger);
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "denied", atMs: 110 }), prepared.broker);
    expect(appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "completed", atMs: 120 }), prepared.broker)).toEqual(ledger);

    const withEnvelopeField = { ...ledgerRecord(prepared, { actionId: "action-extra" }), brokerEvidence: `hmac-sha256:${hex("0")}` } as ActionLedgerRecordInput;
    expect(appendActionLedgerRecord(empty, withEnvelopeField, prepared.broker)).toEqual(empty);
  });

  it("maps a dispatched timeout to outcome_unknown and requires cancellation acknowledgement", () => {
    const prepared = startedScope();
    let ledger = createActionLedger(prepared.broker);
    for (const [status, atMs] of [["requested", 100], ["approved", 110], ["leased", 120], ["started", 130], ["dispatched", 140]] as const) {
      ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status, atMs }), prepared.broker);
    }
    expect(appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "timed_out", atMs: 150 }), prepared.broker)).toEqual(ledger);
    expect(appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status: "cancelled", atMs: 150 }), prepared.broker)).toEqual(ledger);

    const cancelRequested = requestActionCancellation(ledger, "action-1", 150, 250, prepared.broker);
    const cancelled = acknowledgeActionCancellation(cancelRequested, "action-1", computerUseTestHarness.createWorkerOutcome(prepared.broker, {
      outcome: "cancelled",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: prepared.decision.leaseToken.attemptId,
      workerId: prepared.authority.workerId,
      acknowledgementId: "cancel-ack-1",
      atMs: 200,
    }), prepared.broker);
    expect(getActionOutcome(cancelled, "action-1", prepared.broker)).toBe("cancelled");

    const hostileAcknowledgement = new Proxy({}, {
      get() { throw new Error("hostile acknowledgement"); },
    });
    expect(() => acknowledgeActionCancellation(
      cancelRequested,
      "action-1",
      hostileAcknowledgement as never,
      prepared.broker,
    )).not.toThrow();
    expect(acknowledgeActionCancellation(
      cancelRequested,
      "action-1",
      hostileAcknowledgement as never,
      prepared.broker,
    )).toEqual(cancelRequested);

    const unknown = markOutcomeUnknown(ledger, "action-1", 200, prepared.broker);
    expect(getActionOutcome(unknown, "action-1", prepared.broker)).toBe("outcome_unknown");
  });

  it("turns corrupt history into a fail-closed ledger instead of resetting it to empty", () => {
    const prepared = startedScope();
    let ledger = appendActionLedgerRecord(createActionLedger(prepared.broker), ledgerRecord(prepared), prepared.broker);
    const forged = {
      ...ledger,
      records: [{ ...ledger.records[0], scope: { ...ledger.records[0].scope, policyEpoch: 99 } }],
    } as unknown as ActionLedger;
    const closed = appendActionLedgerRecord(forged, ledgerRecord(prepared, { actionId: "action-new" }), prepared.broker);

    expect(closed.integrity).toBe("corrupt");
    expect(getActionOutcome(closed, "action-new", prepared.broker)).toBe("ledger_corrupt");
    expect(appendActionLedgerRecord(closed, ledgerRecord(prepared, { actionId: "action-new" }), prepared.broker)).toEqual(closed);
  });

  it("copies and freezes caller input", () => {
    const prepared = startedScope();
    const input = ledgerRecord(prepared);
    const ledger = appendActionLedgerRecord(createActionLedger(prepared.broker), input, prepared.broker);
    (input as { actionId: string }).actionId = "mutated";
    expect(ledger.records[0].actionId).toBe("action-1");
    expect(Object.isFrozen(ledger.records[0].scope.authority)).toBe(true);
  });
});

describe("strict bounded runtime decoders", () => {
  it("rejects oversized strings, arrays, monitor counts, approval counts, and sparse arrays", () => {
    const binding = authority();
    const hugeIntent = screenshotIntent(binding, { intentId: "x".repeat(COMPUTER_USE_LIMITS.maxIdentifierBytes + 1) });
    expect(decodeComputerUseIntent(transport(hugeIntent))).toBeNull();

    const executable: ExecutableIntent = {
      kind: "executable",
      intentId: "exec-1",
      authority: binding,
      target: target(),
      executable: fileExecutable(),
      arguments: Array.from({ length: COMPUTER_USE_LIMITS.maxArguments + 1 }, () => "x"),
    };
    expect(decodeComputerUseIntent(transport(executable))).toBeNull();
    expect(decodeDisplayMetadata(transport({ ...display, monitors: Array.from({ length: COMPUTER_USE_LIMITS.maxMonitors + 1 }, (_, index) => ({ ...display.monitors[0], id: `monitor-${index}` })) }))).toBeNull();

    const sparse = new Array(2);
    sparse[1] = 1;
    expect(decodeComputerUseTarget(transport({ ...target(), control: { ...target().control, runtimeId: sparse } }))).toBeNull();
  });

  it("denies accessors, proxies, cycles, and excessive decode work without throwing", () => {
    const throwingGetter = Object.defineProperty({}, "pid", { enumerable: true, get: () => { throw new Error("getter"); } });
    const throwingProxy = new Proxy({}, { ownKeys: () => { throw new Error("proxy"); } });
    const cycle: Record<string, unknown> = {};
    cycle.process = cycle;

    for (const value of [throwingGetter, throwingProxy, cycle]) {
      expect(() => decodeComputerUseTarget(value)).not.toThrow();
      expect(decodeComputerUseTarget(value)).toBeNull();
      expect(() => decodeTakeoverState(value)).not.toThrow();
    }
  });

  it("keeps display/coordinate decoding finite, bounded, and negative-origin aware", () => {
    expect(resolveScreenCoordinate({ monitorId: "left", x: 80, y: 120, space: "logical" }, display)).toEqual({ monitorId: "left", x: -2460, y: 150 });
    expect(decodeDisplayMetadata(transport({ ...display, monitors: [{ ...display.monitors[0], dpi: Infinity }] }))).toBeNull();
    expect(decodeForegroundBinding(transport({ ...bindForeground(target().window, target().preState, 100, 500), expiresAtMs: Infinity }))).toBeNull();
  });
});

describe("native trust, target geometry, and fixed freshness", () => {
  it("does not expose production broker or readiness minting", () => {
    expect("createComputerUseBroker" in computerUseModule).toBe(false);
    expect("createSecurityReadiness" in computerUseModule).toBe(false);
  });

  it("accepts bounded JSON transport and rejects arbitrary objects without enumerating them", () => {
    let enumerations = 0;
    const hostile = new Proxy(target(), {
      ownKeys() {
        enumerations += 1;
        throw new Error("must not enumerate arbitrary transport objects");
      },
    });

    expect(decodeComputerUseTarget(transport(target()))).not.toBeNull();
    expect(decodeComputerUseTarget(hostile)).toBeNull();
    expect(enumerations).toBe(0);
  });

  it("accepts only opaque broker ledgers and bounded JSON record input without enumerating arbitrary objects", () => {
    const prepared = startedScope();
    const ledger = createActionLedger(prepared.broker);
    let enumerations = 0;
    const hostile = new Proxy({}, {
      ownKeys() {
        enumerations += 1;
        throw new Error("must not enumerate arbitrary ledger boundary objects");
      },
    });

    const rejectedLedger = appendActionLedgerRecordTransport(hostile as never, transport(ledgerRecord(prepared)), prepared.broker);
    expect(rejectedLedger.integrity).toBe("corrupt");
    expect(appendActionLedgerRecordTransport(ledger, hostile as never, prepared.broker)).toEqual(ledger);
    expect(enumerations).toBe(0);
  });

  it("binds every opaque ledger to the exact broker that created or decoded it", () => {
    const prepared = startedScope();
    const otherBroker = createComputerUseBroker(prepared.authority);
    const ledger = createActionLedger(prepared.broker);
    const serialized = transport(ledger);

    expect(getActionOutcome(ledger, "missing", prepared.broker)).toBeNull();
    expect(getActionOutcome(ledger, "missing", otherBroker)).toBe("ledger_corrupt");
    expect(getActionOutcome(serialized as never, "missing", otherBroker)).toBe("ledger_corrupt");

    const rejected = appendActionLedgerRecordTransport(
      ledger,
      transport(ledgerRecord(prepared)),
      otherBroker,
    );
    expect(rejected.integrity).toBe("corrupt");
    expect(rejected.ledgerId).not.toBe(ledger.ledgerId);
    expect(rejected.genesisEvidence).not.toBe(ledger.genesisEvidence);
    expect(ledger.records).toHaveLength(0);
  });

  it("authenticates opaque decisions before reading or enumerating caller objects", () => {
    const prepared = setup((binding) => inputIntent(binding));
    let gets = 0;
    let enumerations = 0;
    const hostile = new Proxy({}, {
      get() {
        gets += 1;
        return true;
      },
      ownKeys() {
        enumerations += 1;
        return [];
      },
    });

    expect(revalidateBeforeExecutionTransport(
      hostile as never,
      transport(prepared.intent),
      transport(prepared.context),
      prepared.broker,
    )).toEqual({ allowed: false, reason: "stale-decision" });
    expect(gets).toBe(0);
    expect(enumerations).toBe(0);

    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected allowed decision");
    const otherBroker = createComputerUseBroker(prepared.authority);
    expect(revalidateBeforeExecutionTransport(
      decision,
      transport(prepared.intent),
      transport(prepared.context),
      otherBroker,
    )).toEqual({ allowed: false, reason: "stale-decision" });
  });

  it("contains mouse input inside the exact target rectangle", () => {
    const raw = targetShape();
    const windowOnlyTarget = { process: raw.process, window: raw.window, preState: raw.preState };
    const prepared = setup((binding) => inputIntent(binding, {
      target: windowOnlyTarget,
      action: {
        type: "mouse",
        action: "click",
        coordinate: { monitorId: "primary", x: 1_000, y: 20, space: "physical" },
      },
    }));

    expect(deniedReason(evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker))).toBe("coordinate-invalid");
  });

  it("resolves an unregioned screenshot to the target window rectangle", () => {
    const raw = targetShape();
    const windowOnlyTarget = { process: raw.process, window: raw.window, preState: raw.preState };
    const prepared = setup((binding) => screenshotIntent(binding, { target: windowOnlyTarget }));
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);

    expect(decision).toMatchObject({
      allowed: true,
      targetRect: { left: 0, top: 0, right: 800, bottom: 600 },
      captureRect: { left: 0, top: 0, right: 800, bottom: 600 },
    });
  });

  it("rejects excessive approval lifetime and an over-age leased decision", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding);
    expect(() => createApprovalGrant(inputIntent(binding), {
      approvalId: "approval-too-long",
      epoch: 1,
      grantedAtMs: 100,
      expiresAtMs: 30_101,
      display,
    }, broker)).toThrow();

    const prepared = setup((scope) => inputIntent(scope));
    const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
    computerUseTestHarness.setTrustedNow(prepared.broker, 451);
    expect(revalidateBeforeExecution(
      decision,
      prepared.intent,
      { ...prepared.context, nowMs: 451 },
      prepared.broker,
    )).toEqual({ allowed: false, reason: "stale-decision" });
  });
});

const dispatchedInput = () => {
  const prepared = startedScope();
  let ledger = createActionLedger(prepared.broker);
  for (const [status, atMs] of [["requested", 100], ["approved", 110], ["leased", 120], ["started", 130], ["dispatched", 140]] as const) {
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(prepared, { status, atMs }), prepared.broker);
  }
  return { ...prepared, ledger };
};

const dispatchedScreenshot = () => {
  const prepared = setup((binding) => screenshotIntent(binding));
  const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
  if (!decision.allowed) throw new Error(`Expected allowed decision, got ${decision.reason}`);
  const started = revalidateBeforeExecution(decision, prepared.intent, prepared.context, prepared.broker);
  if (!started.allowed) throw new Error(`Expected started decision, got ${started.reason}`);
  const scoped = { ...prepared, decision, started, scope: decision.ledgerScope };
  let ledger = createActionLedger(prepared.broker);
  for (const [status, atMs] of [["requested", 100], ["approved", 110], ["leased", 120], ["started", 130], ["dispatched", 140]] as const) {
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(scoped, { status, atMs }), prepared.broker);
  }
  return { ...scoped, ledger };
};

const dispatchedClipboard = () => {
  const prepared = setup((binding) => ({
    kind: "clipboard",
    intentId: "clipboard-safe",
    authority: binding,
    target: target(),
    operation: "write",
    text: "safe text",
    dataPolicy: dataPolicy({ maxBytes: 100 }),
  } as ClipboardIntent), {
    allowlists: { ...defaultAllowlists, clipboardOperations: ["write"] },
  });
  const decision = evaluateComputerUseIntent(prepared.intent, prepared.context, prepared.broker);
  if (!decision.allowed) throw new Error(`Expected allowed decision, got ${decision.reason}`);
  const started = revalidateBeforeExecution(decision, prepared.intent, prepared.context, prepared.broker);
  if (!started.allowed) throw new Error(`Expected started decision, got ${started.reason}`);
  const scoped = { ...prepared, decision, started, scope: decision.ledgerScope };
  let ledger = createActionLedger(prepared.broker);
  for (const [status, atMs] of [["requested", 100], ["approved", 110], ["leased", 120], ["started", 130], ["dispatched", 140]] as const) {
    ledger = appendActionLedgerRecord(ledger, ledgerRecord(scoped, { status, atMs }), prepared.broker);
  }
  return { ...scoped, ledger };
};

describe("authenticated native worker outcomes", () => {
  it("does not accept plain takeover or timeout objects as broker control evidence", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding, 100);
    expect(applyTakeoverEvent(createTakeoverState(), {
      type: "takeover",
      takeoverId: "forged-takeover",
      workerId: binding.workerId,
      atMs: 100,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }, broker).status).toBe("idle");

    const pending = applyTakeoverEvent(createTakeoverState(), computerUseTestHarness.createTakeoverEvent(broker, {
      type: "takeover",
      takeoverId: "authenticated-takeover",
      workerId: binding.workerId,
      atMs: 100,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }), broker);
    computerUseTestHarness.setTrustedNow(broker, 150);
    expect(applyTakeoverEvent(pending, { type: "timeout", atMs: 150 }, broker).status).toBe("revocation_pending");
  });

  it("does not create completion or cancellation history from plain objects", () => {
    const prepared = dispatchedInput();
    expect(appendActionLedgerRecord(
      prepared.ledger,
      ledgerRecord(prepared, { status: "completed", atMs: 210 }),
      prepared.broker,
    )).toEqual(prepared.ledger);

    const forged = transport({
      outcome: "completed",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: "forged-attempt",
      workerId: prepared.authority.workerId,
      atMs: 210,
      brokerEvidence: `hmac-sha256:${hex("0")}`,
    });
    computerUseTestHarness.setTrustedNow(prepared.broker, 210);
    expect(recordWorkerOutcome(prepared.ledger, "action-1", forged, prepared.broker)).toEqual(prepared.ledger);

    const cancelRequested = requestActionCancellation(prepared.ledger, "action-1", 150, 250, prepared.broker);
    expect(acknowledgeActionCancellation(cancelRequested, "action-1", transport({
      outcome: "cancelled",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: "forged-attempt",
      workerId: prepared.authority.workerId,
      acknowledgementId: "forged-ack",
      atMs: 210,
      brokerEvidence: `hmac-sha256:${hex("0")}`,
    }) as never, prepared.broker)).toEqual(cancelRequested);
  });

  it("records completion only from exact broker-authenticated lease and attempt evidence", () => {
    const prepared = dispatchedInput();
    computerUseTestHarness.setTrustedNow(prepared.broker, 210);
    const evidence = computerUseTestHarness.createWorkerOutcome(prepared.broker, {
      outcome: "completed",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: prepared.decision.leaseToken.attemptId,
      workerId: prepared.authority.workerId,
      atMs: 210,
    });
    const completed = recordWorkerOutcome(prepared.ledger, "action-1", evidence, prepared.broker);
    expect(getActionOutcome(completed, "action-1", prepared.broker)).toBe("completed");

    const cancellation = dispatchedInput();
    const cancelRequested = requestActionCancellation(cancellation.ledger, "action-1", 150, 250, cancellation.broker);
    computerUseTestHarness.setTrustedNow(cancellation.broker, 210);
    const acknowledgement = computerUseTestHarness.createWorkerOutcome(cancellation.broker, {
      outcome: "cancelled",
      actionId: "action-1",
      leaseId: cancellation.decision.leaseToken.leaseId,
      attemptId: cancellation.decision.leaseToken.attemptId,
      workerId: cancellation.authority.workerId,
      acknowledgementId: "cancel-ack-native",
      atMs: 210,
    });
    const cancelled = acknowledgeActionCancellation(cancelRequested, "action-1", acknowledgement as never, cancellation.broker);
    expect(getActionOutcome(cancelled, "action-1", cancellation.broker)).toBe("cancelled");
  });

  it.each([
    ["screenshot", dispatchedScreenshot, (prepared: ReturnType<typeof dispatchedScreenshot>) => prepared.decision.captureRect ?? null],
    ["clipboard", dispatchedClipboard, () => null],
  ] as const)("persists exact authenticated %s post-effect evidence in terminal history", (_kind, prepare, actualRect) => {
    const prepared = prepare() as ReturnType<typeof dispatchedScreenshot> | ReturnType<typeof dispatchedClipboard>;
    computerUseTestHarness.setTrustedNow(prepared.broker, 210);
    const effect = {
      actualRect: actualRect(prepared as never),
      bytes: 9,
      category: "workspace" as const,
      redactorId: "redactor-v1",
      persistence: "ephemeral" as const,
      artifactSha256: hex("9"),
    };
    const evidence = computerUseTestHarness.createWorkerOutcome(prepared.broker, {
      outcome: "completed",
      actionId: "action-1",
      leaseId: prepared.decision.leaseToken.leaseId,
      attemptId: prepared.decision.leaseToken.attemptId,
      workerId: prepared.authority.workerId,
      atMs: 210,
      effect,
    });
    const completed = recordWorkerOutcome(prepared.ledger, "action-1", evidence, prepared.broker);
    expect(completed.records[completed.records.length - 1]).toMatchObject({
      status: "completed",
      effect,
      workerEvidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it("fails closed when authenticated capture evidence is misclassified, oversized, or unredacted", () => {
    for (const effect of [
      { actualBytes: 100, category: "secret" as const, redactorId: "redactor-v1" },
      { actualBytes: 1_000_001, category: "workspace" as const, redactorId: "redactor-v1" },
      { actualBytes: 100, category: "workspace" as const, redactorId: null },
    ]) {
      const prepared = dispatchedScreenshot();
      computerUseTestHarness.setTrustedNow(prepared.broker, 210);
      const evidence = computerUseTestHarness.createWorkerOutcome(prepared.broker, {
        outcome: "completed",
        actionId: "action-1",
        leaseId: prepared.decision.leaseToken.leaseId,
        attemptId: prepared.decision.leaseToken.attemptId,
        workerId: prepared.authority.workerId,
        atMs: 210,
        effect: {
          actualRect: prepared.decision.captureRect ?? null,
          bytes: effect.actualBytes,
          category: effect.category,
          redactorId: effect.redactorId,
          persistence: "ephemeral",
          artifactSha256: hex("9"),
        },
      });
      const closed = recordWorkerOutcome(prepared.ledger, "action-1", evidence, prepared.broker);
      expect(getActionOutcome(closed, "action-1", prepared.broker)).toBe("outcome_unknown");
    }
  });

  it("requires authenticated takeover acknowledgement and termination evidence", () => {
    const binding = authority();
    const broker = createComputerUseBroker(binding, 100);
    const pending = applyTakeoverEvent(createTakeoverState(), computerUseTestHarness.createTakeoverEvent(broker, {
      type: "takeover",
      takeoverId: "takeover-authenticated",
      workerId: binding.workerId,
      atMs: 100,
      acknowledgementTimeoutMs: 50,
      terminationTimeoutMs: 100,
    }), broker);
    const forgedAck = applyTakeoverEvent(pending, {
      type: "worker_ack",
      takeoverId: "takeover-authenticated",
      workerId: binding.workerId,
      acknowledgementId: "forged",
      atMs: 100,
      brokerEvidence: `hmac-sha256:${hex("0")}`,
    }, broker);
    expect(forgedAck.status).toBe("revocation_pending");

    computerUseTestHarness.setTrustedNow(broker, 150);
    const forgedState = {
      status: "acknowledged" as const,
      takeoverId: "takeover-authenticated",
      workerId: binding.workerId,
      acknowledgementId: "forged-state",
      atMs: 100,
      epoch: 1,
      lastEventAtMs: 100,
    };
    const required = applyTakeoverEvent(forgedState, computerUseTestHarness.createTakeoverEvent(broker, { type: "timeout", atMs: 150 }), broker);
    expect(required.status).toBe("termination_required");
    const forgedTermination = applyTakeoverEvent(required, {
      type: "terminated",
      takeoverId: "takeover-authenticated",
      workerId: binding.workerId,
      terminationId: "forged",
      atMs: 150,
      brokerEvidence: `hmac-sha256:${hex("0")}`,
    }, broker);
    expect(forgedTermination.status).toBe("termination_required");

    computerUseTestHarness.setTrustedNow(broker, 200);
    const evidence = computerUseTestHarness.createTakeoverWorkerEvent(broker, {
      type: "terminated",
      takeoverId: "takeover-authenticated",
      workerId: binding.workerId,
      terminationId: "termination-native",
      atMs: 200,
    });
    expect(applyTakeoverEvent(forgedTermination, evidence, broker)).toMatchObject({
      status: "terminated",
      terminationId: "termination-native",
    });
  });
});

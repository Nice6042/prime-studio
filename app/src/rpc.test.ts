import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rpcSurface from "./rpc";

import {
  AccountDeletionError,
  accountUsageSeriesStrict,
  accountStatuses,
  commitRemoveAccount,
  getComputerUseReadiness,
  getLayoutPreferences,
  getProviderProductSnapshot,
  listAccountsStrict,
  prepareRemoveAccount,
  schedulerProjection,
  setAppSetting,
  setLayoutPreferences,
  exportAccountUsageCsv,
  openEditorArtifact,
  saveEditorArtifact,
} from "./rpc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("account usage RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("returns a detached bounded snapshot and keeps bridge failure as failure", async () => {
    const row = { ts: 1, provider: "openai-codex", cost: 0.5, input: 10, output: 2, cacheRead: 3, cacheWrite: 0 };
    invokeMock.mockResolvedValueOnce([row]);
    const result = await accountUsageSeriesStrict("work", 30);
    expect(result).toEqual([row]);
    expect(result).not.toBe(row);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);

    const bridge = new Error("bridge unavailable");
    invokeMock.mockRejectedValueOnce(bridge);
    await expect(accountUsageSeriesStrict("work", 30)).rejects.toBe(bridge);
  });

  it.each([
    [{ ts: 1, provider: "openai-codex", cost: -1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    [{ ts: 1, provider: "openai-codex", cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, secret: "x" }],
    [{ ts: Number.MAX_SAFE_INTEGER + 1, provider: "openai-codex", cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ])("rejects malformed rows instead of projecting zero usage", async (rows) => {
    invokeMock.mockResolvedValueOnce(rows);
    await expect(accountUsageSeriesStrict("work", 7)).rejects.toThrow(/usage snapshot/i);
  });

  it("exports only bounded CSV and range data through a user-selected native save", async () => {
    invokeMock.mockResolvedValueOnce({ status: "cancelled" });
    const csv = "timestamp,provider,cost,input,output,cache_read,cache_write\r\n";

    await expect(exportAccountUsageCsv(csv, 30)).resolves.toEqual({ status: "cancelled" });
    expect(invokeMock).toHaveBeenCalledWith("export_account_usage_csv", {
      request: { csv, rangeDays: 30 },
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty("destination");
  });
});

describe("identity-bound editor RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  const artifactRef = {
    brokerId: "broker-1",
    rootSessionId: "session-1",
    artifactId: "artifact-1",
    revision: 1,
  } as const;

  it("opens by native artifact identity without renderer path authority", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "unsupported", reason: "No native reference." });
    await expect(openEditorArtifact(artifactRef)).resolves.toEqual({ kind: "unsupported", reason: "No native reference." });
    expect(invokeMock).toHaveBeenCalledWith("editor_artifact_open", {
      request: { artifactRef },
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty("path");
  });

  it("saves with exact identity and revision and preserves conflict outcomes", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "conflict", message: "changed on disk" });
    await expect(saveEditorArtifact({
      ref: artifactRef,
      expectedIdentity: `sha256:${"a".repeat(64)}`,
      expectedRevision: 1,
      content: "edited",
    })).resolves.toEqual({ kind: "conflict", message: "changed on disk" });
    expect(invokeMock).toHaveBeenCalledWith("editor_artifact_save", {
      request: {
        ref: artifactRef,
        expectedIdentity: `sha256:${"a".repeat(64)}`,
        expectedRevision: 1,
        content: "edited",
      },
    });
  });
});

const plan = {
  planId: "plan-7",
  accountLabel: "Claude work",
  targetPath: "C:\\Users\\operator\\.prime\\profiles\\claude-work",
  deleteData: true,
  expiresAtMs: 60_000,
  registryGeneration: "generation",
  targetIdentity: { volume: 4, file: 7 },
  estimate: { items: 12, bytes: 34_000, truncated: false },
  checks: {
    activeSession: false,
    sharedProfile: false,
    defaultOrMigrated: false,
    storedPathMatches: true,
    directChild: true,
    reparsePoint: false,
    dataDeletionAllowed: true,
  },
  blockers: [],
};

const providerProductSnapshot = {
  schemaVersion: 1,
  providers: [
    { providerId: "anthropic", displayName: "Claude" },
    { providerId: "openai-codex", displayName: "ChatGPT" },
  ],
  accounts: [],
  capabilities: [
    { operation: "discover_providers", admission: "available" },
    { operation: "discover_accounts", admission: "available" },
    {
      operation: "account_login",
      admission: "unavailable",
      unavailableReason: "native_authority_unavailable",
    },
    {
      operation: "discover_models",
      admission: "unavailable",
      unavailableReason: "native_authority_unavailable",
    },
    {
      operation: "start",
      admission: "unavailable",
      unavailableReason: "native_authority_unavailable",
    },
    {
      operation: "resume",
      admission: "unavailable",
      unavailableReason: "native_authority_unavailable",
    },
    {
      operation: "send",
      admission: "unavailable",
      unavailableReason: "native_authority_unavailable",
    },
  ],
};

describe("account deletion RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("does not expose the legacy unprepared removal invoke to renderer code", () => {
    expect(rpcSurface).not.toHaveProperty("removeAccount");
  });

  it("prepares an exact typed deletion plan without a safe fallback", async () => {
    invokeMock.mockResolvedValueOnce(plan);

    await expect(prepareRemoveAccount("claude-work", true)).resolves.toEqual(plan);
    expect(invokeMock).toHaveBeenCalledWith("prepare_remove_account", {
      id: "claude-work",
      deleteData: true,
    });
  });

  it("commits only the plan id and typed label", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(commitRemoveAccount("plan-7", "Claude work")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("commit_remove_account", {
      planId: "plan-7",
      typedLabel: "Claude work",
    });
  });

  it("throws a typed backend error instead of converting failure into success", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "planExpired",
      message: "deletion plan expired",
    });

    await expect(commitRemoveAccount("plan-7", "Claude work")).rejects.toMatchObject({
      name: "AccountDeletionError",
      code: "planExpired",
    });
    expect(AccountDeletionError).toBeTypeOf("function");
  });

  it("refreshes accounts without an empty-list fallback", async () => {
    const rows = [
      {
        id: "claude-work",
        label: "Claude work",
        provider: "anthropic",
        agentDir: "C:\\Users\\operator\\.prime\\profiles\\claude-work",
        createdAt: 1,
      },
    ];
    invokeMock.mockResolvedValueOnce(rows);

    await expect(listAccountsStrict()).resolves.toEqual(rows);
    expect(invokeMock).toHaveBeenCalledWith("list_accounts", {});

    const bridgeFailure = new Error("bridge unavailable");
    invokeMock.mockRejectedValueOnce(bridgeFailure);
    await expect(listAccountsStrict()).rejects.toBe(bridgeFailure);
  });
});

describe("account status polling RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  const signedIn = {
    accountId: "claude-work",
    available: true,
    status: {
      authed: true,
      expires: "4000000000000",
      provider: "anthropic",
      health: "signedIn",
      expiresInMs: 300_000_000,
    },
  } as const;

  it("requests one strict bounded batch without a safe fallback", async () => {
    const snapshot = [
      signedIn,
      { accountId: "chatgpt-work", available: false, status: null },
    ];
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(accountStatuses(["claude-work", "chatgpt-work"])).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("account_statuses", {
      ids: ["claude-work", "chatgpt-work"],
    });

    const bridgeFailure = new Error("account status bridge unavailable");
    invokeMock.mockRejectedValueOnce(bridgeFailure);
    await expect(accountStatuses(["claude-work"])).rejects.toBe(bridgeFailure);
  });

  it.each([
    [signedIn, signedIn],
    [{ ...signedIn, accountId: "unrequested" }],
    [{ ...signedIn, extra: "field" }],
    [{ ...signedIn, available: false }],
    [{ ...signedIn, status: { ...signedIn.status, health: "unknown" } }],
    [{ accountId: "claude-work", available: false, status: signedIn.status }],
  ])("rejects malformed, duplicate, or contradictory snapshots", async (...snapshot) => {
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
  });

  it.each([
    ["signed-in at the warning threshold", "signedIn", "4000000000000", 259_200_000],
    ["signed-in after expiry", "signedIn", "4000000000000", -1],
    ["expiring-soon without an expiry", "expiringSoon", null, null],
    ["expiring-soon at expiry", "expiringSoon", "4000000000000", 0],
    ["expiring-soon after expiry", "expiringSoon", "4000000000000", -1],
    ["expiring-soon outside the warning window", "expiringSoon", "4000000000000", 259_200_001],
    ["expired without an expiry", "expired", null, null],
    ["expired before expiry", "expired", "4000000000000", 1],
    ["an unsafe expiry", "signedIn", "9999999999999999", 300_000_000],
    ["an observation before the epoch", "expiringSoon", "1000", 1001],
    ["an unsafe inferred observation time", "expired", "9007199254740991", -1],
  ] as const)("rejects the impossible %s tuple", async (_name, health, expires, expiresInMs) => {
    invokeMock.mockResolvedValueOnce([{
      accountId: "claude-work",
      available: true,
      status: {
        authed: true,
        expires,
        provider: "anthropic",
        health,
        expiresInMs,
      },
    }]);

    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
  });

  it.each([
    [true, "signedIn", null, null],
    [true, "signedIn", "4000000000000", 259_200_001],
    [true, "expiringSoon", "4000000000000", 1],
    [true, "expiringSoon", "4000000000000", 259_200_000],
    [true, "expired", "4000000000000", 0],
    [true, "expired", "4000000000000", -1],
    [false, "signedOut", null, null],
  ] as const)("accepts the native %s/%s boundary tuple", async (
    authed,
    health,
    expires,
    expiresInMs,
  ) => {
    const snapshot = [{
      accountId: "claude-work",
      available: true,
      status: { authed, expires, provider: "anthropic", health, expiresInMs },
    }];
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(accountStatuses(["claude-work"])).resolves.toEqual(snapshot);
  });

  it("rejects accessors without invoking them", async () => {
    const arrayGetter = vi.fn(() => signedIn);
    const statusGetter = vi.fn(() => signedIn.status);
    const accessorRow = {
      accountId: "claude-work",
      available: true,
      get status() {
        return statusGetter();
      },
    };
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      configurable: true,
      enumerable: true,
      get: arrayGetter,
    });
    accessorArray.length = 1;

    invokeMock.mockResolvedValueOnce(accessorArray);
    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
    expect(arrayGetter).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce([accessorRow]);
    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
    expect(statusGetter).not.toHaveBeenCalled();
  });

  it("contains hostile proxy traps behind the snapshot error boundary", async () => {
    const ownKeys = vi.fn((): never => {
      throw new Error("hostile proxy sentinel");
    });
    const hostileRow = new Proxy(signedIn, { ownKeys });
    invokeMock.mockResolvedValueOnce([hostileRow]);

    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
    expect(ownKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["outer snapshot array", () => new Proxy([signedIn], {})],
    ["array row", () => [new Proxy(signedIn, {})]],
    ["row status", () => [{ ...signedIn, status: new Proxy(signedIn.status, {}) }]],
  ] as const)("rejects a transparent proxy at the %s layer", async (_name, snapshot) => {
    invokeMock.mockResolvedValueOnce(snapshot());

    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
  });

  it("rejects a split-view proxy without invoking getters on its target", async () => {
    const targetGetter = vi.fn(() => "credential material");
    const target = {
      get secret() {
        return targetGetter();
      },
    };
    const visibleStatus = signedIn.status;
    const splitStatus = new Proxy(target, {
      ownKeys: () => Reflect.ownKeys(visibleStatus),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(visibleStatus, key);
        return descriptor && { ...descriptor, configurable: true };
      },
      getPrototypeOf: () => Object.prototype,
    });
    invokeMock.mockResolvedValueOnce([{ ...signedIn, status: splitStatus }]);

    await expect(accountStatuses(["claude-work"])).rejects.toThrow(/account status snapshot/i);
    expect(targetGetter).not.toHaveBeenCalled();
  });

  it.each([
    ["outer snapshot array", () => Proxy.revocable([signedIn], {})],
    ["array row", () => Proxy.revocable(signedIn, {})],
    ["row status", () => Proxy.revocable(signedIn.status, {})],
  ] as const)("rejects a revoked proxy at the %s layer", async (layer, createProxy) => {
    const revoked = createProxy();
    revoked.revoke();
    const snapshot = layer === "outer snapshot array"
      ? revoked.proxy
      : layer === "array row"
        ? [revoked.proxy]
        : [{ ...signedIn, status: revoked.proxy }];
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(accountStatuses(["claude-work"])).rejects.toThrow();
  });

  it("rejects duplicate, noncanonical, and oversized inputs before invoking", async () => {
    const oversized = Array.from({ length: 257 }, (_, index) => `account-${index}`);

    await expect(accountStatuses(["claude-work", "claude-work"])).rejects.toThrow(
      /account status request/i,
    );
    await expect(accountStatuses(["../claude-work"])).rejects.toThrow(/account status request/i);
    await expect(accountStatuses([1 as unknown as string])).rejects.toThrow(
      /account status request/i,
    );
    await expect(accountStatuses(oversized)).rejects.toThrow(/account status request/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("settings RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("reports an authority denial without converting it to a successful null result", async () => {
    const denial = new Error("authority denied LocalConfigurationWrite");
    invokeMock.mockRejectedValueOnce(denial);

    await expect(setAppSetting("theme", "light")).rejects.toBe(denial);
    expect(invokeMock).toHaveBeenCalledWith("set_app_setting", {
      key: "theme",
      value: "light",
    });
  });

  it("strictly reads and writes versioned layout preferences", async () => {
    const layout = {
      schemaVersion: 1 as const,
      sidebarOpen: true,
      sidebarWidth: 264,
      inspectorOpen: true,
      inspectorWidth: 384,
      editorOpen: false,
      editorWidth: 400,
    };
    invokeMock.mockResolvedValueOnce(layout).mockResolvedValueOnce(layout);

    await expect(getLayoutPreferences()).resolves.toEqual(layout);
    await expect(setLayoutPreferences(layout)).resolves.toEqual(layout);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_layout_preferences", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "set_layout_preferences", { preferences: layout });
  });

  it("fails closed on malformed persisted layout but keeps a safe read default", async () => {
    invokeMock.mockResolvedValueOnce({ schemaVersion: 1, sidebarOpen: true, extra: true });
    await expect(getLayoutPreferences()).resolves.toMatchObject({ sidebarWidth: 264, inspectorWidth: 384 });

    invokeMock.mockResolvedValueOnce({ schemaVersion: 1, sidebarOpen: true, extra: true });
    await expect(setLayoutPreferences({
      schemaVersion: 1,
      sidebarOpen: true,
      sidebarWidth: 264,
      inspectorOpen: true,
      inspectorWidth: 384,
      editorOpen: false,
      editorWidth: 400,
    })).rejects.toThrow(/layout preferences/i);
  });
});

describe("computer-use readiness RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  const unavailable = {
    effectClass: "windows_computer_use",
    status: "unavailable",
    policyVersion: 3,
    authorityBound: false,
    brokerInstanceId: null,
    authorityDigest: null,
    workerStatus: "unavailable",
    effectDispatch: "unavailable",
    canDispatch: false,
  } as const;

  const admissionOnly = {
    ...unavailable,
    status: "admission_only",
    authorityBound: true,
    brokerInstanceId: "broker-instance-1",
    authorityDigest: `sha256:${"a".repeat(64)}`,
  } as const;

  it.each([unavailable, admissionOnly])(
    "projects only the native $status state through an empty read request",
    async (projection) => {
      invokeMock.mockResolvedValueOnce(projection);

      await expect(getComputerUseReadiness()).resolves.toEqual(projection);
      expect(invokeMock).toHaveBeenCalledWith("computer_use_readiness", {});
    },
  );

  it.each([
    { ...unavailable, status: "enforced" },
    { ...unavailable, canDispatch: true },
    { ...unavailable, authorityBound: true },
    { ...unavailable, brokerInstanceId: "renderer-minted" },
    { ...unavailable, effectClass: "clipboard" },
    { ...unavailable, extra: "field" },
    { ...admissionOnly, authorityDigest: `sha256:${"z".repeat(64)}` },
    { ...admissionOnly, workerStatus: "ready" },
    null,
    [],
  ])("fails malformed or effect-capable projections closed", async (hostile) => {
    invokeMock.mockResolvedValueOnce(hostile);

    await expect(getComputerUseReadiness()).resolves.toEqual(unavailable);
  });
});

describe("scheduler projection RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("reads the native projection without converting bridge failure into state", async () => {
    const projection = {
      schemaVersion: 1 as const,
      revision: 0,
      status: "planned" as const,
      dispatchAvailable: false as const,
    };
    invokeMock.mockResolvedValueOnce(projection);

    await expect(schedulerProjection()).resolves.toEqual(projection);
    expect(invokeMock).toHaveBeenCalledWith("scheduler_projection", {});

    const bridgeFailure = new Error("scheduler bridge unavailable");
    invokeMock.mockRejectedValueOnce(bridgeFailure);
    await expect(schedulerProjection()).rejects.toBe(bridgeFailure);
  });
});

describe("provider product RPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("strictly invokes and projects the native-owned snapshot", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(providerProductSnapshot));

    const projection = await getProviderProductSnapshot();
    expect(projection).toMatchObject({
      schemaVersion: 1,
      providers: providerProductSnapshot.providers,
      profiles: [],
    });
    expect(projection.capabilities).toHaveLength(7);
    expect(projection.capabilities.slice(0, 2)).toEqual([
      {
        operation: "discover_providers",
        admission: "available",
        availability: { state: "available" },
      },
      {
        operation: "discover_accounts",
        admission: "available",
        availability: { state: "available" },
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("get_provider_product_snapshot", {});
  });

  it("propagates bridge and schema failures instead of returning an empty snapshot", async () => {
    const bridgeFailure = new Error("bridge unavailable");
    invokeMock.mockRejectedValueOnce(bridgeFailure);
    await expect(getProviderProductSnapshot()).rejects.toBe(bridgeFailure);

    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        schemaVersion: 1,
        providers: [],
        accounts: [],
        capabilities: [],
      }),
    );
    await expect(getProviderProductSnapshot()).rejects.toThrow(
      /provider product snapshot/i,
    );
  });
});

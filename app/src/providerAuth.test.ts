import { describe, expect, it } from "vitest";
import {
  AUTH_MODE,
  AUTH_REASON,
  CAPABILITY_READINESS,
  CAPABILITY_REASON,
  CHATGPT_CODEX_PROVIDER_ID,
  CLAUDE_PROVIDER_ID,
  type AuthPolicy,
  type DomainResult,
  type ProviderAuthDomain,
  type ProviderProfile,
  authHealthAt,
  authenticateAccount,
  beginRefresh,
  clearAccountRateLimit,
  completeRefresh,
  createProviderAccount,
  createProviderAuthDomain,
  decodeProviderAccount,
  decodeProviderAuthDomain,
  evaluateProviderEligibility,
  failRefresh,
  issueSessionAttachmentProof,
  markAccountRateLimited,
  markAccountNotInstalled,
  observeCapability,
  revokeAccount,
  selectAccount,
  serializeProviderAuthDomain,
  verifySessionAttachment,
} from "./providerAuth";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const PROJECT_ID = "project-a";

function value<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function profile(
  profileId: string,
  providerId: string,
  authMode: ProviderProfile["authMode"] = AUTH_MODE.SUBSCRIPTION_MANAGED,
): ProviderProfile {
  return { profileId, providerId, label: profileId, authMode };
}

function policy(release: AuthPolicy["release"] = "personal"): AuthPolicy {
  return {
    release,
    adapters: {
      [CLAUDE_PROVIDER_ID]: {
        subscriptionManaged: "supported",
        apiKey: "supported",
        publicSubscription: "authorized",
      },
      [CHATGPT_CODEX_PROVIDER_ID]: {
        subscriptionManaged: "supported",
        apiKey: "supported",
        publicSubscription: "authorized",
      },
      "provider-labs": {
        subscriptionManaged: "supported",
        apiKey: "supported",
        publicSubscription: "authorized",
      },
    },
  };
}

function source(
  generation: number,
  sequence: number,
  overrides: Partial<{
    providerId: string;
    profileId: string;
    accountId: string;
  }> = {},
) {
  return {
    providerId: CLAUDE_PROVIDER_ID,
    profileId: "profile-claude",
    accountId: "account-claude",
    generation,
    sequence,
    ...overrides,
  };
}

function baseDomain(
  profiles: readonly ProviderProfile[] = [
    profile("profile-claude", CLAUDE_PROVIDER_ID),
    profile("profile-codex", CHATGPT_CODEX_PROVIDER_ID),
  ],
  capabilityReadiness: Record<string, { readiness: "ready" | "degraded" | "unavailable" | "unknown"; observedAtMs: number }> = {},
): ProviderAuthDomain {
  const profileList = profiles ?? [
    profile("profile-claude", CLAUDE_PROVIDER_ID),
    profile("profile-codex", CHATGPT_CODEX_PROVIDER_ID),
  ];
  return createProviderAuthDomain({
    profiles: profileList,
    accounts: profileList.map((entry) =>
      createProviderAccount({
        accountId: entry.profileId === "profile-claude" ? "account-claude" : entry.profileId === "profile-codex" ? "account-codex" : `account-${entry.profileId}`,
        profileId: entry.profileId,
        providerId: entry.providerId,
        label: entry.label,
        capabilities:
          entry.providerId === CLAUDE_PROVIDER_ID
            ? Object.fromEntries(
                Object.entries(capabilityReadiness).map(([capabilityId, observation]) => [
                  capabilityId,
                  { ...observation, source: source(1, 1) },
                ]),
              )
            : undefined,
      }),
    ),
  });
}

function readyDomain(
  domain = baseDomain(),
  expiresAtMs: number | null = NOW + 7 * DAY_MS,
): ProviderAuthDomain {
  return value(
    authenticateAccount(domain, "account-claude", {
      nowMs: NOW,
      expiresAtMs,
      source: source(1, 1),
    }),
  );
}

describe("provider account and auth-health domain", () => {
  it("binds proofs to the exact project session and rejects A-to-B-to-A proof revival", () => {
    let domain = value(selectAccount(readyDomain(), PROJECT_ID, "session-a", "account-claude", NOW));
    const firstProof = value(
      issueSessionAttachmentProof(domain, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW,
        policy: policy(),
      }),
    );

    domain = value(selectAccount(domain, PROJECT_ID, "session-a", "account-codex", NOW + 1));
    domain = value(selectAccount(domain, PROJECT_ID, "session-a", "account-claude", NOW + 2));

    expect(
      verifySessionAttachment(domain, firstProof, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW + 2,
        policy: policy(),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-selection-generation" } });

    const currentProof = value(
      issueSessionAttachmentProof(domain, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW + 2,
        policy: policy(),
      }),
    );
    expect(
      verifySessionAttachment(domain, currentProof, {
        projectId: "project-b",
        sessionId: "session-a",
        nowMs: NOW + 2,
        policy: policy(),
      }),
    ).toMatchObject({ ok: false, error: { code: "session-mismatch" } });
    expect(
      verifySessionAttachment(domain, currentProof, {
        projectId: PROJECT_ID,
        sessionId: "session-b",
        nowMs: NOW + 2,
        policy: policy(),
      }),
    ).toMatchObject({ ok: false, error: { code: "session-mismatch" } });
  });

  it("requires bound monotonic live evidence and distrusts persisted ready observations", () => {
    let domain = value(
      authenticateAccount(baseDomain(), "account-claude", {
        nowMs: NOW,
        expiresAtMs: NOW + 7 * DAY_MS,
        source: source(1, 1),
      }),
    );
    domain = value(
      observeCapability(domain, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.READY,
        observedAtMs: NOW,
        source: source(1, 1),
      }),
    );

    expect(
      authenticateAccount(domain, "account-claude", {
        nowMs: NOW + 1,
        expiresAtMs: NOW + 7 * DAY_MS,
        source: source(1, 2, { accountId: "account-codex" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "observation-source-mismatch" } });
    expect(
      authenticateAccount(domain, "account-claude", {
        nowMs: NOW + 1,
        expiresAtMs: NOW + 7 * DAY_MS,
        source: source(1, 1),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-observation" } });
    expect(
      observeCapability(domain, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.READY,
        observedAtMs: NOW + 1,
        source: source(1, 1),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-observation" } });
    expect(
      observeCapability(domain, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.READY,
        observedAtMs: NOW + 1,
        source: source(1, 2, { profileId: "profile-codex" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "observation-source-mismatch" } });
    expect(
      observeCapability(domain, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.UNAVAILABLE,
        observedAtMs: NOW - 1,
        source: source(1, 2),
      }),
    ).toMatchObject({ ok: false, error: { code: "non-monotonic-observation-time" } });

    expect(
      evaluateProviderEligibility(domain, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({ ok: true, value: { status: "eligible" } });

    const decoded = decodeProviderAuthDomain(JSON.parse(serializeProviderAuthDomain(domain)));
    const persisted = value(decoded);
    expect(
      evaluateProviderEligibility(persisted, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({
      ok: true,
      value: { status: "unavailable", reason: "live-reconciliation-required" },
    });

    const forgedLive = JSON.parse(serializeProviderAuthDomain(domain));
    forgedLive.accounts[0].auth.live = true;
    forgedLive.accounts[0].capabilities.tools.live = true;
    expect(decodeProviderAuthDomain(forgedLive)).toMatchObject({
      ok: false,
      error: { code: "invalid-runtime-input" },
    });

    const authReconciled = value(
      authenticateAccount(persisted, "account-claude", {
        nowMs: NOW + 1,
        expiresAtMs: NOW + 7 * DAY_MS,
        source: source(2, 0),
      }),
    );
    expect(
      evaluateProviderEligibility(authReconciled, {
        accountId: "account-claude",
        nowMs: NOW + 1,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({
      ok: true,
      value: { status: "unavailable", reason: "live-reconciliation-required" },
    });

    const fullyReconciled = value(
      observeCapability(authReconciled, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.READY,
        observedAtMs: NOW + 1,
        source: source(2, 0),
      }),
    );
    expect(
      evaluateProviderEligibility(fullyReconciled, {
        accountId: "account-claude",
        nowMs: NOW + 1,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({ ok: true, value: { status: "eligible" } });
  });

  it("requires fresh bound evidence for provider-derived auth transitions", () => {
    const domain = readyDomain();
    expect(
      revokeAccount(domain, "account-claude", {
        nowMs: NOW + 1,
        reason: AUTH_REASON.PROVIDER_REVOKED,
        source: source(1, 2, { profileId: "profile-codex" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "observation-source-mismatch" } });

    const started = value(
      beginRefresh(domain, "account-claude", { attemptId: "refresh-source", nowMs: NOW + 1 }),
    );
    expect(
      completeRefresh(started.domain, "account-claude", started.attempt, {
        nowMs: NOW + 2,
        expiresAtMs: NOW + 14 * DAY_MS,
        source: source(1, 1),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-observation" } });
  });

  it("rejects a live ready state that has no bound observation provenance", () => {
    const domain = baseDomain();
    const forgedAccount = {
      ...domain.accounts[0],
      auth: {
        ...domain.accounts[0].auth,
        status: "ready",
        authEpoch: 1,
        expiresAtMs: NOW + DAY_MS,
        updatedAtMs: NOW,
        live: true,
        source: null,
      },
    } as ProviderAuthDomain["accounts"][number];

    expect(() =>
      createProviderAuthDomain({
        profiles: domain.profiles,
        accounts: [forgedAccount, domain.accounts[1]],
      }),
    ).toThrow(/Invalid provider auth input/);
  });

  it("rejects standalone accounts whose persisted source is rebound to another identity", () => {
    const raw = JSON.parse(serializeProviderAuthDomain(readyDomain())).accounts[0];
    raw.auth.source.accountId = "account-codex";
    expect(decodeProviderAccount(raw)).toMatchObject({
      ok: false,
      error: { code: "invalid-runtime-input" },
    });
  });

  it("drops unknown credential fields and never returns or persists credential-bearing diagnostics", () => {
    const credential = "sk-live-do-not-persist";
    const account = createProviderAccount({
      accountId: "account-claude",
      profileId: "profile-claude",
      providerId: CLAUDE_PROVIDER_ID,
      label: "Claude",
    });
    const constructed = createProviderAuthDomain({
      profiles: [
        { ...profile("profile-claude", CLAUDE_PROVIDER_ID), token: credential } as ProviderProfile,
      ],
      accounts: [
        {
          ...account,
          apiKey: credential,
          auth: { ...account.auth, token: credential },
        } as typeof account,
      ],
      selectedAccounts: [
        {
          projectId: PROJECT_ID,
          sessionId: "session-a",
          accountId: "account-claude",
          profileId: "profile-claude",
          providerId: CLAUDE_PROVIDER_ID,
          selectionGeneration: 1,
          selectedAtMs: NOW,
          token: credential,
        } as unknown as ProviderAuthDomain["selectedAccounts"][number],
      ],
    });
    expect(JSON.stringify(constructed)).not.toContain(credential);

    const secretReason = revokeAccount(readyDomain(), "account-claude", {
      nowMs: NOW + 1,
      reason: credential as never,
      source: source(1, 2),
    });
    expect(secretReason).toMatchObject({ ok: false, error: { code: "invalid-transition" } });
    expect(JSON.stringify(secretReason)).not.toContain(credential);

    const secretCapabilityReason = observeCapability(baseDomain(), "account-claude", "tools", {
      readiness: CAPABILITY_READINESS.UNAVAILABLE,
      observedAtMs: NOW,
      reason: credential as never,
      source: source(1, 1),
    });
    expect(secretCapabilityReason).toMatchObject({ ok: false, error: { code: "invalid-transition" } });
    expect(JSON.stringify(secretCapabilityReason)).not.toContain(credential);

    const hostileIdentifier = authenticateAccount(baseDomain(), credential, {
      nowMs: NOW,
      expiresAtMs: NOW + DAY_MS,
      source: source(1, 1),
    });
    expect(hostileIdentifier).toMatchObject({ ok: false, error: { code: "account-not-found" } });
    expect(JSON.stringify(hostileIdentifier)).not.toContain(credential);

    const hostilePersistedReason = JSON.parse(serializeProviderAuthDomain(readyDomain()));
    hostilePersistedReason.accounts[0].auth.reason = credential;
    const decodedReason = decodeProviderAuthDomain(hostilePersistedReason);
    expect(decodedReason).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });
    expect(JSON.stringify(decodedReason)).not.toContain(credential);
  });

  it("requires an unexpired rate-limit transition and fresh bound evidence to clear it", () => {
    const limitedUntilMs = NOW + 60_000;
    const limited = value(
      markAccountRateLimited(readyDomain(), "account-claude", {
        nowMs: NOW + 1,
        rateLimitExpiresAtMs: limitedUntilMs,
        source: source(1, 2),
      }),
    );
    expect(authHealthAt(limited.accounts[0], limitedUntilMs)).toBe("rate-limited");
    expect(
      evaluateProviderEligibility(limited, {
        accountId: "account-claude",
        nowMs: limitedUntilMs,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "unavailable", reason: "rate-limited" } });

    expect(
      clearAccountRateLimit(limited, "account-claude", {
        nowMs: limitedUntilMs - 1,
        source: source(1, 3),
      }),
    ).toMatchObject({ ok: false, error: { code: "rate-limit-not-expired" } });
    expect(
      clearAccountRateLimit(limited, "account-claude", {
        nowMs: limitedUntilMs,
        source: source(1, 2),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-observation" } });
    expect(
      clearAccountRateLimit(limited, "account-claude", {
        nowMs: limitedUntilMs,
        source: source(1, 3, { providerId: CHATGPT_CODEX_PROVIDER_ID }),
      }),
    ).toMatchObject({ ok: false, error: { code: "observation-source-mismatch" } });
    expect(
      authenticateAccount(limited, "account-claude", {
        nowMs: NOW + 2,
        expiresAtMs: NOW + 7 * DAY_MS,
        source: source(1, 3),
      }),
    ).toMatchObject({ ok: false, error: { code: "rate-limit-not-expired" } });

    const cleared = value(
      clearAccountRateLimit(limited, "account-claude", {
        nowMs: limitedUntilMs,
        source: source(1, 3),
      }),
    );
    expect(authHealthAt(cleared.accounts[0], limitedUntilMs)).toBe("ready");
    expect(cleared.accounts[0].auth.rateLimitExpiresAtMs).toBeNull();
  });

  it("models Claude, ChatGPT/Codex, and an extension provider without credential material", () => {
    const domain = baseDomain([
      profile("profile-claude", CLAUDE_PROVIDER_ID),
      profile("profile-codex", CHATGPT_CODEX_PROVIDER_ID),
      profile("profile-labs", "provider-labs", AUTH_MODE.API_KEY),
    ]);

    expect(domain.profiles.map((entry) => entry.providerId)).toEqual([
      CLAUDE_PROVIDER_ID,
      CHATGPT_CODEX_PROVIDER_ID,
      "provider-labs",
    ]);
    expect(domain.accounts[0]).not.toHaveProperty("token");
    expect(domain.accounts[0]).not.toHaveProperty("password");
    expect(domain.accounts[0]).not.toHaveProperty("apiKey");
  });

  it("rejects a proof presented to another session or selected account", () => {
    const selected = value(selectAccount(readyDomain(), PROJECT_ID, "session-a", "account-claude", NOW));
    const withSecondSelection = value(
      selectAccount(selected, PROJECT_ID, "session-b", "account-codex", NOW),
    );
    const proof = value(
      issueSessionAttachmentProof(withSecondSelection, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW,
        policy: policy(),
      }),
    );

    const wrongSession = verifySessionAttachment(withSecondSelection, proof, {
      projectId: PROJECT_ID,
      sessionId: "session-b",
      nowMs: NOW,
      policy: policy(),
    });
    expect(wrongSession).toMatchObject({ ok: false, error: { code: "session-mismatch" } });

    const tamperedAccount = verifySessionAttachment(
      withSecondSelection,
      { ...proof, sessionId: "session-b" },
      { projectId: PROJECT_ID, sessionId: "session-b", nowMs: NOW, policy: policy() },
    );
    expect(tamperedAccount).toMatchObject({ ok: false, error: { code: "session-account-mismatch" } });
  });

  it("invalidates an attachment proof when the auth epoch changes", () => {
    const selected = value(selectAccount(readyDomain(), PROJECT_ID, "session-a", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW,
        policy: policy(),
      }),
    );
    const started = value(beginRefresh(selected, "account-claude", { attemptId: "refresh-a", nowMs: NOW + 1 }));
    const refreshed = value(
      completeRefresh(started.domain, "account-claude", started.attempt, {
        nowMs: NOW + 2,
        expiresAtMs: NOW + 14 * DAY_MS,
        source: source(1, 2),
      }),
    );

    const verification = verifySessionAttachment(refreshed, proof, {
      projectId: PROJECT_ID,
      sessionId: "session-a",
      nowMs: NOW + 2,
      policy: policy(),
    });
    expect(verification).toMatchObject({ ok: false, error: { code: "stale-auth-epoch" } });
  });

  it("treats the exact expiry boundary as expired and reauth-required", () => {
    const expiresAtMs = NOW + DAY_MS;
    const domain = readyDomain(baseDomain(), expiresAtMs);
    const account = domain.accounts[0];

    expect(authHealthAt(account, expiresAtMs - 1)).toBe("expiring-soon");
    expect(authHealthAt(account, expiresAtMs)).toBe("expired");
    expect(
      evaluateProviderEligibility(domain, {
        accountId: "account-claude",
        nowMs: expiresAtMs,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "reauth-required", reason: "expired" } });
  });

  it("keeps revoked credentials unusable even while their expiry is in the future", () => {
    const selected = value(selectAccount(readyDomain(), PROJECT_ID, "session-a", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW,
        policy: policy(),
      }),
    );
    const revoked = value(
      revokeAccount(selected, "account-claude", {
        nowMs: NOW + 1,
        reason: AUTH_REASON.PROVIDER_REVOKED,
        source: source(1, 2),
      }),
    );

    expect(
      evaluateProviderEligibility(revoked, {
        accountId: "account-claude",
        nowMs: NOW + 1,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "reauth-required", reason: "revoked" } });
    expect(
      verifySessionAttachment(revoked, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW + 1,
        policy: policy(),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-auth-epoch" } });
  });

  it("does not let a late refresh result win a concurrent refresh race", () => {
    const domain = readyDomain();
    const first = value(beginRefresh(domain, "account-claude", { attemptId: "refresh-a", nowMs: NOW + 1 }));
    const second = value(beginRefresh(domain, "account-claude", { attemptId: "refresh-b", nowMs: NOW + 1 }));
    const winner = value(
      completeRefresh(first.domain, "account-claude", first.attempt, {
        nowMs: NOW + 2,
        expiresAtMs: NOW + 30 * DAY_MS,
        source: source(1, 2),
      }),
    );

    const late = completeRefresh(winner, "account-claude", second.attempt, {
      nowMs: NOW + 3,
      expiresAtMs: NOW + 60 * DAY_MS,
      source: source(1, 3),
    });
    expect(late).toMatchObject({ ok: false, error: { code: "stale-refresh" } });
    expect(winner.accounts[0].auth).toMatchObject({
      status: "ready",
      expiresAtMs: NOW + 30 * DAY_MS,
    });
  });

  it("marks a public subscription profile unsupported when its adapter is not authorized", () => {
    const domain = readyDomain(
      baseDomain([profile("profile-claude", CLAUDE_PROVIDER_ID, AUTH_MODE.SUBSCRIPTION_MANAGED)]),
    );
    const publicPolicy = policy("public");
    publicPolicy.adapters[CLAUDE_PROVIDER_ID] = {
      subscriptionManaged: "unsupported",
      apiKey: "supported",
      publicSubscription: "unauthorized",
    };

    const eligibility = evaluateProviderEligibility(domain, {
      accountId: "account-claude",
      nowMs: NOW,
      policy: publicPolicy,
    });
    expect(eligibility).toMatchObject({
      ok: true,
      value: {
        status: "unsupported",
        mode: AUTH_MODE.SUBSCRIPTION_MANAGED,
        reason: "subscription-adapter-unsupported",
      },
    });
  });

  it("rejects malformed, unbounded, and unknown required capability lists without leaking ids", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const malformed: unknown[] = [
      null,
      "",
      { [Symbol.iterator]: function* () {} },
      new Array(1),
      Array.from({ length: 65 }, () => "tools"),
    ];

    for (const requiredCapabilities of malformed) {
      expect(
        evaluateProviderEligibility(domain, {
          accountId: "account-claude",
          nowMs: NOW,
          policy: policy(),
          requiredCapabilities: requiredCapabilities as never,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
    }

    const credential = "sk-live-do-not-persist";
    const unknown = evaluateProviderEligibility(domain, {
      accountId: "account-claude",
      nowMs: NOW,
      policy: policy(),
      requiredCapabilities: [credential],
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
    expect(JSON.stringify(unknown)).not.toContain(credential);
  });

  it("does not satisfy required capabilities through Object.prototype", () => {
    const liveDomain = readyDomain();
    const domain: ProviderAuthDomain = {
      ...liveDomain,
      accounts: liveDomain.accounts.map((account) =>
        account.accountId === "account-claude" ? { ...account, capabilities: {} } : account,
      ),
    };
    Object.defineProperty(Object.prototype, "tools", {
      configurable: true,
      value: { readiness: CAPABILITY_READINESS.READY, live: true },
    });
    try {
      expect(
        evaluateProviderEligibility(domain, {
          accountId: "account-claude",
          nowMs: NOW,
          policy: policy(),
          requiredCapabilities: ["tools"],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
    } finally {
      Reflect.deleteProperty(Object.prototype, "tools");
    }
  });

  it("enforces strict required capability decoding for proof issuance and verification", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-capabilities", "account-claude", NOW));

    expect(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-capabilities",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: null as never,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });

    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-capabilities",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );
    expect(
      verifySessionAttachment(selected, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-capabilities",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: { [Symbol.iterator]: function* () {} } as never,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
  });

  it.each([
    [
      "split-view",
      () =>
        new Proxy(["blocked"], {
          getOwnPropertyDescriptor(target, property) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
            return property === "0" && descriptor
              ? { ...descriptor, value: "tools" }
              : descriptor;
          },
        }),
    ],
    ["transparent", () => new Proxy(["tools"], {})],
    [
      "revoked",
      () => {
        const revocable = Proxy.revocable(["tools"], {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
  ])("rejects %s Proxy capability arrays across evaluation and proof boundaries", (_name, createProxy) => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-proxy", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-proxy",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );

    const evaluation = evaluateProviderEligibility(selected, {
      accountId: "account-claude",
      nowMs: NOW,
      policy: policy(),
      requiredCapabilities: createProxy(),
    });
    const issuance = issueSessionAttachmentProof(selected, {
      projectId: PROJECT_ID,
      sessionId: "session-proxy",
      nowMs: NOW,
      policy: policy(),
      requiredCapabilities: createProxy(),
    });
    const verification = verifySessionAttachment(selected, proof, {
      projectId: PROJECT_ID,
      sessionId: "session-proxy",
      nowMs: NOW,
      policy: policy(),
      requiredCapabilities: createProxy(),
    });

    for (const result of [evaluation, issuance, verification]) {
      expect.soft(result).toMatchObject({
        ok: false,
        error: { code: "invalid-required-capabilities", path: "requiredCapabilities" },
      });
      expect.soft(JSON.stringify(result)).not.toContain("blocked");
    }
  });

  it("rejects accessor capability arrays without sampling the hostile getter", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-accessor", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-accessor",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );
    let getterReads = 0;
    const requiredCapabilities: string[] = [];
    Object.defineProperty(requiredCapabilities, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return "tools";
      },
    });

    const results = [
      evaluateProviderEligibility(selected, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-accessor",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
      verifySessionAttachment(selected, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-accessor",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
    }
    expect(getterReads).toBe(0);
  });

  it("rejects object capability elements without sampling nested hostile getters", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-nested-getter", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-nested-getter",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );
    let getterReads = 0;
    const requiredCapabilities = [
      {
        get hostile() {
          getterReads += 1;
          return "do-not-read";
        },
      },
    ] as never;

    const results = [
      evaluateProviderEligibility(selected, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-nested-getter",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
      verifySessionAttachment(selected, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-nested-getter",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities,
      }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "invalid-required-capabilities" } });
    }
    expect(getterReads).toBe(0);
  });

  it.each([
    [
      "subclass",
      () => {
        class RequiredCapabilityArray extends Array<string> {}
        return new RequiredCapabilityArray("tools");
      },
    ],
    [
      "custom-prototype",
      () => {
        const requiredCapabilities = ["tools"];
        Object.setPrototypeOf(requiredCapabilities, Object.create(Array.prototype));
        return requiredCapabilities;
      },
    ],
  ])("rejects %s capability arrays across evaluation and proof boundaries", (_name, createArray) => {
    const domain = readyDomain(
      baseDomain(undefined, {
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-array-prototype", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-array-prototype",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );

    const results = [
      evaluateProviderEligibility(selected, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: createArray(),
      }),
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-array-prototype",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: createArray(),
      }),
      verifySessionAttachment(selected, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-array-prototype",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: createArray(),
      }),
    ];

    for (const result of results) {
      expect.soft(result).toMatchObject({
        ok: false,
        error: { code: "invalid-required-capabilities", path: "requiredCapabilities" },
      });
    }
  });

  it("downgrades capability eligibility and invalidates proofs", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        text: { readiness: "ready", observedAtMs: NOW },
        tools: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-a", "account-claude", NOW));
    const proof = value(
      issueSessionAttachmentProof(selected, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    );
    const downgraded = value(
      observeCapability(selected, "account-claude", "tools", {
        readiness: CAPABILITY_READINESS.UNAVAILABLE,
        observedAtMs: NOW + 1,
        reason: CAPABILITY_REASON.PROVIDER_UNAVAILABLE,
        source: source(1, 2),
      }),
    );

    expect(
      evaluateProviderEligibility(downgraded, {
        accountId: "account-claude",
        nowMs: NOW + 1,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({ ok: true, value: { status: "unavailable", reason: "capability-not-ready" } });
    expect(
      verifySessionAttachment(downgraded, proof, {
        projectId: PROJECT_ID,
        sessionId: "session-a",
        nowMs: NOW + 1,
        policy: policy(),
        requiredCapabilities: ["tools"],
      }),
    ).toMatchObject({ ok: false, error: { code: "stale-capability-epoch" } });
  });

  it("keeps unavailable, unsupported, and API-key modes distinct", () => {
    const unavailable = readyDomain(
      baseDomain([profile("profile-claude", CLAUDE_PROVIDER_ID, AUTH_MODE.UNAVAILABLE)]),
    );
    const unsupported = readyDomain(
      baseDomain([profile("profile-claude", CLAUDE_PROVIDER_ID, AUTH_MODE.UNSUPPORTED)]),
    );
    const apiKey = readyDomain(baseDomain([profile("profile-claude", CLAUDE_PROVIDER_ID, AUTH_MODE.API_KEY)]));

    expect(
      evaluateProviderEligibility(unavailable, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "unavailable", reason: "profile-unavailable" } });
    expect(
      evaluateProviderEligibility(unsupported, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "unsupported", reason: "profile-unsupported" } });
    expect(
      evaluateProviderEligibility(apiKey, {
        accountId: "account-claude",
        nowMs: NOW,
        policy: policy("public"),
      }),
    ).toMatchObject({ ok: true, value: { status: "eligible", mode: AUTH_MODE.API_KEY } });
  });

  it("exposes not-installed and refresh-failure health without treating either as ready", () => {
    const notInstalled = value(
      markAccountNotInstalled(readyDomain(), "account-claude", {
        nowMs: NOW + 1,
        source: source(1, 2),
      }),
    );
    expect(authHealthAt(notInstalled.accounts[0], NOW + 1)).toBe("not-installed");
    expect(
      evaluateProviderEligibility(notInstalled, {
        accountId: "account-claude",
        nowMs: NOW + 1,
        policy: policy(),
      }),
    ).toMatchObject({ ok: true, value: { status: "unavailable", reason: "auth-not-installed" } });

    const started = value(beginRefresh(readyDomain(), "account-claude", { attemptId: "refresh-fail", nowMs: NOW + 1 }));
    const reauthRequired = value(
      failRefresh(started.domain, "account-claude", started.attempt, {
        nowMs: NOW + 2,
        reason: AUTH_REASON.REFRESH_REJECTED,
        source: source(1, 2),
      }),
    );
    expect(authHealthAt(reauthRequired.accounts[0], NOW + 2)).toBe("reauth-required");
  });

  it("fails closed on unknown fields, credential-like fields, and hostile runtime values", () => {
    const raw = JSON.parse(serializeProviderAuthDomain(readyDomain()));

    expect(decodeProviderAuthDomain({ ...raw, apiKey: "do-not-store" })).toMatchObject({ ok: false });
    expect(
      decodeProviderAuthDomain({
        ...raw,
        accounts: raw.accounts.map((entry: Record<string, unknown>) => ({
          ...entry,
          auth: { ...(entry.auth as Record<string, unknown>), status: "maybe-ready" },
        })),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });
    expect(
      decodeProviderAuthDomain({
        ...raw,
        accounts: raw.accounts.map((entry: Record<string, unknown>) => ({ ...entry, token: "secret" })),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });
    expect(
      decodeProviderAuthDomain({
        ...raw,
        accounts: raw.accounts.map((entry: Record<string, unknown>) => ({
          ...entry,
          auth: { ...(entry.auth as Record<string, unknown>), authEpoch: Number.POSITIVE_INFINITY },
        })),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });
    expect(
      evaluateProviderEligibility(readyDomain(), {
        accountId: "account-claude",
        nowMs: NOW,
        policy: { release: "neither", adapters: {} } as unknown as AuthPolicy,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });
    const symbolHostile = JSON.parse(serializeProviderAuthDomain(readyDomain())) as Record<string, unknown>;
    Object.defineProperty(symbolHostile, Symbol("credential"), { value: "secret" });
    expect(decodeProviderAuthDomain(symbolHostile)).toMatchObject({ ok: false, error: { code: "invalid-runtime-input" } });

    const mismatchedRefresh = JSON.parse(serializeProviderAuthDomain(readyDomain())) as Record<string, unknown>;
    mismatchedRefresh.accounts = (mismatchedRefresh.accounts as Record<string, unknown>[]).map((entry) => {
      if (entry.accountId !== "account-claude") return entry;
      const auth = entry.auth as Record<string, unknown>;
      return {
        ...entry,
        auth: {
          ...auth,
          status: "refreshing",
          refresh: {
            accountId: "account-codex",
            attemptId: "refresh-cross-account",
            baseAuthEpoch: auth.authEpoch,
            startedAtMs: auth.updatedAtMs,
          },
        },
      };
    });
    expect(decodeProviderAuthDomain(mismatchedRefresh)).toMatchObject({
      ok: false,
      error: { code: "invalid-runtime-input" },
    });
  });

  it("serializes canonically and round-trips without credentials", () => {
    const domain = readyDomain(
      baseDomain(undefined, {
        zeta: { readiness: "unknown", observedAtMs: NOW },
        alpha: { readiness: "ready", observedAtMs: NOW },
      }),
    );
    const selected = value(selectAccount(domain, PROJECT_ID, "session-a", "account-claude", NOW));
    const encoded = serializeProviderAuthDomain(selected);
    const decoded = decodeProviderAuthDomain(JSON.parse(encoded));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.code);
    expect(serializeProviderAuthDomain(decoded.value)).toBe(encoded);
    expect(encoded).not.toMatch(/token|password|apiKey|secret|credential/i);
    expect(encoded.indexOf('"alpha"')).toBeLessThan(encoded.indexOf('"zeta"'));
    expect(JSON.parse(encoded).schemaVersion).toBe(1);
  });
});

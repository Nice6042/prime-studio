import { describe, expect, it } from "vitest";

import {
  decodeProviderProductSnapshot,
  PROVIDER_PRODUCT_LIMITS,
  projectProviderProductSnapshot,
} from "./providerProduct";

const nativeSnapshot = {
  schemaVersion: 1,
  providers: [
    { providerId: "anthropic", displayName: "Claude" },
    { providerId: "openai-codex", displayName: "ChatGPT" },
  ],
  accounts: [
    {
      accountId: "claude-work",
      providerId: "anthropic",
      displayName: "Claude work",
    },
  ],
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

const transport = (snapshot: unknown): string => JSON.stringify(snapshot);

describe("provider product snapshot projection", () => {
  it("projects native provider/account truth into the pure contract and auth domains", () => {
    const projection = projectProviderProductSnapshot(
      decodeProviderProductSnapshot(transport(nativeSnapshot)),
    );

    expect(projection).toEqual({
      schemaVersion: 1,
      providers: [
        { providerId: "anthropic", displayName: "Claude" },
        { providerId: "openai-codex", displayName: "ChatGPT" },
      ],
      profiles: [
        {
          profileId: "claude-work",
          providerId: "anthropic",
          label: "Claude work",
          authMode: "unavailable",
        },
      ],
      capabilities: [
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
        {
          operation: "account_login",
          admission: "unavailable",
          availability: {
            state: "unavailable",
            reason: "disabled_by_policy",
            message: "Native authority is unavailable.",
          },
        },
        {
          operation: "discover_models",
          admission: "unavailable",
          availability: {
            state: "unavailable",
            reason: "disabled_by_policy",
            message: "Native authority is unavailable.",
          },
        },
        {
          operation: "start",
          admission: "unavailable",
          availability: {
            state: "unavailable",
            reason: "disabled_by_policy",
            message: "Native authority is unavailable.",
          },
        },
        {
          operation: "resume",
          admission: "unavailable",
          availability: {
            state: "unavailable",
            reason: "disabled_by_policy",
            message: "Native authority is unavailable.",
          },
        },
        {
          operation: "send",
          admission: "unavailable",
          availability: {
            state: "unavailable",
            reason: "disabled_by_policy",
            message: "Native authority is unavailable.",
          },
        },
      ],
    });
  });

  it("preserves admission-only as an explicit unavailable contract capability", () => {
    const admissionOnly = structuredClone(nativeSnapshot);
    admissionOnly.capabilities[2] = {
      operation: "account_login",
      admission: "admission_only",
      unavailableReason: "native_authority_admission_only",
    };

    const projection = projectProviderProductSnapshot(
      decodeProviderProductSnapshot(transport(admissionOnly)),
    );

    expect(projection.capabilities[2]).toEqual({
      operation: "account_login",
      admission: "admission_only",
      availability: {
        state: "unavailable",
        reason: "disabled_by_policy",
        message: "Native authority is admission-only.",
      },
    });
  });

  it("accepts a native descriptor for every migrated extension-provider account", () => {
    const extended = structuredClone(nativeSnapshot);
    extended.providers.push({
      providerId: "legacy-provider",
      displayName: "legacy-provider",
    });
    extended.accounts.push({
      accountId: "extension-work",
      providerId: "legacy-provider",
      displayName: "Extension work",
    });

    const projection = projectProviderProductSnapshot(
      decodeProviderProductSnapshot(transport(extended)),
    );

    expect(projection.providers[2]).toEqual({
      providerId: "legacy-provider",
      displayName: "legacy-provider",
    });
    expect(projection.profiles[1]).toEqual({
      profileId: "extension-work",
      providerId: "legacy-provider",
      label: "Extension work",
      authMode: "unavailable",
    });
  });

  it("requires the exact native provider closure and canonical order", () => {
    const mutations: Array<(snapshot: typeof nativeSnapshot) => void> = [
      (snapshot) => {
        snapshot.accounts = [];
        snapshot.providers.shift();
      },
      (snapshot) => {
        snapshot.accounts = [];
        snapshot.providers.pop();
      },
      (snapshot) => {
        [snapshot.providers[0], snapshot.providers[1]] = [
          snapshot.providers[1],
          snapshot.providers[0],
        ];
      },
      (snapshot) => {
        snapshot.providers[0].displayName = "Renamed Claude";
      },
      (snapshot) => {
        snapshot.providers.push({
          providerId: "phantom-provider",
          displayName: "phantom-provider",
        });
      },
      (snapshot) => {
        snapshot.providers.push({
          providerId: "legacy-provider",
          displayName: "Legacy Provider",
        });
        snapshot.accounts.push({
          accountId: "legacy-work",
          providerId: "legacy-provider",
          displayName: "Legacy work",
        });
      },
      (snapshot) => {
        snapshot.providers.push(
          { providerId: "z-provider", displayName: "z-provider" },
          { providerId: "a-provider", displayName: "a-provider" },
        );
        snapshot.accounts.push(
          {
            accountId: "z-work",
            providerId: "z-provider",
            displayName: "Z work",
          },
          {
            accountId: "a-work",
            providerId: "a-provider",
            displayName: "A work",
          },
        );
      },
    ];

    for (const mutate of mutations) {
      const invalid = structuredClone(nativeSnapshot);
      mutate(invalid);
      expect(() => decodeProviderProductSnapshot(transport(invalid))).toThrow(
        "Provider product snapshot unavailable.",
      );
    }
  });

  it("never accepts discover_models as available while native implementation is absent", () => {
    const minted = structuredClone(nativeSnapshot);
    minted.capabilities[3] = {
      operation: "discover_models",
      admission: "available",
    };

    expect(() => decodeProviderProductSnapshot(transport(minted))).toThrow(
      "Provider product snapshot unavailable.",
    );
  });

  it("enforces inclusive provider and account count caps before mapping", () => {
    const providersAtCap = structuredClone(nativeSnapshot);
    const extensions = Array.from(
      { length: PROVIDER_PRODUCT_LIMITS.maxProviders - 2 },
      (_, index) => ({
        provider: {
          providerId: `provider-${index}`,
          displayName: `provider-${index}`,
        },
        account: {
          accountId: `provider-account-${index}`,
          providerId: `provider-${index}`,
          displayName: `Provider account ${index}`,
        },
      }),
    ).sort((left, right) =>
      left.provider.providerId < right.provider.providerId ? -1 : 1,
    );
    providersAtCap.providers.push(...extensions.map(({ provider }) => provider));
    providersAtCap.accounts.push(...extensions.map(({ account }) => account));
    expect(() =>
      decodeProviderProductSnapshot(transport(providersAtCap)),
    ).not.toThrow();
    providersAtCap.providers.push({
      providerId: "provider-over-cap",
      displayName: "provider-over-cap",
    });
    providersAtCap.accounts.push({
      accountId: "provider-account-over-cap",
      providerId: "provider-over-cap",
      displayName: "Provider account over cap",
    });
    expect(() =>
      decodeProviderProductSnapshot(transport(providersAtCap)),
    ).toThrow("Provider product snapshot unavailable.");

    const accountsAtCap = structuredClone(nativeSnapshot);
    accountsAtCap.accounts = Array.from(
      { length: PROVIDER_PRODUCT_LIMITS.maxAccounts },
      (_, index) => ({
        accountId: `account-${index}`,
        providerId: "anthropic",
        displayName: `Account ${index}`,
      }),
    );
    expect(() =>
      decodeProviderProductSnapshot(transport(accountsAtCap)),
    ).not.toThrow();
    accountsAtCap.accounts.push({
      accountId: "account-over-cap",
      providerId: "anthropic",
      displayName: "Account over cap",
    });
    expect(() =>
      decodeProviderProductSnapshot(transport(accountsAtCap)),
    ).toThrow("Provider product snapshot unavailable.");
  });

  it("enforces the exact bounded provider and account ID grammars", () => {
    const exactLimits = structuredClone(nativeSnapshot);
    const exactProviderId = "p".repeat(
      PROVIDER_PRODUCT_LIMITS.maxProviderIdUtf8Bytes,
    );
    exactLimits.providers.push({
      providerId: exactProviderId,
      displayName: exactProviderId,
    });
    exactLimits.accounts.push({
      accountId: "a".repeat(PROVIDER_PRODUCT_LIMITS.maxAccountIdUtf8Bytes),
      providerId: exactProviderId,
      displayName: "Account",
    });
    expect(() =>
      decodeProviderProductSnapshot(transport(exactLimits)),
    ).not.toThrow();

    for (const providerId of [
      "Uppercase",
      "extension:legacy",
      "-leading",
      "trailing-",
      "with.dot",
      "é",
      "p".repeat(PROVIDER_PRODUCT_LIMITS.maxProviderIdUtf8Bytes + 1),
    ]) {
      const invalid = structuredClone(nativeSnapshot);
      invalid.providers.push({ providerId, displayName: providerId });
      invalid.accounts.push({
        accountId: "invalid-provider-work",
        providerId,
        displayName: "Invalid provider work",
      });
      expect(() =>
        decodeProviderProductSnapshot(transport(invalid)),
      ).toThrow("Provider product snapshot unavailable.");
    }

    for (const accountId of [
      "Uppercase",
      "account:colon",
      "-leading",
      "trailing-",
      "con",
      "é",
      "a".repeat(PROVIDER_PRODUCT_LIMITS.maxAccountIdUtf8Bytes + 1),
    ]) {
      const invalid = structuredClone(nativeSnapshot);
      invalid.accounts[0].accountId = accountId;
      expect(() =>
        decodeProviderProductSnapshot(transport(invalid)),
      ).toThrow("Provider product snapshot unavailable.");
    }
  });

  it("bounds display text by UTF-8 bytes and scalars and rejects unsafe Unicode", () => {
    const exactLimits = structuredClone(nativeSnapshot);
    exactLimits.accounts[0].displayName = "é".repeat(
      PROVIDER_PRODUCT_LIMITS.maxDisplayNameScalars,
    );
    expect(() =>
      decodeProviderProductSnapshot(transport(exactLimits)),
    ).not.toThrow();

    for (const displayName of [
      `unsafe\u0000control`,
      `unsafe\u0085control`,
      `unsafe\u200Bformat`,
      `unsafe\u2028line`,
      `unsafe\u2029paragraph`,
      `unsafe\u202Ebidi`,
      `unsafe\uD800surrogate`,
      "x".repeat(PROVIDER_PRODUCT_LIMITS.maxDisplayNameScalars + 1),
      "é".repeat(PROVIDER_PRODUCT_LIMITS.maxDisplayNameScalars + 1),
    ]) {
      const invalid = structuredClone(nativeSnapshot);
      invalid.accounts[0].displayName = displayName;
      expect(() =>
        decodeProviderProductSnapshot(transport(invalid)),
      ).toThrow("Provider product snapshot unavailable.");
    }
  });

  it("rejects oversized transport and arbitrary objects without enumerating them", () => {
    let enumerations = 0;
    const hostile = new Proxy(nativeSnapshot, {
      ownKeys() {
        enumerations += 1;
        throw new Error("must not enumerate hostile IPC objects");
      },
    });

    expect(() => decodeProviderProductSnapshot(hostile)).toThrow(
      "Provider product snapshot unavailable.",
    );
    expect(enumerations).toBe(0);
    expect(() =>
      decodeProviderProductSnapshot(
        " ".repeat(PROVIDER_PRODUCT_LIMITS.maxTransportUtf8Bytes + 1),
      ),
    ).toThrow("Provider product snapshot unavailable.");
  });

  it("rejects empty, credential-bearing, incomplete, or authority-minting payloads", () => {
    expect(() =>
      decodeProviderProductSnapshot(
        transport({ ...nativeSnapshot, providers: [] }),
      ),
    ).toThrow(/provider product snapshot/i);

    expect(() =>
      decodeProviderProductSnapshot(
        transport({ ...nativeSnapshot, capabilities: [] }),
      ),
    ).toThrow(/provider product snapshot/i);

    expect(() =>
      decodeProviderProductSnapshot(
        transport({
          ...nativeSnapshot,
          accounts: [
            {
              ...nativeSnapshot.accounts[0],
              agentDir: "C:\\credential-bearing-agent-home",
            },
          ],
        }),
      ),
    ).toThrow(/provider product snapshot/i);

    const minted = structuredClone(nativeSnapshot);
    minted.capabilities[4] = { operation: "start", admission: "available" };
    expect(() => decodeProviderProductSnapshot(transport(minted))).toThrow(
      /provider product snapshot/i,
    );
  });
});

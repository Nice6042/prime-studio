import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_BROWSER_UNAVAILABLE,
  nativeBrowserAdmissionClient,
} from "./nativeClient";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("native browser admission client", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("projects the Rust-owned admission-only status without an effect surface", async () => {
    vi.mocked(invoke).mockResolvedValue({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "admission_only",
      executorReadiness: "unavailable",
      authorityGateReadiness: "unavailable",
      dispatchAvailable: false,
      reason: "native_browser_executor_unavailable",
    });

    await expect(nativeBrowserAdmissionClient.readSecurityStatus()).resolves.toEqual({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "admission_only",
      executorReadiness: "unavailable",
      authorityGateReadiness: "unavailable",
      dispatchAvailable: false,
      reason: "native_browser_executor_unavailable",
    });
    expect(invoke).toHaveBeenCalledWith("browser_security_status", {});
    expect(Object.keys(nativeBrowserAdmissionClient).sort()).toEqual([
      "checkReadOnlyIntent",
      "readSecurityStatus",
    ]);
  });

  it("fails closed when the bridge response claims dispatch or adds authority fields", async () => {
    vi.mocked(invoke).mockResolvedValue({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "admission_only",
      executorReadiness: "unavailable",
      authorityGateReadiness: "enforced",
      dispatchAvailable: true,
      reason: "native_browser_executor_unavailable",
      leaseId: "renderer-minted",
    });

    await expect(nativeBrowserAdmissionClient.readSecurityStatus()).resolves.toEqual(
      NATIVE_BROWSER_UNAVAILABLE,
    );
  });

  it.each(["inspect", "screenshot"] as const)(
    "submits the closed %s intent shape and receives no execution authority",
    async (actionType) => {
      vi.mocked(invoke).mockResolvedValue({
        contractVersion: 1,
        authority: "native",
        actionType,
        admissionReadiness: "admission_only",
        executorReadiness: "unavailable",
        authorityGateReadiness: "unavailable",
        dispatchAvailable: false,
        reason: "native_browser_executor_unavailable",
      });

      await expect(
        nativeBrowserAdmissionClient.checkReadOnlyIntent(actionType),
      ).resolves.toEqual({
        contractVersion: 1,
        authority: "native",
        actionType,
        admissionReadiness: "admission_only",
        executorReadiness: "unavailable",
        authorityGateReadiness: "unavailable",
        dispatchAvailable: false,
        reason: "native_browser_executor_unavailable",
      });
      expect(invoke).toHaveBeenCalledWith("browser_check_intent_admission", {
        request: { actionType },
      });
    },
  );

  it("reports unavailable when status IPC rejects", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("bridge unavailable"));

    await expect(nativeBrowserAdmissionClient.readSecurityStatus()).resolves.toEqual(
      NATIVE_BROWSER_UNAVAILABLE,
    );
  });

  it("returns no admission object when intent IPC rejects or is malformed", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce({
        contractVersion: 1,
        authority: "native",
        actionType: "inspect",
        admissionReadiness: "admission_only",
        executorReadiness: "unavailable",
        authorityGateReadiness: "unavailable",
        dispatchAvailable: false,
        reason: "native_browser_executor_unavailable",
        evidence: "renderer-controlled",
      });

    await expect(
      nativeBrowserAdmissionClient.checkReadOnlyIntent("inspect"),
    ).resolves.toBeNull();
    await expect(
      nativeBrowserAdmissionClient.checkReadOnlyIntent("inspect"),
    ).resolves.toBeNull();
  });
});

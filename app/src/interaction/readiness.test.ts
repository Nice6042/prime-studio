import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  readSecurityStatus: vi.fn(),
  getComputerUseReadiness: vi.fn(),
}));

vi.mock("../browser/nativeClient", () => ({
  NATIVE_BROWSER_UNAVAILABLE: {
    contractVersion: 1,
    authority: "native",
    admissionReadiness: "unavailable",
    executorReadiness: "unavailable",
    authorityGateReadiness: "unavailable",
    dispatchAvailable: false,
    reason: "native_browser_status_unavailable",
  },
  nativeBrowserAdmissionClient: { readSecurityStatus: native.readSecurityStatus },
}));
vi.mock("../rpc", () => ({ getComputerUseReadiness: native.getComputerUseReadiness }));

import { loadInteractionReadiness } from "./readiness";

describe("interaction readiness", () => {
  beforeEach(() => {
    native.readSecurityStatus.mockReset();
    native.getComputerUseReadiness.mockReset();
  });

  it("keeps browser and computer execution unavailable without verified workers", async () => {
    native.readSecurityStatus.mockResolvedValue({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "admission_only",
      executorReadiness: "unavailable",
      authorityGateReadiness: "unavailable",
      dispatchAvailable: false,
      reason: "native_browser_executor_unavailable",
    });
    native.getComputerUseReadiness.mockResolvedValue({
      effectClass: "windows_computer_use",
      status: "admission_only",
      policyVersion: 3,
      authorityBound: true,
      brokerInstanceId: "broker-1",
      authorityDigest: `sha256:${"a".repeat(64)}`,
      workerStatus: "unavailable",
      effectDispatch: "unavailable",
      canDispatch: false,
    });

    const readiness = await loadInteractionReadiness();
    expect(readiness.browserLabel).toBe("Admission only · verified worker unavailable");
    expect(readiness.computerLabel).toBe("Authority bound · verified worker unavailable");
    expect(readiness.dispatchAvailable).toBe(false);
  });

  it("degrades rejected native reads to an explicit unavailable projection", async () => {
    native.readSecurityStatus.mockRejectedValue(new Error("native unavailable"));
    native.getComputerUseReadiness.mockRejectedValue(new Error("native unavailable"));

    const readiness = await loadInteractionReadiness();
    expect(readiness.browser.reason).toBe("native_browser_status_unavailable");
    expect(readiness.computer.status).toBe("unavailable");
    expect(readiness.dispatchAvailable).toBe(false);
  });

  it("reports complete unavailability without inventing authority", async () => {
    native.readSecurityStatus.mockResolvedValue({
      contractVersion: 1,
      authority: "native",
      admissionReadiness: "unavailable",
      executorReadiness: "unavailable",
      authorityGateReadiness: "unavailable",
      dispatchAvailable: false,
      reason: "native_browser_status_unavailable",
    });
    native.getComputerUseReadiness.mockResolvedValue({
      effectClass: "windows_computer_use",
      status: "unavailable",
      policyVersion: 3,
      authorityBound: false,
      brokerInstanceId: null,
      authorityDigest: null,
      workerStatus: "unavailable",
      effectDispatch: "unavailable",
      canDispatch: false,
    });

    const readiness = await loadInteractionReadiness();
    expect(readiness.browserLabel).toMatch(/^Unavailable/);
    expect(readiness.computerLabel).toMatch(/^Unavailable/);
    expect(readiness.browser.dispatchAvailable).toBe(false);
    expect(readiness.computer.canDispatch).toBe(false);
  });
});

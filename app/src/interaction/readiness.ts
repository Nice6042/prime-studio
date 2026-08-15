import { useEffect, useState } from "react";

import {
  NATIVE_BROWSER_UNAVAILABLE,
  nativeBrowserAdmissionClient,
  type BrowserSecurityStatus,
} from "../browser/nativeClient";
import { getComputerUseReadiness, type ComputerUseReadinessProjection } from "../rpc";

export type InteractionReadinessPhase = "ready";

export type InteractionReadiness = Readonly<{
  phase: InteractionReadinessPhase;
  browser: BrowserSecurityStatus;
  computer: ComputerUseReadinessProjection;
  browserLabel: string;
  computerLabel: string;
  dispatchAvailable: false;
}>;

const COMPUTER_USE_UNAVAILABLE: ComputerUseReadinessProjection = Object.freeze({
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

const browserLabel = (browser: BrowserSecurityStatus): string =>
  browser.admissionReadiness === "admission_only"
    ? "Admission only · verified worker unavailable"
    : "Unavailable · native status unavailable";

const computerLabel = (computer: ComputerUseReadinessProjection): string =>
  computer.status === "admission_only"
    ? "Authority bound · verified worker unavailable"
    : "Unavailable · verified authority and worker required";

export function projectInteractionReadiness(
  browser: BrowserSecurityStatus,
  computer: ComputerUseReadinessProjection,
): InteractionReadiness {
  return Object.freeze({
    phase: "ready",
    browser,
    computer,
    browserLabel: browserLabel(browser),
    computerLabel: computerLabel(computer),
    dispatchAvailable: false,
  });
}

export async function loadInteractionReadiness(): Promise<InteractionReadiness> {
  const [browser, computer] = await Promise.all([
    nativeBrowserAdmissionClient.readSecurityStatus().catch(() => NATIVE_BROWSER_UNAVAILABLE),
    getComputerUseReadiness().catch(() => COMPUTER_USE_UNAVAILABLE),
  ]);
  return projectInteractionReadiness(browser, computer);
}

export function useInteractionReadiness(): InteractionReadiness | null {
  const [readiness, setReadiness] = useState<InteractionReadiness | null>(null);
  useEffect(() => {
    let active = true;
    void loadInteractionReadiness().then((value) => {
      if (active) setReadiness(value);
    });
    return () => { active = false; };
  }, []);
  return readiness;
}

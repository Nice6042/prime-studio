import { invoke } from "@tauri-apps/api/core";

export type BrowserReadOnlyIntentKind = "inspect" | "screenshot";
export type BrowserAdmissionReadiness = "admission_only" | "unavailable";
export type BrowserAuthorityGateReadiness = "unavailable" | "admission_only" | "enforced";

export type BrowserSecurityStatus = Readonly<{
  contractVersion: 1;
  authority: "native";
  admissionReadiness: BrowserAdmissionReadiness;
  executorReadiness: "unavailable";
  authorityGateReadiness: BrowserAuthorityGateReadiness;
  dispatchAvailable: false;
  reason: "native_browser_executor_unavailable" | "native_browser_status_unavailable";
}>;

export type BrowserIntentAdmission = Readonly<{
  contractVersion: 1;
  authority: "native";
  actionType: BrowserReadOnlyIntentKind;
  admissionReadiness: "admission_only";
  executorReadiness: "unavailable";
  authorityGateReadiness: BrowserAuthorityGateReadiness;
  dispatchAvailable: false;
  reason: "native_browser_executor_unavailable";
}>;

export const NATIVE_BROWSER_UNAVAILABLE: BrowserSecurityStatus = Object.freeze({
  contractVersion: 1,
  authority: "native",
  admissionReadiness: "unavailable",
  executorReadiness: "unavailable",
  authorityGateReadiness: "unavailable",
  dispatchAvailable: false,
  reason: "native_browser_status_unavailable",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function decodeSecurityStatus(value: unknown): BrowserSecurityStatus | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "authority",
      "admissionReadiness",
      "executorReadiness",
      "authorityGateReadiness",
      "dispatchAvailable",
      "reason",
    ]) ||
    value.contractVersion !== 1 ||
    value.authority !== "native" ||
    value.admissionReadiness !== "admission_only" ||
    value.executorReadiness !== "unavailable" ||
    !["unavailable", "admission_only", "enforced"].includes(
      value.authorityGateReadiness as string,
    ) ||
    value.dispatchAvailable !== false ||
    value.reason !== "native_browser_executor_unavailable"
  ) {
    return null;
  }

  return value as BrowserSecurityStatus;
}

function decodeIntentAdmission(
  value: unknown,
  requestedAction: BrowserReadOnlyIntentKind,
): BrowserIntentAdmission | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "authority",
      "actionType",
      "admissionReadiness",
      "executorReadiness",
      "authorityGateReadiness",
      "dispatchAvailable",
      "reason",
    ]) ||
    value.contractVersion !== 1 ||
    value.authority !== "native" ||
    value.actionType !== requestedAction ||
    value.admissionReadiness !== "admission_only" ||
    value.executorReadiness !== "unavailable" ||
    !["unavailable", "admission_only", "enforced"].includes(
      value.authorityGateReadiness as string,
    ) ||
    value.dispatchAvailable !== false ||
    value.reason !== "native_browser_executor_unavailable"
  ) {
    return null;
  }

  return value as BrowserIntentAdmission;
}

async function readSecurityStatus(): Promise<BrowserSecurityStatus> {
  try {
    const response: unknown = await invoke("browser_security_status", {});
    return decodeSecurityStatus(response) ?? NATIVE_BROWSER_UNAVAILABLE;
  } catch {
    return NATIVE_BROWSER_UNAVAILABLE;
  }
}

async function checkReadOnlyIntent(
  actionType: BrowserReadOnlyIntentKind,
): Promise<BrowserIntentAdmission | null> {
  try {
    const response: unknown = await invoke("browser_check_intent_admission", {
      request: { actionType },
    });
    return decodeIntentAdmission(response, actionType);
  } catch {
    return null;
  }
}

/**
 * Informational projection only. It intentionally exposes no dispatch, lease,
 * evidence, or completion method; every browser effect remains absent in Rust.
 */
export const nativeBrowserAdmissionClient = Object.freeze({
  readSecurityStatus,
  checkReadOnlyIntent,
});

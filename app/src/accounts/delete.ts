import type {
  AccountDeletionErrorCode,
  AccountRemovalEstimate,
  AccountRemovalPlan,
} from "../types";

export interface RemovalBlockerRow {
  key:
    | "activeSession"
    | "sharedProfile"
    | "defaultOrMigrated"
    | "path"
    | "reparsePoint"
    | "platform";
  label: string;
  blocked: boolean;
  detail: string;
}

const UNSAFE_ACCOUNT_LABEL_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const ESCAPED_TEXT_PREFIX = "[escaped] ";

export function isUnsafeAccountLabel(label: string): boolean {
  return UNSAFE_ACCOUNT_LABEL_CHARACTER.test(label);
}

export function visualizeUntrustedText(value: string): string {
  if (!isUnsafeAccountLabel(value) && !value.startsWith(ESCAPED_TEXT_PREFIX)) return value;

  let visible = ESCAPED_TEXT_PREFIX;
  for (const character of value) {
    if (character === "\\") {
      visible += "\\\\";
    } else if (character === "\n") {
      visible += "\\n";
    } else if (character === "\r") {
      visible += "\\r";
    } else if (character === "\t") {
      visible += "\\t";
    } else if (UNSAFE_ACCOUNT_LABEL_CHARACTER.test(character)) {
      visible += `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`;
    } else {
      visible += character;
    }
  }
  return visible;
}

export function removalBlockerRows(plan: AccountRemovalPlan): RemovalBlockerRow[] {
  const blockers = new Set(plan.blockers);
  const activeSession = plan.checks.activeSession || blockers.has("activeSession");
  const sharedProfile = plan.checks.sharedProfile || blockers.has("sharedProfile");
  const defaultOrMigrated =
    plan.checks.defaultOrMigrated || blockers.has("defaultOrMigrated");
  const unsafePath =
    !plan.checks.storedPathMatches ||
    !plan.checks.directChild ||
    blockers.has("storedPathMismatch") ||
    blockers.has("unsafeTarget");
  const reparsePoint = plan.checks.reparsePoint || blockers.has("reparsePoint");
  const rows: RemovalBlockerRow[] = [
    {
      key: "activeSession",
      label: "Active session",
      blocked: activeSession,
      detail: activeSession ? "End every session using this account." : "No active sessions.",
    },
    {
      key: "sharedProfile",
      label: "Shared profile",
      blocked: sharedProfile,
      detail: sharedProfile
        ? "Another account refers to this profile."
        : "No other account refers to this profile.",
    },
    {
      key: "defaultOrMigrated",
      label: "Default or migrated",
      blocked: defaultOrMigrated,
      detail: defaultOrMigrated
        ? "Default and migrated profiles cannot be deleted here."
        : "This is an account-owned profile.",
    },
    {
      key: "path",
      label: "Profile path",
      blocked: unsafePath,
      detail: unsafePath
        ? "The derived profile target did not pass every path check."
        : "The derived target is a verified direct child of the profiles folder.",
    },
    {
      key: "reparsePoint",
      label: "Reparse points",
      blocked: reparsePoint,
      detail: reparsePoint
        ? "A reparse point was found at or below the target."
        : "No reparse point was found at or below the target.",
    },
  ];
  if (blockers.has("unsupportedPlatform")) {
    rows.unshift({
      key: "platform",
      label: "Operating system",
      blocked: true,
      detail:
        "Profile-data removal is available only on Windows. Remove the account entry without deleting its profile data.",
    });
  }
  return rows;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${unit}`;
}

export function formatRemovalEstimate(estimate: AccountRemovalEstimate): string {
  const prefix = estimate.truncated ? "At least " : "";
  return `${prefix}${estimate.items.toLocaleString()} items / ${formatBytes(estimate.bytes)}`;
}

export function isRemovalPlanExpired(plan: AccountRemovalPlan, nowMs: number): boolean {
  return nowMs >= plan.expiresAtMs;
}

export function deletionErrorMessage(
  code: AccountDeletionErrorCode | "unknown",
): string {
  switch (code) {
    case "accountNotFound":
      return "This account is no longer available. Refresh accounts before trying again.";
    case "planNotFound":
    case "planExpired":
    case "planReplayed":
    case "planRequired":
      return "This confirmation is no longer valid. Prepare a new plan before trying again.";
    case "planBlocked":
      return "The account is no longer safe to remove. Prepare again to review the current blockers.";
    case "registryChanged":
    case "targetChanged":
    case "labelMismatch":
      return "The account changed after it was checked. Prepare again before trying again.";
    case "invalidAccountId":
    case "registryInvalid":
    case "unsafeTarget":
      return "Prime Studio refused this removal because the account target is not safe. No data was changed.";
    case "quarantineConflict":
      return "Prime Studio could not start a safe removal. Restart the app to finish recovery, then prepare again.";
    case "recoveryRequired":
      return "Prime Studio requires recovery before it can verify this account. Restart the app before changing this account.";
    case "outcomeUnknown":
      return "Prime Studio could not verify whether removal finished. Restart the app before changing this account.";
    case "cleanupPending":
      return "The account entry was removed, but profile cleanup is pending. Restart the app to finish cleanup.";
    case "io":
    case "unknown":
      return "Prime Studio could not complete the removal. Check the account list and prepare again.";
  }
}

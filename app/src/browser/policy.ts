import type {
  ActiveBrowserTakeover,
  BrowserAction,
  BrowserActionType,
  BrowserApprovalGrant,
  BrowserApprovalState,
  BrowserAuthorityEpochs,
  BrowserBinding,
  BrowserBrokerEvidence,
  BrowserCapabilityIntent,
  BrowserDecisionScope,
  BrowserDnsIdentity,
  BrowserExecutionLease,
  BrowserLeaseConsumeReason,
  BrowserLeaseConsumeResult,
  BrowserOrigin,
  BrowserOriginRule,
  BrowserPolicy,
  BrowserPolicyContext,
  BrowserPolicyDecision,
  BrowserPolicyReason,
  BrowserProfileIntent,
  BrowserTargetIdentity,
  BrowserTrustedMode,
  BrowserUploadFileCapability,
  BrowserWorkerObservation,
  PromptInjectionEvidence,
  ReusableBrowserProfile,
} from "./types";
import { sha256Digest } from "./digest";
import {
  deepFreeze,
  finiteNumber,
  nonEmptyString,
  nonNegativeSafeInteger,
  readDataArray,
  readDataObject,
} from "./strict-data";

type PlainRecord = Record<string, unknown>;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const ACTION_TYPES = new Set<BrowserActionType>([
  "navigate",
  "redirect",
  "popup",
  "frame",
  "download",
  "upload",
  "screenshot",
  "selector",
  "coordinate",
  "clipboard",
  "takeover",
]);
const TRUSTED_MODES = new Set<BrowserTrustedMode>(["untrusted", "trusted"]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;
const MAX_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 65_536;

const isString = (value: unknown): value is string => typeof value === "string";
const isBoundedString = (value: unknown, maxLength: number): value is string =>
  isString(value) && value.length <= maxLength;
const isUrlString = (value: unknown): value is string => isBoundedString(value, MAX_URL_LENGTH);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isDigest = (value: unknown): value is string => isString(value) && DIGEST_PATTERN.test(value);
const isOpaqueId = (value: unknown): value is string => isString(value) && OPAQUE_ID_PATTERN.test(value);
const isTrustMode = (value: unknown): value is BrowserTrustedMode =>
  isString(value) && TRUSTED_MODES.has(value as BrowserTrustedMode);

function optionalString(record: PlainRecord, key: string): string | undefined | null {
  if (!hasOwn(record, key)) return undefined;
  return isString(record[key]) ? record[key] : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as PlainRecord;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function decodeStringArray(value: unknown): readonly string[] | null {
  const input = readDataArray(value);
  if (!input || !input.every(isString)) return null;
  return [...input] as string[];
}

function decodeBinding(value: unknown): BrowserBinding | null {
  const record = readDataObject(value, ["accountId", "projectId"]);
  if (!record || !nonEmptyString(record.accountId) || !nonEmptyString(record.projectId)) return null;
  return { accountId: record.accountId, projectId: record.projectId };
}

function decodeTarget(value: unknown): BrowserTargetIdentity | null {
  const record = readDataObject(value, ["sessionId", "tabId", "targetId", "epoch"]);
  if (
    !record ||
    !nonEmptyString(record.sessionId) ||
    !nonEmptyString(record.tabId) ||
    !nonEmptyString(record.targetId) ||
    !nonNegativeSafeInteger(record.epoch)
  ) return null;
  return {
    sessionId: record.sessionId,
    tabId: record.tabId,
    targetId: record.targetId,
    epoch: record.epoch,
  };
}

function decodeProfile(value: unknown): BrowserProfileIntent | null {
  const record = readDataObject(value, ["profileId", "mode", "accountId", "projectId"]);
  if (
    !record ||
    !nonEmptyString(record.profileId) ||
    (record.mode !== "isolated" && record.mode !== "reused") ||
    !nonEmptyString(record.accountId) ||
    !nonEmptyString(record.projectId)
  ) return null;
  return {
    profileId: record.profileId,
    mode: record.mode,
    accountId: record.accountId,
    projectId: record.projectId,
  };
}

function decodeEpochs(record: PlainRecord): BrowserAuthorityEpochs | null {
  return nonNegativeSafeInteger(record.brokerEpoch) &&
    nonNegativeSafeInteger(record.workerEpoch) &&
    nonNegativeSafeInteger(record.readinessEpoch)
    ? {
        brokerEpoch: record.brokerEpoch,
        workerEpoch: record.workerEpoch,
        readinessEpoch: record.readinessEpoch,
      }
    : null;
}

function isCoordinateOperation(value: unknown): value is "move" | "click" | "doubleClick" | "drag" {
  return value === "move" || value === "click" || value === "doubleClick" || value === "drag";
}

function isSelectorOperation(value: unknown): value is "inspect" | "click" | "type" | "submit" {
  return value === "inspect" || value === "click" || value === "type" || value === "submit";
}

/** Closed runtime decoder for the browser worker boundary. */
export function decodeBrowserAction(input: unknown): BrowserAction | null {
  try {
    const snapshot = readDataObject(input, ["type"], [
      "url",
      "fromUrl",
      "toUrl",
      "openerUrl",
      "parentUrl",
      "filename",
      "fileCapabilityId",
      "pageUrl",
      "target",
      "redaction",
      "selector",
      "operation",
      "text",
      "x",
      "y",
      "endX",
      "endY",
      "viewport",
      "takeoverId",
      "takeoverIntentId",
      "reason",
    ]);
    if (!snapshot || !isString(snapshot.type)) return null;

    switch (snapshot.type) {
      case "navigate": {
        const record = readDataObject(snapshot, ["type", "url"]);
        return record && isUrlString(record.url) ? { type: "navigate", url: record.url } : null;
      }
      case "redirect": {
        const record = readDataObject(snapshot, ["type", "fromUrl", "toUrl"]);
        return record && isUrlString(record.fromUrl) && isUrlString(record.toUrl)
          ? { type: "redirect", fromUrl: record.fromUrl, toUrl: record.toUrl }
          : null;
      }
      case "popup": {
        const record = readDataObject(snapshot, ["type", "openerUrl", "url"]);
        return record && isUrlString(record.openerUrl) && isUrlString(record.url)
          ? { type: "popup", openerUrl: record.openerUrl, url: record.url }
          : null;
      }
      case "frame": {
        const record = readDataObject(snapshot, ["type", "parentUrl", "url"]);
        return record && isUrlString(record.parentUrl) && isUrlString(record.url)
          ? { type: "frame", parentUrl: record.parentUrl, url: record.url }
          : null;
      }
      case "download": {
        const record = readDataObject(snapshot, ["type", "url", "filename"]);
        return record && isUrlString(record.url) && isBoundedString(record.filename, 255)
          ? { type: "download", url: record.url, filename: record.filename }
          : null;
      }
      case "upload": {
        const record = readDataObject(snapshot, ["type", "url", "fileCapabilityId"]);
        return record && isUrlString(record.url) && nonEmptyString(record.fileCapabilityId)
          ? { type: "upload", url: record.url, fileCapabilityId: record.fileCapabilityId }
          : null;
      }
      case "screenshot": {
        const record = readDataObject(snapshot, ["type", "pageUrl", "target", "redaction"], ["selector"]);
        if (!record) return null;
        const selector = optionalString(record, "selector");
        if (
          !isUrlString(record.pageUrl) ||
          (record.target !== "viewport" && record.target !== "element") ||
          (record.redaction !== "none" && record.redaction !== "sensitive") ||
          selector === null
        ) return null;
        return {
          type: "screenshot",
          pageUrl: record.pageUrl,
          target: record.target,
          redaction: record.redaction,
          ...(selector === undefined ? {} : { selector }),
        };
      }
      case "selector": {
        const record = readDataObject(snapshot, ["type", "pageUrl", "selector", "operation"], ["text"]);
        if (!record) return null;
        const text = optionalString(record, "text");
        if (!isUrlString(record.pageUrl) || !isBoundedString(record.selector, 500) || !isSelectorOperation(record.operation) || text === null || (text !== undefined && text.length > MAX_TEXT_LENGTH)) return null;
        return {
          type: "selector",
          pageUrl: record.pageUrl,
          selector: record.selector,
          operation: record.operation,
          ...(text === undefined ? {} : { text }),
        };
      }
      case "coordinate": {
        const record = readDataObject(snapshot, ["type", "pageUrl", "operation", "x", "y", "viewport"], ["endX", "endY"]);
        if (!record) return null;
        const viewport = readDataObject(record.viewport, ["width", "height"]);
        if (
          !isUrlString(record.pageUrl) ||
          !isCoordinateOperation(record.operation) ||
          !finiteNumber(record.x) ||
          !finiteNumber(record.y) ||
          !viewport ||
          !finiteNumber(viewport.width) ||
          !finiteNumber(viewport.height)
        ) return null;
        if (hasOwn(record, "endX") && record.endX !== undefined && !finiteNumber(record.endX)) return null;
        if (hasOwn(record, "endY") && record.endY !== undefined && !finiteNumber(record.endY)) return null;
        return {
          type: "coordinate",
          pageUrl: record.pageUrl,
          operation: record.operation,
          x: record.x,
          y: record.y,
          viewport: { width: viewport.width, height: viewport.height },
          ...(record.endX === undefined ? {} : { endX: record.endX as number }),
          ...(record.endY === undefined ? {} : { endY: record.endY as number }),
        };
      }
      case "clipboard": {
        const record = readDataObject(snapshot, ["type", "pageUrl", "operation"], ["text"]);
        if (!record) return null;
        const text = optionalString(record, "text");
        if (!isUrlString(record.pageUrl) || (record.operation !== "read" && record.operation !== "write") || text === null || (text !== undefined && text.length > MAX_TEXT_LENGTH)) return null;
        return {
          type: "clipboard",
          pageUrl: record.pageUrl,
          operation: record.operation,
          ...(text === undefined ? {} : { text }),
        };
      }
      case "takeover": {
        if (snapshot.operation === "request") {
          const record = readDataObject(snapshot, ["type", "operation", "takeoverId", "reason"]);
          return record && nonEmptyString(record.takeoverId) && nonEmptyString(record.reason)
            ? { type: "takeover", operation: "request", takeoverId: record.takeoverId, reason: record.reason }
            : null;
        }
        const record = readDataObject(snapshot, ["type", "operation", "takeoverId", "takeoverIntentId", "reason"]);
        return record && record.operation === "release" && nonEmptyString(record.takeoverId) && nonEmptyString(record.takeoverIntentId) && nonEmptyString(record.reason)
          ? {
              type: "takeover",
              operation: "release",
              takeoverId: record.takeoverId,
              takeoverIntentId: record.takeoverIntentId,
              reason: record.reason,
            }
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Closed runtime decoder for untrusted capability-intent input. */
export function decodeBrowserCapabilityIntent(input: unknown): BrowserCapabilityIntent | null {
  try {
    const record = readDataObject(input, [
      "intentId",
      "principalId",
      "actor",
      "requestedAtMs",
      "binding",
      "profile",
      "target",
      "policyEpoch",
      "approvalEpoch",
      "action",
    ]);
    if (
      !record ||
      !nonEmptyString(record.intentId) ||
      !nonEmptyString(record.principalId) ||
      (record.actor !== "agent" && record.actor !== "user") ||
      !finiteNumber(record.requestedAtMs) ||
      !nonNegativeSafeInteger(record.policyEpoch) ||
      !nonNegativeSafeInteger(record.approvalEpoch)
    ) return null;
    const binding = decodeBinding(record.binding);
    const profile = decodeProfile(record.profile);
    const target = decodeTarget(record.target);
    const action = decodeBrowserAction(record.action);
    if (!binding || !profile || !target || !action) return null;
    return {
      intentId: record.intentId,
      principalId: record.principalId,
      actor: record.actor,
      requestedAtMs: record.requestedAtMs,
      binding,
      profile,
      target,
      policyEpoch: record.policyEpoch,
      approvalEpoch: record.approvalEpoch,
      action,
    };
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized && !normalized.includes("*") && !/[\s/\\]/.test(normalized) ? normalized : null;
}

function defaultPort(scheme: "http" | "https"): number {
  return scheme === "http" ? 80 : 443;
}

/** Normalizes an origin to its exact scheme, host, and effective port tuple. */
export function normalizeBrowserOrigin(value: unknown): BrowserOrigin | null {
  try {
    if (isUrlString(value)) {
      const url = new URL(value);
      if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
      const scheme = url.protocol === "http:" ? "http" : "https";
      const host = normalizeHost(url.hostname);
      if (!host) return null;
      const port = url.port ? Number(url.port) : defaultPort(scheme);
      return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? { scheme, host, port } : null;
    }
    const record = readDataObject(value, ["scheme", "host", "port"]);
    if (!record || (record.scheme !== "http" && record.scheme !== "https") || !isString(record.host)) return null;
    const host = normalizeHost(record.host);
    if (!host || !Number.isSafeInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) return null;
    return { scheme: record.scheme, host, port: record.port as number };
  } catch {
    return null;
  }
}

export function browserOriginKey(originInput: unknown): string | null {
  const origin = normalizeBrowserOrigin(originInput);
  return origin ? `${origin.scheme}://${origin.host}:${origin.port}` : null;
}

function canonicalHttpUrl(value: unknown): string | null {
  if (!isUrlString(value)) return null;
  try {
    const url = new URL(value);
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sameHttpUrl(left: string, right: string): boolean {
  const normalizedLeft = canonicalHttpUrl(left);
  const normalizedRight = canonicalHttpUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

/** Returns true only for exact normalized origin rules. */
export function isAllowedOrigin(urlValue: unknown, allowedOrigins: readonly BrowserOriginRule[] | undefined): boolean {
  try {
    if (!isString(urlValue)) return false;
    const rules = readDataArray(allowedOrigins);
    if (!rules) return false;
    const origin = normalizeBrowserOrigin(urlValue);
    if (!origin) return false;
    const key = browserOriginKey(origin);
    return rules.some((rule) => {
      const normalizedRule = normalizeBrowserOrigin(rule);
      return normalizedRule !== null && browserOriginKey(normalizedRule) === key;
    });
  } catch {
    return false;
  }
}

/** Compatibility spelling whose values still use exact origin matching. */
export function isAllowedDomain(urlValue: string, allowedDomains: readonly BrowserOriginRule[]): boolean {
  return isAllowedOrigin(urlValue, allowedDomains);
}

function decodeOriginRules(value: unknown): readonly BrowserOriginRule[] | undefined | null {
  if (value === undefined) return undefined;
  const input = readDataArray(value);
  if (!input) return null;
  const rules: BrowserOriginRule[] = [];
  for (const candidate of input) {
    const normalized = normalizeBrowserOrigin(candidate);
    if (!normalized) return null;
    rules.push(normalized);
  }
  return rules;
}

function decodePolicy(value: unknown): BrowserPolicy | null {
  const record = readDataObject(value, [], [
    "allowedOrigins",
    "allowedDomains",
    "allowNavigation",
    "allowRedirects",
    "allowedRedirectOrigins",
    "allowPopups",
    "allowedPopupOrigins",
    "allowFrames",
    "allowedFrameOrigins",
    "allowCrossOriginFrames",
    "allowDownloads",
    "allowedDownloadOrigins",
    "allowUploads",
    "allowedUploadOrigins",
    "maxUploadBytes",
    "allowScreenshots",
    "sensitiveOrigins",
    "requireCaptureRedaction",
    "allowSelectorActions",
    "allowCoordinateActions",
    "allowClipboard",
    "allowTakeover",
    "allowReusedProfiles",
    "reusableProfiles",
    "approvalRequiredFor",
  ]);
  if (!record) return null;

  const policy: BrowserPolicy = {};
  const booleanKeys = [
    "allowNavigation",
    "allowRedirects",
    "allowPopups",
    "allowFrames",
    "allowCrossOriginFrames",
    "allowDownloads",
    "allowUploads",
    "allowScreenshots",
    "requireCaptureRedaction",
    "allowSelectorActions",
    "allowCoordinateActions",
    "allowClipboard",
    "allowTakeover",
    "allowReusedProfiles",
  ] as const;
  for (const key of booleanKeys) {
    if (hasOwn(record, key) && typeof record[key] !== "boolean") return null;
    if (typeof record[key] === "boolean") Object.assign(policy, { [key]: record[key] });
  }

  const originKeys = [
    "allowedOrigins",
    "allowedDomains",
    "allowedRedirectOrigins",
    "allowedPopupOrigins",
    "allowedFrameOrigins",
    "allowedDownloadOrigins",
    "allowedUploadOrigins",
    "sensitiveOrigins",
  ] as const;
  for (const key of originKeys) {
    const rules = decodeOriginRules(record[key]);
    if (rules === null) return null;
    if (rules !== undefined) Object.assign(policy, { [key]: rules });
  }

  if (hasOwn(record, "maxUploadBytes")) {
    if (!finiteNumber(record.maxUploadBytes) || record.maxUploadBytes < 0) return null;
    Object.assign(policy, { maxUploadBytes: record.maxUploadBytes });
  }

  if (hasOwn(record, "approvalRequiredFor")) {
    const values = readDataArray(record.approvalRequiredFor);
    if (!values || !values.every((type) => isString(type) && ACTION_TYPES.has(type as BrowserActionType))) return null;
    Object.assign(policy, { approvalRequiredFor: values as BrowserActionType[] });
  }

  if (hasOwn(record, "reusableProfiles")) {
    const values = readDataArray(record.reusableProfiles);
    if (!values) return null;
    const profiles: ReusableBrowserProfile[] = [];
    for (const value of values) {
      const candidate = readDataObject(value, ["profileId", "binding"]);
      const binding = candidate ? decodeBinding(candidate.binding) : null;
      if (!candidate || !nonEmptyString(candidate.profileId) || !binding) return null;
      profiles.push({ profileId: candidate.profileId, binding });
    }
    Object.assign(policy, { reusableProfiles: profiles });
  }
  return policy;
}

function decodeDnsIdentity(value: unknown): BrowserDnsIdentity | null {
  const record = readDataObject(value, [
    "resolutionId",
    "host",
    "addresses",
    "resolvedAtMs",
    "expiresAtMs",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
  ]);
  if (!record || !isOpaqueId(record.resolutionId) || !isString(record.host)) return null;
  const host = normalizeHost(record.host);
  const addresses = decodeStringArray(record.addresses);
  const epochs = decodeEpochs(record);
  if (
    !host ||
    !addresses ||
    addresses.length === 0 ||
    !addresses.every((address) => nonEmptyString(address) && address.length <= 64) ||
    !finiteNumber(record.resolvedAtMs) ||
    !finiteNumber(record.expiresAtMs) ||
    record.expiresAtMs <= record.resolvedAtMs ||
    !epochs
  ) return null;
  return {
    resolutionId: record.resolutionId,
    host,
    addresses,
    resolvedAtMs: record.resolvedAtMs,
    expiresAtMs: record.expiresAtMs,
    ...epochs,
  };
}

export function decodeBrowserWorkerObservation(value: unknown): BrowserWorkerObservation | null {
  try {
    const record = readDataObject(value, [
      "observationId",
      "actionType",
      "target",
      "profile",
      "trustedMode",
      "brokerEpoch",
      "workerEpoch",
      "readinessEpoch",
      "observedAtMs",
      "documentId",
      "navigationId",
      "frameId",
      "currentUrl",
      "currentOrigin",
      "preStateDigest",
      "dns",
    ], ["parentFrameId", "requestedUrl"]);
    if (
      !record ||
      !isOpaqueId(record.observationId) ||
      !isString(record.actionType) ||
      !ACTION_TYPES.has(record.actionType as BrowserActionType) ||
      !isTrustMode(record.trustedMode) ||
      !finiteNumber(record.observedAtMs) ||
      !isOpaqueId(record.documentId) ||
      !isOpaqueId(record.navigationId) ||
      !isOpaqueId(record.frameId) ||
      !isUrlString(record.currentUrl) ||
      !isDigest(record.preStateDigest)
    ) return null;
    const parentFrameId = optionalString(record, "parentFrameId");
    const requestedUrl = optionalString(record, "requestedUrl");
    if (parentFrameId === null || requestedUrl === null || (requestedUrl !== undefined && !isUrlString(requestedUrl))) return null;
    if (parentFrameId !== undefined && !isOpaqueId(parentFrameId)) return null;
    const target = decodeTarget(record.target);
    const profile = decodeProfile(record.profile);
    const currentOrigin = normalizeBrowserOrigin(record.currentOrigin);
    const parsedCurrentOrigin = normalizeBrowserOrigin(record.currentUrl);
    const epochs = decodeEpochs(record);
    const dnsValues = readDataArray(record.dns);
    if (!target || !profile || !currentOrigin || !parsedCurrentOrigin || !epochs || !dnsValues) return null;
    if (browserOriginKey(currentOrigin) !== browserOriginKey(parsedCurrentOrigin)) return null;
    const dns: BrowserDnsIdentity[] = [];
    for (const candidate of dnsValues) {
      const decoded = decodeDnsIdentity(candidate);
      if (!decoded) return null;
      dns.push(decoded);
    }
    return {
      observationId: record.observationId,
      actionType: record.actionType as BrowserActionType,
      target,
      profile,
      trustedMode: record.trustedMode,
      observedAtMs: record.observedAtMs,
      documentId: record.documentId,
      navigationId: record.navigationId,
      frameId: record.frameId,
      ...(parentFrameId === undefined ? {} : { parentFrameId }),
      currentUrl: record.currentUrl,
      currentOrigin,
      ...(requestedUrl === undefined ? {} : { requestedUrl }),
      preStateDigest: record.preStateDigest,
      dns,
      ...epochs,
    };
  } catch {
    return null;
  }
}

function decodeBrokerEvidence(value: unknown): BrowserBrokerEvidence | null {
  const record = readDataObject(value, [
    "evidenceId",
    "decisionId",
    "leaseId",
    "intentDigest",
    "actionDigest",
    "policyDigest",
    "observationDigest",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
    "issuedAtMs",
    "expiresAtMs",
  ], ["uploadCapabilityDigest"]);
  const epochs = record ? decodeEpochs(record) : null;
  if (
    !record ||
    !isOpaqueId(record.evidenceId) ||
    !isOpaqueId(record.decisionId) ||
    !isOpaqueId(record.leaseId) ||
    !isDigest(record.intentDigest) ||
    !isDigest(record.actionDigest) ||
    !isDigest(record.policyDigest) ||
    !isDigest(record.observationDigest) ||
    (record.uploadCapabilityDigest !== undefined && !isDigest(record.uploadCapabilityDigest)) ||
    !finiteNumber(record.issuedAtMs) ||
    !finiteNumber(record.expiresAtMs) ||
    record.expiresAtMs <= record.issuedAtMs ||
    !epochs
  ) return null;
  return {
    evidenceId: record.evidenceId,
    decisionId: record.decisionId,
    leaseId: record.leaseId,
    intentDigest: record.intentDigest,
    actionDigest: record.actionDigest,
    policyDigest: record.policyDigest,
    observationDigest: record.observationDigest,
    ...(record.uploadCapabilityDigest === undefined ? {} : { uploadCapabilityDigest: record.uploadCapabilityDigest }),
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs,
    ...epochs,
  };
}

function decodeUploadCapability(value: unknown): BrowserUploadFileCapability | null {
  const record = readDataObject(value, [
    "capabilityId",
    "evidenceId",
    "principalId",
    "binding",
    "profile",
    "target",
    "filename",
    "sizeBytes",
    "contentDigest",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
    "issuedAtMs",
    "expiresAtMs",
  ]);
  const binding = record ? decodeBinding(record.binding) : null;
  const profile = record ? decodeProfile(record.profile) : null;
  const target = record ? decodeTarget(record.target) : null;
  const epochs = record ? decodeEpochs(record) : null;
  if (
    !record ||
    !isOpaqueId(record.capabilityId) ||
    !isOpaqueId(record.evidenceId) ||
    !nonEmptyString(record.principalId) ||
    !binding ||
    !profile ||
    !target ||
    !isString(record.filename) ||
    !nonNegativeSafeInteger(record.sizeBytes) ||
    !isDigest(record.contentDigest) ||
    !finiteNumber(record.issuedAtMs) ||
    !finiteNumber(record.expiresAtMs) ||
    record.expiresAtMs <= record.issuedAtMs ||
    !epochs
  ) return null;
  return {
    capabilityId: record.capabilityId,
    evidenceId: record.evidenceId,
    principalId: record.principalId,
    binding,
    profile,
    target,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
    contentDigest: record.contentDigest,
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs,
    ...epochs,
  };
}

function decodeApprovalGrant(value: unknown): BrowserApprovalGrant | null {
  const record = readDataObject(value, [
    "approvalId",
    "intentId",
    "actionDigest",
    "policyDigest",
    "observationDigest",
    "target",
    "profile",
    "trustedMode",
    "principalId",
    "binding",
    "policyEpoch",
    "approvalEpoch",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
    "issuedAtMs",
    "expiresAtMs",
  ]);
  const binding = record ? decodeBinding(record.binding) : null;
  const target = record ? decodeTarget(record.target) : null;
  const profile = record ? decodeProfile(record.profile) : null;
  const epochs = record ? decodeEpochs(record) : null;
  if (
    !record ||
    !isOpaqueId(record.approvalId) ||
    !nonEmptyString(record.intentId) ||
    !isDigest(record.actionDigest) ||
    !isDigest(record.policyDigest) ||
    !isDigest(record.observationDigest) ||
    !target ||
    !profile ||
    !isTrustMode(record.trustedMode) ||
    !nonEmptyString(record.principalId) ||
    !binding ||
    !nonNegativeSafeInteger(record.policyEpoch) ||
    !nonNegativeSafeInteger(record.approvalEpoch) ||
    !finiteNumber(record.issuedAtMs) ||
    !finiteNumber(record.expiresAtMs) ||
    record.expiresAtMs <= record.issuedAtMs ||
    !epochs
  ) return null;
  return {
    approvalId: record.approvalId,
    intentId: record.intentId,
    actionDigest: record.actionDigest,
    policyDigest: record.policyDigest,
    observationDigest: record.observationDigest,
    target,
    profile,
    trustedMode: record.trustedMode,
    principalId: record.principalId,
    binding,
    policyEpoch: record.policyEpoch,
    approvalEpoch: record.approvalEpoch,
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs,
    ...epochs,
  };
}

export function decodeBrowserDecisionScope(value: unknown): BrowserDecisionScope | null {
  const record = readDataObject(value, [
    "principalId",
    "binding",
    "profile",
    "target",
    "trustedMode",
    "policyEpoch",
    "approvalEpoch",
    "policyDigest",
    "observationDigest",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
  ]);
  const binding = record ? decodeBinding(record.binding) : null;
  const profile = record ? decodeProfile(record.profile) : null;
  const target = record ? decodeTarget(record.target) : null;
  const epochs = record ? decodeEpochs(record) : null;
  if (
    !record ||
    !nonEmptyString(record.principalId) ||
    !binding ||
    !profile ||
    !target ||
    !isTrustMode(record.trustedMode) ||
    !nonNegativeSafeInteger(record.policyEpoch) ||
    !nonNegativeSafeInteger(record.approvalEpoch) ||
    !isDigest(record.policyDigest) ||
    !isDigest(record.observationDigest) ||
    !epochs
  ) return null;
  return {
    principalId: record.principalId,
    binding,
    profile,
    target,
    trustedMode: record.trustedMode,
    policyEpoch: record.policyEpoch,
    approvalEpoch: record.approvalEpoch,
    policyDigest: record.policyDigest,
    observationDigest: record.observationDigest,
    ...epochs,
  };
}

export function decodeBrowserExecutionLease(value: unknown): BrowserExecutionLease | null {
  const record = readDataObject(value, [
    "leaseId",
    "evidenceId",
    "decisionId",
    "intentId",
    "actionDigest",
    "policyDigest",
    "observationDigest",
    "scope",
    "issuedAtMs",
    "expiresAtMs",
    "singleUse",
    "brokerEpoch",
    "workerEpoch",
    "readinessEpoch",
  ], ["approvalId", "uploadCapabilityId", "uploadCapabilityDigest", "capture"]);
  const scope = record ? decodeBrowserDecisionScope(record.scope) : null;
  const epochs = record ? decodeEpochs(record) : null;
  if (
    !record ||
    !isOpaqueId(record.leaseId) ||
    !isOpaqueId(record.evidenceId) ||
    !isOpaqueId(record.decisionId) ||
    !nonEmptyString(record.intentId) ||
    !isDigest(record.actionDigest) ||
    !isDigest(record.policyDigest) ||
    !isDigest(record.observationDigest) ||
    !scope ||
    !finiteNumber(record.issuedAtMs) ||
    !finiteNumber(record.expiresAtMs) ||
    record.expiresAtMs <= record.issuedAtMs ||
    record.singleUse !== true ||
    !epochs
  ) return null;
  const approvalId = optionalString(record, "approvalId");
  const uploadCapabilityId = optionalString(record, "uploadCapabilityId");
  const uploadCapabilityDigest = optionalString(record, "uploadCapabilityDigest");
  if (approvalId === null || uploadCapabilityId === null || uploadCapabilityDigest === null) return null;
  if (approvalId !== undefined && !isOpaqueId(approvalId)) return null;
  if (uploadCapabilityId !== undefined && !isOpaqueId(uploadCapabilityId)) return null;
  if (uploadCapabilityDigest !== undefined && !isDigest(uploadCapabilityDigest)) return null;
  if ((uploadCapabilityId === undefined) !== (uploadCapabilityDigest === undefined)) return null;
  let capture: BrowserExecutionLease["capture"];
  if (hasOwn(record, "capture")) {
    const captureRecord = readDataObject(record.capture, ["sensitiveOrigin", "redaction"]);
    if (!captureRecord || typeof captureRecord.sensitiveOrigin !== "boolean" || (captureRecord.redaction !== "none" && captureRecord.redaction !== "sensitive")) return null;
    capture = { sensitiveOrigin: captureRecord.sensitiveOrigin, redaction: captureRecord.redaction };
  }
  return {
    leaseId: record.leaseId,
    evidenceId: record.evidenceId,
    decisionId: record.decisionId,
    intentId: record.intentId,
    actionDigest: record.actionDigest,
    policyDigest: record.policyDigest,
    observationDigest: record.observationDigest,
    scope,
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs,
    singleUse: true,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(uploadCapabilityId === undefined ? {} : { uploadCapabilityId }),
    ...(uploadCapabilityDigest === undefined ? {} : { uploadCapabilityDigest }),
    ...(capture === undefined ? {} : { capture }),
    ...epochs,
  };
}

function safeApprovalState(): BrowserApprovalState {
  return deepFreeze({
    revision: 0,
    grants: [],
    consumedApprovalIds: [],
    revokedApprovalIds: [],
    activeLeases: [],
    consumedLeaseIds: [],
    consumedUploadCapabilityIds: [],
  });
}

export function decodeBrowserApprovalState(value: unknown): BrowserApprovalState | null {
  try {
    const record = readDataObject(value, [
      "revision",
      "grants",
      "consumedApprovalIds",
      "revokedApprovalIds",
      "activeLeases",
      "consumedLeaseIds",
      "consumedUploadCapabilityIds",
    ]);
    if (!record || !nonNegativeSafeInteger(record.revision)) return null;
    const grantsInput = readDataArray(record.grants);
    const activeLeasesInput = readDataArray(record.activeLeases);
    const consumedApprovalIds = decodeStringArray(record.consumedApprovalIds);
    const revokedApprovalIds = decodeStringArray(record.revokedApprovalIds);
    const consumedLeaseIds = decodeStringArray(record.consumedLeaseIds);
    const consumedUploadCapabilityIds = decodeStringArray(record.consumedUploadCapabilityIds);
    if (!grantsInput || !activeLeasesInput || !consumedApprovalIds || !revokedApprovalIds || !consumedLeaseIds || !consumedUploadCapabilityIds) return null;
    if ([consumedApprovalIds, revokedApprovalIds, consumedLeaseIds, consumedUploadCapabilityIds].some((ids) => new Set(ids).size !== ids.length)) return null;
    if (consumedApprovalIds.some((id) => revokedApprovalIds.includes(id))) return null;
    const grants: BrowserApprovalGrant[] = [];
    for (const candidate of grantsInput) {
      const grant = decodeApprovalGrant(candidate);
      if (!grant) return null;
      grants.push(grant);
    }
    const activeLeases: BrowserExecutionLease[] = [];
    for (const candidate of activeLeasesInput) {
      const lease = decodeBrowserExecutionLease(candidate);
      if (!lease || consumedLeaseIds.includes(lease.leaseId)) return null;
      activeLeases.push(lease);
    }
    if (new Set(grants.map((grant) => grant.approvalId)).size !== grants.length) return null;
    if (new Set(activeLeases.map((lease) => lease.leaseId)).size !== activeLeases.length) return null;
    return deepFreeze({
      revision: record.revision,
      grants,
      consumedApprovalIds,
      revokedApprovalIds,
      activeLeases,
      consumedLeaseIds,
      consumedUploadCapabilityIds,
    });
  } catch {
    return null;
  }
}

function decodeEvidence(value: unknown): readonly PromptInjectionEvidence[] | undefined | null {
  if (value === undefined) return undefined;
  const input = readDataArray(value);
  if (!input) return null;
  const evidence: PromptInjectionEvidence[] = [];
  for (const candidate of input) {
    const record = readDataObject(candidate, ["evidenceId", "severity", "source", "summary", "observedAtMs"]);
    if (
      !record ||
      !isOpaqueId(record.evidenceId) ||
      !["low", "medium", "high", "critical"].includes(record.severity as string) ||
      !["page", "frame", "download", "tool", "user-report"].includes(record.source as string) ||
      !isString(record.summary) ||
      !finiteNumber(record.observedAtMs)
    ) return null;
    evidence.push({
      evidenceId: record.evidenceId,
      severity: record.severity as PromptInjectionEvidence["severity"],
      source: record.source as PromptInjectionEvidence["source"],
      summary: record.summary,
      observedAtMs: record.observedAtMs,
    });
  }
  return evidence;
}

function decodeTakeover(value: unknown): ActiveBrowserTakeover | undefined | null {
  if (value === undefined) return undefined;
  const record = readDataObject(value, ["takeoverId", "intentId", "principalId", "target"]);
  const target = record ? decodeTarget(record.target) : null;
  return record && nonEmptyString(record.takeoverId) && nonEmptyString(record.intentId) && nonEmptyString(record.principalId) && target
    ? { takeoverId: record.takeoverId, intentId: record.intentId, principalId: record.principalId, target }
    : null;
}

export function decodeBrowserPolicyContext(value: unknown): BrowserPolicyContext | null {
  try {
    const record = readDataObject(value, [
      "binding",
      "principalId",
      "target",
      "policy",
      "policyEpoch",
      "approvalEpoch",
      "trustedMode",
      "nowMs",
      "brokerEpoch",
      "workerEpoch",
      "readinessEpoch",
      "brokerEvidence",
      "workerObservation",
      "approvalState",
    ], ["uploadFileCapabilities", "promptInjectionEvidence", "activeTakeover"]);
    if (
      !record ||
      !nonEmptyString(record.principalId) ||
      !nonNegativeSafeInteger(record.policyEpoch) ||
      !nonNegativeSafeInteger(record.approvalEpoch) ||
      !isTrustMode(record.trustedMode) ||
      !finiteNumber(record.nowMs)
    ) return null;
    const binding = decodeBinding(record.binding);
    const target = decodeTarget(record.target);
    const policy = decodePolicy(record.policy);
    const epochs = decodeEpochs(record);
    const brokerEvidence = decodeBrokerEvidence(record.brokerEvidence);
    const workerObservation = decodeBrowserWorkerObservation(record.workerObservation);
    const approvalState = decodeBrowserApprovalState(record.approvalState);
    const evidence = decodeEvidence(record.promptInjectionEvidence);
    const activeTakeover = decodeTakeover(record.activeTakeover);
    if (!binding || !target || !policy || !epochs || !brokerEvidence || !workerObservation || !approvalState || evidence === null || activeTakeover === null) return null;

    let uploadFileCapabilities: BrowserUploadFileCapability[] | undefined;
    if (hasOwn(record, "uploadFileCapabilities")) {
      const values = readDataArray(record.uploadFileCapabilities);
      if (!values) return null;
      uploadFileCapabilities = [];
      for (const candidate of values) {
        const decoded = decodeUploadCapability(candidate);
        if (!decoded) return null;
        uploadFileCapabilities.push(decoded);
      }
      if (new Set(uploadFileCapabilities.map((capability) => capability.capabilityId)).size !== uploadFileCapabilities.length) return null;
    }

    return deepFreeze({
      binding,
      principalId: record.principalId,
      target,
      policy,
      policyEpoch: record.policyEpoch,
      approvalEpoch: record.approvalEpoch,
      trustedMode: record.trustedMode,
      nowMs: record.nowMs,
      brokerEvidence,
      workerObservation,
      approvalState,
      ...(uploadFileCapabilities === undefined ? {} : { uploadFileCapabilities }),
      ...(evidence === undefined ? {} : { promptInjectionEvidence: evidence }),
      ...(activeTakeover === undefined ? {} : { activeTakeover }),
      ...epochs,
    });
  } catch {
    return null;
  }
}

export function browserActionDigest(actionInput: BrowserAction): string {
  try {
    const action = decodeBrowserAction(actionInput);
    return action ? sha256Digest(canonicalJson(action)) : "sha256:invalid-action";
  } catch {
    return "sha256:invalid-action";
  }
}

export function browserIntentDigest(intentInput: BrowserCapabilityIntent): string {
  try {
    const intent = decodeBrowserCapabilityIntent(intentInput);
    return intent ? sha256Digest(canonicalJson(intent)) : "sha256:invalid-intent";
  } catch {
    return "sha256:invalid-intent";
  }
}

export function browserPolicyDigest(policyInput: BrowserPolicy): string {
  try {
    const policy = decodePolicy(policyInput);
    return policy ? sha256Digest(canonicalJson(policy)) : "sha256:invalid-policy";
  } catch {
    return "sha256:invalid-policy";
  }
}

export function browserWorkerObservationDigest(observationInput: BrowserWorkerObservation): string {
  try {
    const observation = decodeBrowserWorkerObservation(observationInput);
    return observation ? sha256Digest(canonicalJson(observation)) : "sha256:invalid-observation";
  } catch {
    return "sha256:invalid-observation";
  }
}

export function browserUploadFileCapabilityDigest(capabilityInput: BrowserUploadFileCapability): string {
  try {
    const capability = decodeUploadCapability(capabilityInput);
    return capability ? sha256Digest(canonicalJson(capability)) : "sha256:invalid-upload-capability";
  } catch {
    return "sha256:invalid-upload-capability";
  }
}

export function browserDecisionScopeDigest(scopeInput: BrowserDecisionScope): string {
  try {
    const scope = decodeBrowserDecisionScope(scopeInput);
    return scope ? sha256Digest(canonicalJson(scope)) : "sha256:invalid-scope";
  } catch {
    return "sha256:invalid-scope";
  }
}

/** Browser downloads accept a Windows leaf name, never a path or stream. */
export function isSafeFilename(filename: unknown): boolean {
  if (!isString(filename)) return false;
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    filename !== filename.trim() ||
    filename === "." ||
    filename === ".." ||
    /[\\/:*?"<>|]/.test(filename) ||
    /[\u0000-\u001f\u007f]/.test(filename) ||
    /[. ]$/.test(filename)
  ) return false;
  const basename = filename.split(".", 1)[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(basename);
}

export function isValidSelector(selector: unknown): boolean {
  if (!isString(selector)) return false;
  const trimmed = selector.trim();
  return trimmed.length > 0 && trimmed.length <= 500 && trimmed === selector && !/[\u0000-\u001f\u007f]/.test(selector) && !/^(?:javascript|data):/i.test(trimmed);
}

export function isConsequentialAction(actionInput: unknown): boolean {
  const action = decodeBrowserAction(actionInput);
  if (!action) return true;
  switch (action.type) {
    case "download":
    case "upload":
    case "clipboard":
    case "takeover":
      return true;
    case "selector":
      return action.operation !== "inspect";
    case "coordinate":
      return action.operation !== "move";
    case "navigate":
    case "redirect":
    case "popup":
    case "frame":
    case "screenshot":
      return false;
  }
}

function sameBinding(left: BrowserBinding, right: BrowserBinding): boolean {
  return left.accountId === right.accountId && left.projectId === right.projectId;
}

function sameProfile(left: BrowserProfileIntent, right: BrowserProfileIntent): boolean {
  return left.profileId === right.profileId && left.mode === right.mode && sameBinding(left, right);
}

function sameStableTarget(left: BrowserTargetIdentity, right: BrowserTargetIdentity): boolean {
  return left.sessionId === right.sessionId && left.tabId === right.tabId && left.targetId === right.targetId;
}

function sameTarget(left: BrowserTargetIdentity, right: BrowserTargetIdentity): boolean {
  return sameStableTarget(left, right) && left.epoch === right.epoch;
}

function sameEpochs(left: BrowserAuthorityEpochs, right: BrowserAuthorityEpochs): boolean {
  return left.brokerEpoch === right.brokerEpoch && left.workerEpoch === right.workerEpoch && left.readinessEpoch === right.readinessEpoch;
}

function originRules(policy: BrowserPolicy): readonly BrowserOriginRule[] {
  return policy.allowedOrigins ?? policy.allowedDomains ?? [];
}

function urlReason(urlValue: string, rules: readonly BrowserOriginRule[]): BrowserPolicyReason | null {
  if (!canonicalHttpUrl(urlValue)) return "unsupported-url";
  return isAllowedOrigin(urlValue, rules) ? null : "domain-not-allowed";
}

function profileReason(intent: BrowserCapabilityIntent, context: BrowserPolicyContext): BrowserPolicyReason | null {
  if (!sameBinding(intent.profile, intent.binding)) return "profile-binding-mismatch";
  if (intent.profile.mode === "isolated") {
    const classifiedReusable = context.policy.reusableProfiles?.some(
      (candidate) => candidate.profileId === intent.profile.profileId && sameBinding(candidate.binding, context.binding),
    );
    return classifiedReusable ? "isolated-profile-reuse" : null;
  }
  if (context.policy.allowReusedProfiles !== true) return "reused-profile-not-authorized";
  const reusable = context.policy.reusableProfiles?.some(
    (candidate) => candidate.profileId === intent.profile.profileId && sameBinding(candidate.binding, context.binding),
  );
  return reusable ? null : "reused-profile-not-authorized";
}

function requiredObservationUrls(action: BrowserAction, observation: BrowserWorkerObservation): readonly string[] | null {
  switch (action.type) {
    case "navigate":
      return observation.requestedUrl !== undefined && sameHttpUrl(action.url, observation.requestedUrl)
        ? [observation.currentUrl, observation.requestedUrl]
        : null;
    case "redirect":
      return observation.requestedUrl !== undefined && sameHttpUrl(action.fromUrl, observation.currentUrl) && sameHttpUrl(action.toUrl, observation.requestedUrl)
        ? [observation.currentUrl, observation.requestedUrl]
        : null;
    case "popup":
      return observation.requestedUrl !== undefined && sameHttpUrl(action.openerUrl, observation.currentUrl) && sameHttpUrl(action.url, observation.requestedUrl)
        ? [observation.currentUrl, observation.requestedUrl]
        : null;
    case "frame":
      return observation.requestedUrl !== undefined && sameHttpUrl(action.parentUrl, observation.currentUrl) && sameHttpUrl(action.url, observation.requestedUrl)
        ? [observation.currentUrl, observation.requestedUrl]
        : null;
    case "download":
    case "upload":
      return observation.requestedUrl !== undefined && sameHttpUrl(action.url, observation.requestedUrl)
        ? [observation.currentUrl, observation.requestedUrl]
        : null;
    case "screenshot":
    case "selector":
    case "coordinate":
    case "clipboard":
      return observation.requestedUrl === undefined && sameHttpUrl(action.pageUrl, observation.currentUrl)
        ? [observation.currentUrl]
        : null;
    case "takeover":
      return observation.requestedUrl === undefined ? [observation.currentUrl] : null;
  }
}

function hasUnsupportedActionUrl(action: BrowserAction): boolean {
  const values: readonly string[] = (() => {
    switch (action.type) {
      case "navigate": return [action.url];
      case "redirect": return [action.fromUrl, action.toUrl];
      case "popup": return [action.openerUrl, action.url];
      case "frame": return [action.parentUrl, action.url];
      case "download":
      case "upload": return [action.url];
      case "screenshot":
      case "selector":
      case "coordinate":
      case "clipboard": return [action.pageUrl];
      case "takeover": return [];
    }
  })();
  return values.some((value) => canonicalHttpUrl(value) === null);
}

function dnsIdentityReason(urls: readonly string[], observation: BrowserWorkerObservation, nowMs: number): BrowserPolicyReason | null {
  const hosts = new Set<string>();
  for (const value of urls) {
    try {
      const host = normalizeHost(new URL(value).hostname);
      if (!host) return "dns-identity-mismatch";
      hosts.add(host);
    } catch {
      return "dns-identity-mismatch";
    }
  }
  for (const host of hosts) {
    const resolutions = observation.dns.filter((candidate) => candidate.host === host);
    if (resolutions.length !== 1) return "dns-identity-mismatch";
    const resolution = resolutions[0] as BrowserDnsIdentity;
    if (!sameEpochs(resolution, observation) || nowMs < resolution.resolvedAtMs || nowMs >= resolution.expiresAtMs) return "dns-identity-mismatch";
  }
  return null;
}

function observationReason(intent: BrowserCapabilityIntent, context: BrowserPolicyContext): BrowserPolicyReason | null {
  const observation = context.workerObservation;
  if (observation.actionType !== intent.action.type || !sameTarget(observation.target, context.target) || !sameTarget(observation.target, intent.target)) return "worker-observation-mismatch";
  if (!sameProfile(observation.profile, intent.profile) || observation.trustedMode !== context.trustedMode) return "worker-observation-mismatch";
  if (!sameEpochs(observation, context)) return "worker-observation-mismatch";
  if (observation.observedAtMs < intent.requestedAtMs || observation.observedAtMs > context.nowMs) return "worker-observation-mismatch";
  const currentOrigin = normalizeBrowserOrigin(observation.currentUrl);
  if (!currentOrigin || browserOriginKey(currentOrigin) !== browserOriginKey(observation.currentOrigin)) return "worker-observation-mismatch";
  const urls = requiredObservationUrls(intent.action, observation);
  if (!urls) return "worker-observation-mismatch";
  return dnsIdentityReason(urls, observation, context.nowMs);
}

function authorityEpochReason(context: BrowserPolicyContext): BrowserPolicyReason | null {
  if (context.brokerEvidence.brokerEpoch !== context.brokerEpoch || context.workerObservation.brokerEpoch !== context.brokerEpoch) return "stale-broker-epoch";
  if (context.brokerEvidence.workerEpoch !== context.workerEpoch || context.workerObservation.workerEpoch !== context.workerEpoch) return "stale-worker-epoch";
  if (context.brokerEvidence.readinessEpoch !== context.readinessEpoch || context.workerObservation.readinessEpoch !== context.readinessEpoch) return "stale-readiness-epoch";
  return null;
}

function brokerEvidenceReason(
  intent: BrowserCapabilityIntent,
  context: BrowserPolicyContext,
  actionDigest: string,
  policyDigest: string,
  observationDigest: string,
  uploadCapability?: BrowserUploadFileCapability,
): BrowserPolicyReason | null {
  const evidence = context.brokerEvidence;
  if (context.nowMs < evidence.issuedAtMs || context.nowMs >= evidence.expiresAtMs || evidence.issuedAtMs < intent.requestedAtMs) return "invalid-broker-evidence";
  if (
    evidence.intentDigest !== browserIntentDigest(intent) ||
    evidence.actionDigest !== actionDigest ||
    evidence.policyDigest !== policyDigest ||
    evidence.observationDigest !== observationDigest ||
    (intent.action.type === "upload" &&
      (!uploadCapability || evidence.uploadCapabilityDigest !== browserUploadFileCapabilityDigest(uploadCapability))) ||
    (intent.action.type !== "upload" && evidence.uploadCapabilityDigest !== undefined)
  ) return "broker-evidence-mismatch";
  return null;
}

function uploadCapabilityReason(
  intent: BrowserCapabilityIntent,
  context: BrowserPolicyContext,
): { reason: BrowserPolicyReason | null; capability?: BrowserUploadFileCapability } {
  if (intent.action.type !== "upload") return { reason: null };
  const fileCapabilityId = intent.action.fileCapabilityId;
  const candidates = context.uploadFileCapabilities?.filter((candidate) => candidate.capabilityId === fileCapabilityId) ?? [];
  if (candidates.length === 0) return { reason: "missing-upload-capability" };
  if (candidates.length !== 1) return { reason: "invalid-upload-capability" };
  const capability = candidates[0] as BrowserUploadFileCapability;
  if (context.approvalState.consumedUploadCapabilityIds.includes(capability.capabilityId)) return { reason: "upload-capability-used" };
  if (context.nowMs < capability.issuedAtMs || context.nowMs >= capability.expiresAtMs) return { reason: "expired-upload-capability" };
  if (
    capability.principalId !== intent.principalId ||
    !sameBinding(capability.binding, intent.binding) ||
    !sameProfile(capability.profile, intent.profile) ||
    !sameTarget(capability.target, intent.target) ||
    !sameEpochs(capability, context)
  ) return { reason: "invalid-upload-capability" };
  return { reason: null, capability };
}

function actionReason(
  action: BrowserAction,
  policy: BrowserPolicy,
  observation: BrowserWorkerObservation,
  uploadCapability?: BrowserUploadFileCapability,
): BrowserPolicyReason | null {
  switch (action.type) {
    case "navigate":
      return policy.allowNavigation === true ? urlReason(action.url, originRules(policy)) : "default-deny";
    case "redirect": {
      if (policy.allowRedirects !== true) return "default-deny";
      const rules = policy.allowedRedirectOrigins ?? [];
      return urlReason(action.fromUrl, rules) === null && urlReason(action.toUrl, rules) === null ? null : "redirect-not-allowed";
    }
    case "popup": {
      if (policy.allowPopups !== true) return "default-deny";
      const rules = policy.allowedPopupOrigins ?? [];
      return urlReason(action.openerUrl, rules) === null && urlReason(action.url, rules) === null ? null : "popup-not-allowed";
    }
    case "frame": {
      if (policy.allowFrames !== true) return "default-deny";
      const parent = normalizeBrowserOrigin(action.parentUrl);
      const frame = normalizeBrowserOrigin(action.url);
      const rules = policy.allowedFrameOrigins ?? originRules(policy);
      if (!parent || !frame || !isAllowedOrigin(action.parentUrl, rules) || !isAllowedOrigin(action.url, rules)) return "frame-not-allowed";
      return browserOriginKey(parent) !== browserOriginKey(frame) && policy.allowCrossOriginFrames !== true
        ? "cross-origin-frame-not-allowed"
        : null;
    }
    case "download": {
      if (policy.allowDownloads !== true) return "default-deny";
      const reason = urlReason(action.url, policy.allowedDownloadOrigins ?? originRules(policy));
      if (reason) return reason;
      return isSafeFilename(action.filename) ? null : "unsafe-filename";
    }
    case "upload": {
      if (policy.allowUploads !== true) return "default-deny";
      const reason = urlReason(action.url, policy.allowedUploadOrigins ?? originRules(policy));
      if (reason) return reason;
      if (!uploadCapability) return "missing-upload-capability";
      if (!isSafeFilename(uploadCapability.filename)) return "unsafe-filename";
      return policy.maxUploadBytes !== undefined && uploadCapability.sizeBytes > policy.maxUploadBytes ? "upload-too-large" : null;
    }
    case "screenshot": {
      if (policy.allowScreenshots !== true) return "default-deny";
      if (!isAllowedOrigin(observation.currentUrl, originRules(policy))) return canonicalHttpUrl(observation.currentUrl) ? "domain-not-allowed" : "unsupported-url";
      if (action.target === "element" && (!action.selector || !isValidSelector(action.selector))) return "invalid-selector";
      const sensitiveOrigin = isAllowedOrigin(observation.currentUrl, policy.sensitiveOrigins);
      if (sensitiveOrigin && action.redaction !== "sensitive") return "sensitive-origin-capture";
      if (policy.requireCaptureRedaction === true && action.redaction !== "sensitive") return "capture-redaction-required";
      return null;
    }
    case "selector":
      if (policy.allowSelectorActions !== true) return "default-deny";
      if (!isAllowedOrigin(observation.currentUrl, originRules(policy))) return canonicalHttpUrl(observation.currentUrl) ? "domain-not-allowed" : "unsupported-url";
      if (!isValidSelector(action.selector)) return "invalid-selector";
      return action.operation === "type" && action.text === undefined ? "invalid-selector" : null;
    case "coordinate":
      if (policy.allowCoordinateActions !== true) return "default-deny";
      if (!isAllowedOrigin(observation.currentUrl, originRules(policy))) return canonicalHttpUrl(observation.currentUrl) ? "domain-not-allowed" : "unsupported-url";
      if (
        action.viewport.width <= 0 ||
        action.viewport.height <= 0 ||
        action.x < 0 ||
        action.y < 0 ||
        action.x >= action.viewport.width ||
        action.y >= action.viewport.height ||
        (action.operation === "drag" && (
          action.endX === undefined ||
          action.endY === undefined ||
          action.endX < 0 ||
          action.endY < 0 ||
          action.endX >= action.viewport.width ||
          action.endY >= action.viewport.height
        ))
      ) return "invalid-coordinate";
      return null;
    case "clipboard":
      if (policy.allowClipboard !== true) return "default-deny";
      if (!isAllowedOrigin(observation.currentUrl, originRules(policy))) return canonicalHttpUrl(observation.currentUrl) ? "domain-not-allowed" : "unsupported-url";
      return action.operation === "write" && action.text === undefined ? "invalid-clipboard" : null;
    case "takeover":
      if (policy.allowTakeover !== true) return "default-deny";
      return action.reason.trim().length > 0 ? null : "invalid-takeover-reason";
  }
}

function targetMismatchReason(intent: BrowserCapabilityIntent, context: BrowserPolicyContext): BrowserPolicyReason | null {
  if (!sameStableTarget(intent.target, context.target)) return "target-identity-mismatch";
  return intent.target.epoch !== context.target.epoch ? "stale-target-epoch" : null;
}

function takeoverReleaseMatches(
  action: Extract<BrowserAction, { type: "takeover"; operation: "release" }>,
  intent: BrowserCapabilityIntent,
  active: ActiveBrowserTakeover,
): boolean {
  return action.takeoverId === active.takeoverId &&
    action.takeoverIntentId === active.intentId &&
    intent.principalId === active.principalId &&
    sameTarget(intent.target, active.target);
}

type ApprovalCheck =
  | { status: "granted"; grant: BrowserApprovalGrant }
  | { status: "required" }
  | { status: "denied"; reason: BrowserPolicyReason };

function approvalCheck(
  intent: BrowserCapabilityIntent,
  context: BrowserPolicyContext,
  actionDigest: string,
  policyDigest: string,
  observationDigest: string,
): ApprovalCheck {
  const candidates = context.approvalState.grants.filter((grant) => grant.intentId === intent.intentId);
  if (candidates.length === 0) return { status: "required" };
  if (candidates.length !== 1) return { status: "denied", reason: "approval-invalid" };
  const grant = candidates[0] as BrowserApprovalGrant;
  if (context.approvalState.revokedApprovalIds.includes(grant.approvalId)) return { status: "denied", reason: "approval-revoked" };
  if (context.approvalState.consumedApprovalIds.includes(grant.approvalId)) return { status: "denied", reason: "approval-used" };
  if (context.nowMs < grant.issuedAtMs || context.nowMs >= grant.expiresAtMs) return { status: "denied", reason: "approval-expired" };
  if (
    grant.actionDigest !== actionDigest ||
    grant.policyDigest !== policyDigest ||
    grant.observationDigest !== observationDigest ||
    grant.principalId !== intent.principalId ||
    !sameBinding(grant.binding, intent.binding) ||
    !sameProfile(grant.profile, intent.profile) ||
    !sameTarget(grant.target, intent.target) ||
    grant.trustedMode !== context.trustedMode ||
    grant.policyEpoch !== intent.policyEpoch ||
    grant.approvalEpoch !== intent.approvalEpoch ||
    !sameEpochs(grant, context)
  ) return { status: "denied", reason: "approval-invalid" };
  return { status: "granted", grant };
}

function decisionScope(context: BrowserPolicyContext, policyDigest: string, observationDigest: string): BrowserDecisionScope {
  return deepFreeze({
    principalId: context.principalId,
    binding: context.binding,
    profile: context.workerObservation.profile,
    target: context.target,
    trustedMode: context.trustedMode,
    policyEpoch: context.policyEpoch,
    approvalEpoch: context.approvalEpoch,
    policyDigest,
    observationDigest,
    brokerEpoch: context.brokerEpoch,
    workerEpoch: context.workerEpoch,
    readinessEpoch: context.readinessEpoch,
  });
}

function evidenceIds(context: BrowserPolicyContext | null): readonly string[] {
  const ids = context?.promptInjectionEvidence?.map((evidence) => evidence.evidenceId) ?? [];
  return context ? [context.brokerEvidence.evidenceId, context.workerObservation.observationId, ...ids] : ids;
}

function createLease(
  intent: BrowserCapabilityIntent,
  context: BrowserPolicyContext,
  actionDigest: string,
  policyDigest: string,
  observationDigest: string,
  scope: BrowserDecisionScope,
  approvalId?: string,
  uploadCapability?: BrowserUploadFileCapability,
): BrowserExecutionLease {
  const sensitiveOrigin = intent.action.type === "screenshot" && isAllowedOrigin(context.workerObservation.currentUrl, context.policy.sensitiveOrigins);
  return deepFreeze({
    leaseId: context.brokerEvidence.leaseId,
    evidenceId: context.brokerEvidence.evidenceId,
    decisionId: context.brokerEvidence.decisionId,
    intentId: intent.intentId,
    actionDigest,
    policyDigest,
    observationDigest,
    scope,
    issuedAtMs: context.brokerEvidence.issuedAtMs,
    expiresAtMs: context.brokerEvidence.expiresAtMs,
    singleUse: true as const,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(uploadCapability === undefined
      ? {}
      : {
          uploadCapabilityId: uploadCapability.capabilityId,
          uploadCapabilityDigest: browserUploadFileCapabilityDigest(uploadCapability),
        }),
    ...(intent.action.type === "screenshot"
      ? { capture: { sensitiveOrigin, redaction: intent.action.redaction } }
      : {}),
    brokerEpoch: context.brokerEpoch,
    workerEpoch: context.workerEpoch,
    readinessEpoch: context.readinessEpoch,
  });
}

function authorizeState(
  state: BrowserApprovalState,
  lease: BrowserExecutionLease,
  approvalId?: string,
  uploadCapabilityId?: string,
): BrowserApprovalState | null {
  if (state.revision >= Number.MAX_SAFE_INTEGER) return null;
  if (state.activeLeases.some((candidate) => candidate.leaseId === lease.leaseId) || state.consumedLeaseIds.includes(lease.leaseId)) return null;
  if (approvalId !== undefined && (state.consumedApprovalIds.includes(approvalId) || state.revokedApprovalIds.includes(approvalId))) return null;
  if (uploadCapabilityId !== undefined && state.consumedUploadCapabilityIds.includes(uploadCapabilityId)) return null;
  return deepFreeze({
    ...state,
    revision: state.revision + 1,
    activeLeases: [...state.activeLeases, lease],
    consumedApprovalIds: approvalId === undefined ? [...state.consumedApprovalIds] : [...state.consumedApprovalIds, approvalId],
    consumedUploadCapabilityIds: uploadCapabilityId === undefined
      ? [...state.consumedUploadCapabilityIds]
      : [...state.consumedUploadCapabilityIds, uploadCapabilityId],
  });
}

interface DecisionInput {
  readonly context: BrowserPolicyContext | null;
  readonly intentId: string;
  readonly actionDigest: string;
  readonly status: BrowserPolicyDecision["status"];
  readonly reason: BrowserPolicyReason;
  readonly requiresApproval: boolean;
  readonly state: BrowserApprovalState;
  readonly scope?: BrowserDecisionScope;
  readonly approvalId?: string;
  readonly executionLease?: BrowserExecutionLease;
}

function makeDecision(input: DecisionInput): BrowserPolicyDecision {
  const context = input.context;
  const decisionId = context?.brokerEvidence.decisionId ?? "invalid-decision";
  return deepFreeze({
    decisionId,
    intentId: input.intentId,
    actionDigest: input.actionDigest,
    status: input.status,
    allowed: input.status === "allowed",
    requiresApproval: input.requiresApproval,
    reason: input.reason,
    evidenceIds: evidenceIds(context),
    issuedAtMs: context?.brokerEvidence.issuedAtMs ?? 0,
    ...(input.scope === undefined ? {} : { scope: input.scope, scopeDigest: browserDecisionScopeDigest(input.scope) }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.executionLease === undefined ? {} : { executionLease: input.executionLease }),
    expectedStateRevision: context?.approvalState.revision ?? input.state.revision,
    authorizationState: input.state,
  });
}

function invalidDecision(reason: "invalid-intent" | "invalid-context", state = safeApprovalState()): BrowserPolicyDecision {
  return makeDecision({
    context: null,
    intentId: "",
    actionDigest: reason === "invalid-intent" ? "sha256:invalid-intent" : "sha256:invalid-context",
    status: "denied",
    reason,
    requiresApproval: false,
    state,
  });
}

/**
 * Pure broker authorization transaction. An allowed decision is executable only
 * after `authorizationState` is compare-and-swap committed at
 * `expectedStateRevision`; the returned lease must then be consumed by the worker.
 */
export function decideBrowserIntent(intentInput: unknown, contextInput: unknown): BrowserPolicyDecision {
  try {
    const intent = decodeBrowserCapabilityIntent(intentInput);
    if (!intent) return invalidDecision("invalid-intent");
    const context = decodeBrowserPolicyContext(contextInput);
    if (!context) return invalidDecision("invalid-context");
    const state = context.approvalState;
    const actionDigest = browserActionDigest(intent.action);
    const policyDigest = browserPolicyDigest(context.policy);
    const observationDigest = browserWorkerObservationDigest(context.workerObservation);
    const scope = decisionScope(context, policyDigest, observationDigest);
    const deny = (reason: BrowserPolicyReason, requiresApproval = false): BrowserPolicyDecision => makeDecision({
      context,
      intentId: intent.intentId,
      actionDigest,
      status: "denied",
      reason,
      requiresApproval,
      state,
      scope,
    });

    if (intent.binding.accountId !== context.binding.accountId) return deny("account-binding-mismatch");
    if (intent.binding.projectId !== context.binding.projectId) return deny("project-binding-mismatch");
    if (intent.principalId !== context.principalId) return deny("principal-mismatch");
    const targetReason = targetMismatchReason(intent, context);
    if (targetReason) return deny(targetReason);
    if (intent.policyEpoch !== context.policyEpoch) return deny("stale-policy-epoch");
    if (intent.approvalEpoch !== context.approvalEpoch) return deny("stale-approval-epoch");
    const profileStatus = profileReason(intent, context);
    if (profileStatus) return deny(profileStatus);
    const epochReason = authorityEpochReason(context);
    if (epochReason) return deny(epochReason);
    if (hasUnsupportedActionUrl(intent.action)) return deny("unsupported-url");
    const observedReason = observationReason(intent, context);
    if (observedReason) return deny(observedReason);
    const upload = uploadCapabilityReason(intent, context);
    if (upload.reason) return deny(upload.reason);
    const brokerReason = brokerEvidenceReason(intent, context, actionDigest, policyDigest, observationDigest, upload.capability);
    if (brokerReason) return deny(brokerReason);

    const activeTakeover = context.activeTakeover;
    if (intent.action.type === "takeover" && intent.action.operation === "release") {
      if (!activeTakeover) return deny("no-active-takeover");
      if (!takeoverReleaseMatches(intent.action, intent, activeTakeover)) return deny("takeover-release-mismatch");
    } else if (activeTakeover && intent.actor === "agent") {
      return deny("takeover-active");
    }

    const ids = context.promptInjectionEvidence?.map((evidence) => evidence.evidenceId) ?? [];
    const passiveInspection = intent.action.type === "screenshot" || (intent.action.type === "selector" && intent.action.operation === "inspect");
    if (ids.length > 0 && !passiveInspection && !(intent.action.type === "takeover" && intent.action.operation === "request")) {
      return deny("prompt-injection-evidence");
    }

    const actionStatus = actionReason(intent.action, context.policy, context.workerObservation, upload.capability);
    if (actionStatus) return deny(actionStatus);

    const requiresApproval = isConsequentialAction(intent.action) || (context.policy.approvalRequiredFor?.includes(intent.action.type) ?? false);
    let approvalId: string | undefined;
    if (requiresApproval) {
      const approval = approvalCheck(intent, context, actionDigest, policyDigest, observationDigest);
      if (approval.status === "required") {
        return makeDecision({
          context,
          intentId: intent.intentId,
          actionDigest,
          status: "approval_required",
          reason: "approval-required",
          requiresApproval: true,
          state,
          scope,
        });
      }
      if (approval.status === "denied") return deny(approval.reason, true);
      approvalId = approval.grant.approvalId;
    }

    const uploadCapabilityId = upload.capability?.capabilityId;
    const lease = createLease(intent, context, actionDigest, policyDigest, observationDigest, scope, approvalId, upload.capability);
    const nextState = authorizeState(state, lease, approvalId, uploadCapabilityId);
    if (!nextState) return deny("authorization-replay", requiresApproval);
    return makeDecision({
      context,
      intentId: intent.intentId,
      actionDigest,
      status: "allowed",
      reason: "allowed",
      requiresApproval,
      state: nextState,
      scope,
      ...(approvalId === undefined ? {} : { approvalId }),
      executionLease: lease,
    });
  } catch {
    return invalidDecision("invalid-intent");
  }
}

export function createBrowserApprovalState(grantsInput: readonly BrowserApprovalGrant[] = []): BrowserApprovalState {
  try {
    const values = readDataArray(grantsInput);
    if (!values) return safeApprovalState();
    const grants: BrowserApprovalGrant[] = [];
    for (const candidate of values) {
      const grant = decodeApprovalGrant(candidate);
      if (grant) grants.push(grant);
    }
    if (new Set(grants.map((grant) => grant.approvalId)).size !== grants.length) return safeApprovalState();
    return deepFreeze({
      revision: 0,
      grants,
      consumedApprovalIds: [],
      revokedApprovalIds: [],
      activeLeases: [],
      consumedLeaseIds: [],
      consumedUploadCapabilityIds: [],
    });
  } catch {
    return safeApprovalState();
  }
}

export function consumeBrowserApproval(stateInput: BrowserApprovalState, approvalId: string): BrowserApprovalState {
  try {
    const state = decodeBrowserApprovalState(stateInput);
    if (!state || !isOpaqueId(approvalId) || state.revision >= Number.MAX_SAFE_INTEGER) return state ?? safeApprovalState();
    if (!state.grants.some((grant) => grant.approvalId === approvalId) || state.consumedApprovalIds.includes(approvalId) || state.revokedApprovalIds.includes(approvalId)) return state;
    return deepFreeze({ ...state, revision: state.revision + 1, consumedApprovalIds: [...state.consumedApprovalIds, approvalId] });
  } catch {
    return safeApprovalState();
  }
}

export function revokeBrowserApproval(stateInput: BrowserApprovalState, approvalId: string): BrowserApprovalState {
  try {
    const state = decodeBrowserApprovalState(stateInput);
    if (!state || !isOpaqueId(approvalId) || state.revision >= Number.MAX_SAFE_INTEGER) return state ?? safeApprovalState();
    if (!state.grants.some((grant) => grant.approvalId === approvalId) || state.consumedApprovalIds.includes(approvalId) || state.revokedApprovalIds.includes(approvalId)) return state;
    return deepFreeze({ ...state, revision: state.revision + 1, revokedApprovalIds: [...state.revokedApprovalIds, approvalId] });
  } catch {
    return safeApprovalState();
  }
}

function rejectedLease(
  state: BrowserApprovalState,
  reason: BrowserLeaseConsumeReason,
): BrowserLeaseConsumeResult {
  return deepFreeze({ accepted: false, reason, expectedStateRevision: state.revision, state });
}

/** Worker-side, single-use lease transition against the exact current observation. */
export function consumeBrowserExecutionLease(
  stateInput: unknown,
  leaseInput: unknown,
  observationInput: unknown,
  nowMs: number,
): BrowserLeaseConsumeResult {
  try {
    const state = decodeBrowserApprovalState(stateInput);
    if (!state) return rejectedLease(safeApprovalState(), "invalid-state");
    const lease = decodeBrowserExecutionLease(leaseInput);
    if (!lease || !finiteNumber(nowMs)) return rejectedLease(state, "invalid-lease");
    if (state.consumedLeaseIds.includes(lease.leaseId)) return rejectedLease(state, "lease-used");
    const persisted = state.activeLeases.find((candidate) => candidate.leaseId === lease.leaseId);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(lease)) return rejectedLease(state, "lease-not-active");
    if (nowMs < lease.issuedAtMs || nowMs >= lease.expiresAtMs) return rejectedLease(state, "lease-expired");
    const observation = decodeBrowserWorkerObservation(observationInput);
    if (!observation) return rejectedLease(state, "worker-observation-mismatch");
    if (observation.brokerEpoch !== lease.brokerEpoch) return rejectedLease(state, "stale-broker-epoch");
    if (observation.workerEpoch !== lease.workerEpoch) return rejectedLease(state, "stale-worker-epoch");
    if (observation.readinessEpoch !== lease.readinessEpoch) return rejectedLease(state, "stale-readiness-epoch");
    if (browserWorkerObservationDigest(observation) !== lease.observationDigest) return rejectedLease(state, "worker-observation-mismatch");
    if (state.revision >= Number.MAX_SAFE_INTEGER) return rejectedLease(state, "invalid-state");
    const next = deepFreeze({
      ...state,
      revision: state.revision + 1,
      activeLeases: state.activeLeases.filter((candidate) => candidate.leaseId !== lease.leaseId),
      consumedLeaseIds: [...state.consumedLeaseIds, lease.leaseId],
    });
    return deepFreeze({ accepted: true, reason: "consumed", expectedStateRevision: state.revision, state: next });
  } catch {
    return rejectedLease(safeApprovalState(), "invalid-state");
  }
}

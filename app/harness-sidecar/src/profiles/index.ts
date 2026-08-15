import { DAEMON_V7_SCHEMA13_PROFILE } from "./daemon-v7-schema13.js";
import { DAEMON_V7_SCHEMA16_PROFILE } from "./daemon-v7-schema16.js";

export interface PrimeDaemonProfile {
  readonly id: string;
  readonly packageName: "prime-agent";
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly entrypointDigest: string;
  readonly daemonEntrypointDigest: string;
  readonly distJavascriptClosureDigest: string;
  readonly distJavascriptClosureFiles: number;
  readonly adapterRelativePath: string;
  readonly adapterPackageDirectory: string;
  readonly adapterDigest: string;
  readonly protocolName: "prime-agent.daemon";
  readonly protocolVersion: number;
  readonly schemaRevision: number;
  readonly schemaId: string;
  readonly mandatoryCapabilities: readonly string[];
  readonly supportedCapabilities: readonly string[];
}

export const PRIME_DAEMON_PROFILES: readonly PrimeDaemonProfile[] = Object.freeze([
  DAEMON_V7_SCHEMA16_PROFILE,
  DAEMON_V7_SCHEMA13_PROFILE,
]);

export function profileForPackageIdentity(identity: Readonly<{
  packageName: string;
  packageVersion: string;
  packageDigest: string;
  entrypointDigest: string;
}>): PrimeDaemonProfile | null {
  return PRIME_DAEMON_PROFILES.find((profile) =>
    identity.packageName === profile.packageName
    && identity.packageVersion === profile.packageVersion
    && identity.packageDigest === profile.packageDigest
    && identity.entrypointDigest === profile.entrypointDigest
  ) ?? null;
}

export function profileForRuntimeIdentity(identity: Readonly<{
  packageName: string;
  packageVersion: string;
  packageDigest: string;
  entrypointDigest: string;
  protocolName: string;
  protocolVersion: number;
  schemaRevision: number;
  schemaId: string;
}>): PrimeDaemonProfile | null {
  const profile = profileForPackageIdentity(identity);
  if (!profile
    || identity.protocolName !== profile.protocolName
    || identity.protocolVersion !== profile.protocolVersion
    || identity.schemaRevision !== profile.schemaRevision
    || identity.schemaId !== profile.schemaId) return null;
  return profile;
}

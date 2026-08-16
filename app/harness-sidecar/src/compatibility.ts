import { profileForPackageIdentity, profileForRuntimeIdentity } from "./profiles/index.js";
import type { RuntimeIdentity } from "./runtimeDiscovery.js";

type Capability = string;
type Reason =
  | "runtime_identity_mismatch"
  | "unsupported_protocol"
  | "unsupported_schema"
  | "missing_mandatory_capability";

export type Compatibility =
  | { readonly status: "ready"; readonly profile: string; readonly capabilities: readonly Capability[] }
  | { readonly status: "degraded"; readonly profile: string; readonly capabilities: readonly Capability[]; readonly unavailable: readonly { capability: Capability; reason: "missing_mandatory_capability" }[] }
  | { readonly status: "read_only"; readonly reason: "missing_mandatory_capability"; readonly runtime: RuntimeIdentity }
  | { readonly status: "unavailable"; readonly reason: Exclude<Reason, "missing_mandatory_capability"> };

function unavailable(reason: Exclude<Reason, "missing_mandatory_capability">): Compatibility {
  return Object.freeze({ status: "unavailable", reason });
}

function copyRuntime(runtime: RuntimeIdentity): RuntimeIdentity {
  return Object.freeze({ ...runtime, capabilities: Object.freeze([...runtime.capabilities]) }) as RuntimeIdentity;
}

export function decideCompatibility(runtime: RuntimeIdentity): Compatibility {
  const packageProfile = profileForPackageIdentity(runtime);
  if (!packageProfile) return unavailable("runtime_identity_mismatch");
  if (runtime.protocolName !== packageProfile.protocolName || runtime.protocolVersion !== packageProfile.protocolVersion) {
    return unavailable("unsupported_protocol");
  }
  const profile = profileForRuntimeIdentity(runtime);
  if (!profile) return unavailable("unsupported_schema");

  const observed = new Set(runtime.capabilities);
  const missingMandatory = profile.mandatoryCapabilities.filter((capability) => !observed.has(capability));
  if (missingMandatory.length > 0) {
    return Object.freeze({
      status: "read_only",
      reason: "missing_mandatory_capability",
      runtime: copyRuntime(runtime),
    });
  }

  const capabilities = Object.freeze(
    profile.supportedCapabilities.filter((capability) => observed.has(capability)),
  );
  const unavailableFeatures = Object.freeze(
    profile.supportedCapabilities
      .filter((capability) => !observed.has(capability))
      .map((capability) => Object.freeze({ capability, reason: "missing_mandatory_capability" as const })),
  );
  if (unavailableFeatures.length > 0) {
    return Object.freeze({
      status: "degraded",
      profile: profile.id,
      capabilities,
      unavailable: unavailableFeatures,
    });
  }
  return Object.freeze({ status: "ready", profile: profile.id, capabilities });
}

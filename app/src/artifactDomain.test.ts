// @ts-expect-error Vitest runs on Node, while the frontend TypeScript config intentionally has no Node typings.
import { spawnSync } from "node:child_process";
// @ts-expect-error Vitest runs on Node, while the frontend TypeScript config intentionally has no Node typings.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
// @ts-expect-error Vitest runs on Node, while the frontend TypeScript config intentionally has no Node typings.
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import * as artifactDomain from "./artifactDomain";

import {
  ArtifactDomainError,
  ArtifactStore,
  artifactDomainTestHarness,
  decodeArtifactExport,
  decodeTransferEnvelope,
  deserializeArtifactExport,
  serializeArtifactExport,
  type ArtifactTransferBinding,
  type ArtifactBrokerHandle,
  type ArtifactBrokerTestHarness,
  type ArtifactDeletionRequest,
  type ArtifactVersionDraft,
  type BlobDescriptor,
  type BlobReference,
  type BrokerTransferRegistration,
} from "./artifactDomain";

const DEFAULT_TRANSFER_EXPIRY_MS = 10_000;
const RUNTIME_BYTE_ARRAY_CAP = 64 * 1024 * 1024;
const EXACT_CAP_ZERO_SHA256 = "3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351";
const HEAP_PROBE_ENVIRONMENT_KEY = "PRIME_ARTIFACT_BYTE_HEAP_PROBE";
const HEAP_PROBE_TEST_NAME = "enforces the measured runtime byte boundary within a 128 MiB heap";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (input: Uint8Array): string => createHash("sha256").update(new Uint8Array(input)).digest("hex");

const authorities = new WeakMap<ArtifactStore, ArtifactBrokerTestHarness>();

function testHarness() {
  if (!artifactDomainTestHarness) throw new Error("artifact domain test harness is unavailable outside test mode");
  return artifactDomainTestHarness;
}

function artifactStore(initialNowMs = 0): ArtifactStore {
  const broker = testHarness().createBroker(initialNowMs);
  const store = broker.createStore();
  authorities.set(store, broker);
  return store;
}

function brokerFor(store: ArtifactStore): ArtifactBrokerTestHarness {
  const broker = authorities.get(store);
  if (!broker) throw new Error("test store has no broker authority");
  return broker;
}

function descriptor(data: Uint8Array, overrides: Partial<BlobDescriptor> = {}): BlobDescriptor {
  return {
    byteLength: data.byteLength,
    sha256: digest(data),
    mediaType: "application/octet-stream",
    schema: "bytes/v1",
    ...overrides,
  };
}

function revision(sessionId = "session_1") {
  return {
    buildFingerprint: "prime-build-1",
    profileId: "profile_1",
    sessionId,
    generation: 1,
    cursor: 7,
    entryId: "entry_7",
    prefixSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

function transferBinding(overrides: Partial<ArtifactTransferBinding> = {}): ArtifactTransferBinding {
  return {
    artifactId: "artifact_1",
    projectId: "project_1",
    chatId: "chat_1",
    sessionId: "session_1",
    agentId: "agent_1",
    sourceRevision: revision(),
    ...overrides,
  };
}

function artifactDraft(
  versionId: string,
  root: BlobReference,
  overrides: Partial<ArtifactVersionDraft> = {},
): ArtifactVersionDraft {
  return {
    versionId,
    ...transferBinding(),
    presentationPath: "reports/summary.bin",
    root,
    ...overrides,
  };
}

function rootReference(blobId: string, data: Uint8Array): BlobReference {
  return { blobId, ...descriptor(data) };
}

function deletionRequest(
  versionId: string,
  overrides: Partial<ArtifactTransferBinding> = {},
): ArtifactDeletionRequest {
  return { versionId, ...transferBinding(overrides) };
}

function registerTransfer(store: ArtifactStore, input: BrokerTransferRegistration): void {
  const broker = brokerFor(store);
  broker.registerTransfer(input);
  store.stageTransfer(input.transferId);
}

function stageBlob(
  store: ArtifactStore,
  transferId: string,
  blobId: string,
  data: Uint8Array,
  references: readonly BlobReference[] = [],
  options: {
    readonly binding?: ArtifactTransferBinding;
    readonly expiresAtMs?: number;
    readonly authorizeCommit?: boolean;
  } = {},
) {
  const blobDescriptor = descriptor(data);
  registerTransfer(store, {
    transferId,
    blobId,
    descriptor: blobDescriptor,
    references,
    binding: options.binding ?? transferBinding(),
    expiresAtMs: options.expiresAtMs ?? DEFAULT_TRANSFER_EXPIRY_MS,
  });
  store.receiveTransfer(transferId, data);
  if (options.authorizeCommit ?? true) brokerFor(store).authorizeArtifactCommit(transferId);
  return { blobDescriptor, reference: { blobId, ...blobDescriptor } satisfies BlobReference };
}

function commitOne(
  store: ArtifactStore,
  transferId: string,
  blobId: string,
  data: Uint8Array,
  draftOverrides: Partial<ArtifactVersionDraft> = {},
  expiresAtMs = DEFAULT_TRANSFER_EXPIRY_MS,
) {
  const staged = stageBlob(store, transferId, blobId, data, [], { expiresAtMs });
  store.promoteTransfer(transferId);
  const versionId = draftOverrides.versionId ?? "version_1";
  store.commitArtifact(transferId, artifactDraft(versionId, staged.reference, draftOverrides));
  brokerFor(store).authorizeTransferAck(transferId, versionId);
  store.ackTransfer(transferId);
  return staged;
}

function restoreTrusted(input: unknown, manifest: Parameters<ArtifactBrokerTestHarness["authorizeClosureImport"]>[0]): ArtifactStore {
  const broker = testHarness().createBroker();
  return ArtifactStore.restore(input, broker, broker.authorizeClosureImport(manifest));
}

describe("artifact identity and content-reference domain", () => {
  it("keeps same-path changed content as two immutable versions", () => {
    const store = artifactStore();
    const firstData = bytes("first");
    const secondData = bytes("second");

    commitOne(store, "broker_first", "blob_first", firstData, { versionId: "version_first" });
    commitOne(store, "broker_second", "blob_second", secondData, {
      versionId: "version_second",
      presentationPath: "reports/summary.bin",
    });

    expect(store.listArtifacts()).toHaveLength(2);
    expect(store.listArtifacts().map((artifact) => artifact.presentationPath)).toEqual([
      "reports/summary.bin",
      "reports/summary.bin",
    ]);
    expect(store.getBlob("blob_first")?.descriptor.sha256).not.toBe(store.getBlob("blob_second")?.descriptor.sha256);
  });

  it("uses its closed SHA-256 implementation to verify exact received bytes", () => {
    const store = artifactStore();
    const expected = bytes("abc");
    const blobDescriptor = descriptor(expected);
    expect(blobDescriptor.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    registerTransfer(store, {
      transferId: "broker_hash",
      blobId: "blob_hash",
      descriptor: blobDescriptor,
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });

    store.receiveTransfer("broker_hash", expected);
    expect(store.getTransfer("broker_hash")?.lifecycle).toBe("verified");
    expect(() => store.receiveTransfer("broker_hash", bytes("bad"))).toThrowError(
      expect.objectContaining({ code: "identity-conflict" }),
    );

    const multiBlock = bytes("x".repeat(100));
    registerTransfer(store, {
      transferId: "broker_hash_multiblock",
      blobId: "blob_hash_multiblock",
      descriptor: descriptor(multiBlock),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });
    expect(store.receiveTransfer("broker_hash_multiblock", multiBlock).lifecycle).toBe("verified");
  });

  it("rejects a received blob whose same-length bytes do not match its descriptor", () => {
    const store = artifactStore();
    const expected = bytes("benign!");
    registerTransfer(store, {
      transferId: "broker_hash_mismatch",
      blobId: "blob_hash_mismatch",
      descriptor: descriptor(expected),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });

    expect(() => store.receiveTransfer("broker_hash_mismatch", bytes("forged!"))).toThrowError(
      expect.objectContaining({ code: "hash-mismatch" }),
    );
  });

  it("rejects a received blob whose byte length does not match its descriptor", () => {
    const store = artifactStore();
    const expected = bytes("expected");
    registerTransfer(store, {
      transferId: "broker_length",
      blobId: "blob_length",
      descriptor: descriptor(expected, { byteLength: expected.byteLength + 1 }),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });

    expect(() => store.receiveTransfer("broker_length", expected)).toThrowError(
      expect.objectContaining({ code: "length-mismatch" }),
    );
  });

  it("requires an actual broker authority rather than a caller-mintable digest provider", () => {
    const hostileProvider = {
      algorithm: "sha-256" as const,
      compute(input: Uint8Array) {
        return { algorithm: "sha-256" as const, byteLength: input.byteLength, digest: "0".repeat(64) };
      },
    };
    const StoreConstructor = ArtifactStore as unknown as new (authority: unknown) => ArtifactStore;

    expect(() => new StoreConstructor(hostileProvider)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );
    expect("broker" in artifactStore()).toBe(false);
  });

  it("does not expose a caller-mintable broker authority constructor", () => {
    expect("ArtifactBrokerAuthority" in artifactDomain).toBe(false);
    expect(() => ArtifactStore.createFromTrustedBroker({} as ArtifactBrokerHandle)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );
  });

  it("keeps production broker bootstrap explicitly unavailable without native evidence", () => {
    expect("artifactDomainProductionBroker" in artifactDomain).toBe(true);
    expect(
      (artifactDomain as unknown as Record<string, unknown>).artifactDomainProductionBroker,
    ).toBeUndefined();
    expect("createArtifactBrokerAuthority" in artifactDomain).toBe(false);
    expect("registerArtifactBrokerHandle" in artifactDomain).toBe(false);
  });

  it("requires a broker-registered transfer and explicit commit phase before a durable commit", () => {
    const store = artifactStore();
    const data = bytes("phase evidence");
    const blobDescriptor = descriptor(data);
    registerTransfer(store, {
      transferId: "broker_phase",
      blobId: "blob_phase",
      descriptor: blobDescriptor,
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });
    store.receiveTransfer("broker_phase", data);
    store.promoteTransfer("broker_phase");

    expect(() =>
      store.commitArtifact("broker_phase", artifactDraft("version_phase", { blobId: "blob_phase", ...blobDescriptor })),
    ).toThrowError(expect.objectContaining({ code: "transfer-state" }));

    brokerFor(store).authorizeArtifactCommit("broker_phase");
    expect(store.commitArtifact("broker_phase", artifactDraft("version_phase", { blobId: "blob_phase", ...blobDescriptor }))).toMatchObject({
      versionId: "version_phase",
    });
  });

  it("rejects a promoted transfer when its artifact ownership crosses the broker project scope", () => {
    const store = artifactStore();
    const data = bytes("project-bound bytes");
    const staged = stageBlob(store, "broker_project_scope", "blob_project_scope", data);
    store.promoteTransfer("broker_project_scope");

    expect(() =>
      store.commitArtifact(
        "broker_project_scope",
        artifactDraft("version_cross_project", staged.reference, {
          projectId: "project_2",
          chatId: "chat_2",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "provenance-mismatch" }));
  });

  it("rejects a root transfer that references a durable blob owned by another project", () => {
    const store = artifactStore();
    const child = stageBlob(
      store,
      "broker_cross_project_child",
      "blob_cross_project_child",
      bytes("cross project child"),
      [],
      { binding: transferBinding({ projectId: "project_2", chatId: "chat_2" }) },
    );
    store.promoteTransfer("broker_cross_project_child");
    const root = stageBlob(
      store,
      "broker_cross_project_root",
      "blob_cross_project_root",
      bytes("project one root"),
      [child.reference],
    );
    store.promoteTransfer("broker_cross_project_root");

    expect(() =>
      store.commitArtifact("broker_cross_project_root", artifactDraft("version_cross_project_child", root.reference)),
    ).toThrowError(expect.objectContaining({ code: "provenance-mismatch" }));
  });

  it("rejects a transfer whose source revision, artifact, or session differ from broker evidence", () => {
    const store = artifactStore();
    const data = bytes("source-bound bytes");
    const staged = stageBlob(store, "broker_source_scope", "blob_source_scope", data);
    store.promoteTransfer("broker_source_scope");

    for (const [index, overrides] of [
      { artifactId: "artifact_2" },
      { sessionId: "session_2", sourceRevision: revision("session_2") },
      { sourceRevision: { ...revision(), generation: 2 } },
    ].entries()) {
      expect(() =>
        store.commitArtifact("broker_source_scope", artifactDraft(`version_scope_${index}`, staged.reference, overrides)),
      ).toThrowError(expect.objectContaining({ code: "provenance-mismatch" }));
    }
  });

  it("does not expose an unlinked direct artifact-version commit path", () => {
    const store = artifactStore();
    const staged = stageBlob(store, "broker_unlinked", "blob_unlinked", bytes("unlinked bytes"));
    store.promoteTransfer("broker_unlinked");
    const hostileStore = store as unknown as { commitArtifactVersion(input: ArtifactVersionDraft): unknown };

    expect(() => hostileStore.commitArtifactVersion(artifactDraft("version_unlinked", staged.reference))).toThrow();
  });

  it("refuses to commit an artifact when a transitively referenced blob is missing", () => {
    const store = artifactStore();
    const childData = bytes("child");
    const rootData = bytes("root");
    const child = rootReference("blob_child", childData);
    const root = stageBlob(store, "broker_root", "blob_root", rootData, [child]);
    store.promoteTransfer("broker_root");

    expect(() => store.commitArtifact("broker_root", artifactDraft("version_missing_child", root.reference))).toThrowError(
      expect.objectContaining({ code: "missing-blob" }),
    );
  });

  it("rejects a transitive reference whose descriptor disagrees with durable content", () => {
    const store = artifactStore();
    const childData = bytes("child");
    const rootData = bytes("root");
    stageBlob(store, "broker_child_mismatch", "blob_child_mismatch", childData);
    store.promoteTransfer("broker_child_mismatch");
    const wrongChildReference = { ...rootReference("blob_child_mismatch", childData), byteLength: childData.byteLength + 1 };
    const root = stageBlob(store, "broker_root_mismatch", "blob_root_mismatch", rootData, [wrongChildReference]);
    store.promoteTransfer("broker_root_mismatch");

    expect(() => store.commitArtifact("broker_root_mismatch", artifactDraft("version_reference_mismatch", root.reference))).toThrowError(
      expect.objectContaining({ code: "reference-mismatch" }),
    );
  });

  it("requires durable reference and broker ACK phase before transfer acknowledgement", () => {
    const store = artifactStore();
    const staged = stageBlob(store, "broker_ack", "blob_ack", bytes("ack order"));

    expect(() => store.ackTransfer("broker_ack")).toThrowError(expect.objectContaining({ code: "ack-before-reference" }));
    store.promoteTransfer("broker_ack");
    expect(() => store.ackTransfer("broker_ack")).toThrowError(expect.objectContaining({ code: "ack-before-reference" }));
    store.commitArtifact("broker_ack", artifactDraft("version_ack", staged.reference));
    expect(() => store.ackTransfer("broker_ack")).toThrowError(expect.objectContaining({ code: "transfer-state" }));
    brokerFor(store).authorizeTransferAck("broker_ack", "version_ack");
    expect(store.ackTransfer("broker_ack").lifecycle).toBe("acked");
  });

  it("requires broker authorization for deletion and retains a deleted artifact until transfer retention expires", () => {
    const store = artifactStore();
    commitOne(store, "broker_delete", "blob_delete", bytes("delete lease"), { versionId: "version_delete" }, 5);
    const hostileStore = store as unknown as { deleteArtifact(authorization: unknown): unknown };
    expect(() => hostileStore.deleteArtifact("version_delete")).toThrowError(expect.objectContaining({ code: "unsafe-input" }));

    const broker = brokerFor(store);
    expect(store.deleteArtifact(broker.authorizeArtifactDeletion(deletionRequest("version_delete")))).toBe(true);
    expect(store.getBlob("blob_delete")).not.toBeNull();
    broker.advanceTimeTo(5);
    expect(store.getBlob("blob_delete")).toBeNull();
  });

  it("consumes a deletion authorization even when its target is absent", () => {
    const store = artifactStore();
    const authorization = brokerFor(store).authorizeArtifactDeletion(deletionRequest("version_absent"));

    expect(store.deleteArtifact(authorization)).toBe(false);
    expect(() => store.deleteArtifact(authorization)).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
  });

  it("binds deletion authorization to the full artifact, agent, and source-revision scope", () => {
    const store = artifactStore();
    commitOne(store, "broker_delete_scope", "blob_delete_scope", bytes("scoped deletion"), { versionId: "version_delete_scope" });
    const broker = brokerFor(store);

    for (const request of [
      deletionRequest("version_delete_scope", { agentId: "agent_2" }),
      deletionRequest("version_delete_scope", { sourceRevision: { ...revision(), generation: 2 } }),
    ]) {
      const authorization = broker.authorizeArtifactDeletion(request);
      expect(() => store.deleteArtifact(authorization)).toThrowError(expect.objectContaining({ code: "provenance-mismatch" }));
      expect(() => store.deleteArtifact(authorization)).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
    }

    expect(store.getArtifact("version_delete_scope")).not.toBeNull();
  });

  it("keeps broker-pinned closures alive until the pin is explicitly unpinned or expires", () => {
    const store = artifactStore();
    const childData = bytes("child");
    const rootData = bytes("root");
    const child = stageBlob(store, "broker_pin_child", "blob_pin_child", childData, [], { expiresAtMs: 5 });
    store.promoteTransfer("broker_pin_child");
    const root = stageBlob(store, "broker_pin_root", "blob_pin_root", rootData, [child.reference], { expiresAtMs: 5 });
    store.promoteTransfer("broker_pin_root");
    store.commitArtifact("broker_pin_root", artifactDraft("version_pinned", root.reference));
    const broker = brokerFor(store);
    broker.authorizeTransferAck("broker_pin_root", "version_pinned");
    store.ackTransfer("broker_pin_root");
    const manifest = store.createClosureManifest(["version_pinned"]);
    store.pinClosure(broker.authorizeClosurePin(manifest.manifestSha256, 20), manifest);
    store.deleteArtifact(broker.authorizeArtifactDeletion(deletionRequest("version_pinned")));

    broker.advanceTimeTo(5);
    expect(store.getBlob("blob_pin_root")).not.toBeNull();
    expect(store.unpinClosure(broker.authorizeClosureUnpin(manifest.manifestSha256))).toBe(true);
    expect(store.getBlob("blob_pin_child")).toBeNull();
    expect(store.getBlob("blob_pin_root")).toBeNull();
  });

  it("consumes pin capabilities on the first malformed or missing closure attempt", () => {
    const source = artifactStore();
    commitOne(source, "broker_pin_attempt", "blob_pin_attempt", bytes("pin attempt"), {
      versionId: "version_pin_attempt",
    });
    const manifest = source.createClosureManifest(["version_pin_attempt"]);
    const sourceBroker = brokerFor(source);
    const malformedAuthorization = sourceBroker.authorizeClosurePin(manifest.manifestSha256, 20);
    const malformed = { ...manifest, rootArtifactVersionIds: [] };

    expect(() => source.pinClosure(malformedAuthorization, malformed)).toThrowError(
      expect.objectContaining({ code: "invalid-closure" }),
    );
    expect(() => source.pinClosure(malformedAuthorization, manifest)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );

    const missingStore = artifactStore();
    const missingAuthorization = brokerFor(missingStore).authorizeClosurePin(manifest.manifestSha256, 20);
    expect(() => missingStore.pinClosure(missingAuthorization, manifest)).toThrowError(
      expect.objectContaining({ code: "invalid-closure" }),
    );
    expect(() => missingStore.pinClosure(missingAuthorization, manifest)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );
  });

  it("expires spools on state access without exposing caller cleanup or collection operations", () => {
    const store = artifactStore();
    const broker = brokerFor(store);
    registerTransfer(store, {
      transferId: "broker_automatic_expiry",
      blobId: "blob_automatic_expiry",
      descriptor: descriptor(bytes("expired spool")),
      references: [],
      binding: transferBinding(),
      expiresAtMs: 10,
    });
    broker.advanceTimeTo(10);

    expect(store.getTransfer("broker_automatic_expiry")).toBeNull();
    expect("cleanupExpiredSpools" in store).toBe(false);
    expect("collectGarbage" in store).toBe(false);
  });

  it("reclaims expired broker transfer registrations so their identifiers can be reused", () => {
    const store = artifactStore();
    const broker = brokerFor(store);
    const first = {
      transferId: "broker_reused_after_expiry",
      blobId: "blob_expired_registration",
      descriptor: descriptor(bytes("expired registration")),
      references: [],
      binding: transferBinding(),
      expiresAtMs: 5,
    } satisfies BrokerTransferRegistration;
    broker.registerTransfer(first);
    broker.advanceTimeTo(5);

    expect(broker.getTransfer(first.transferId)).toBeNull();
    expect(() => broker.registerTransfer({
      ...first,
      blobId: "blob_reused_registration",
      descriptor: descriptor(bytes("replacement registration")),
      expiresAtMs: 10,
    })).not.toThrow();
  });

  it("produces an exact deterministic closure export and restores its full broker-approved graph", () => {
    const first = artifactStore();
    const childData = bytes("child");
    const rootData = bytes("root");
    const child = stageBlob(first, "broker_export_child", "blob_export_child", childData);
    first.promoteTransfer("broker_export_child");
    const root = stageBlob(first, "broker_export_root", "blob_export_root", rootData, [child.reference]);
    first.promoteTransfer("broker_export_root");
    first.commitArtifact("broker_export_root", artifactDraft("version_export", root.reference));
    const exportOne = first.exportClosure(["version_export"]);
    expect(exportOne.objects.every((object) => object.bytes instanceof Uint8Array)).toBe(true);
    const serializedOne = serializeArtifactExport(exportOne);
    const restored = restoreTrusted(deserializeArtifactExport(serializedOne), exportOne.manifest);
    const exportTwo = restored.exportClosure(["version_export"]);

    expect(serializeArtifactExport(exportTwo)).toBe(serializedOne);
    expect(exportOne.manifest.blobs.map((blob) => blob.blobId)).toEqual(["blob_export_child", "blob_export_root"]);
    expect(restored.getArtifact("version_export")?.sourceRevision).toEqual(revision());
  });

  it("imports only the broker-approved closure without deleting another project’s durable state", () => {
    const source = artifactStore();
    commitOne(source, "broker_import_source", "blob_import_source", bytes("project one"), { versionId: "version_import_source" });
    const exported = source.exportClosure(["version_import_source"]);

    const destination = artifactStore();
    const otherBinding = transferBinding({
      artifactId: "artifact_2",
      projectId: "project_2",
      chatId: "chat_2",
      sessionId: "session_2",
      agentId: "agent_2",
      sourceRevision: revision("session_2"),
    });
    const other = stageBlob(
      destination,
      "broker_import_destination",
      "blob_import_destination",
      bytes("project two"),
      [],
      { binding: otherBinding },
    );
    destination.promoteTransfer("broker_import_destination");
    destination.commitArtifact(
      "broker_import_destination",
      artifactDraft("version_import_destination", other.reference, otherBinding),
    );
    brokerFor(destination).authorizeTransferAck("broker_import_destination", "version_import_destination");
    destination.ackTransfer("broker_import_destination");

    destination.restoreClosure(
      brokerFor(destination).authorizeClosureImport(exported.manifest),
      exported,
    );

    expect(destination.getArtifact("version_import_source")).not.toBeNull();
    expect(destination.getArtifact("version_import_destination")?.projectId).toBe("project_2");
    expect(destination.getBlob("blob_import_destination")).not.toBeNull();
  });

  it("consumes import capabilities on the first malformed, missing, or conflicting attempt", () => {
    const source = artifactStore();
    commitOne(source, "broker_import_attempt", "blob_import_attempt", bytes("import source"), {
      versionId: "version_import_attempt",
    });
    const exported = source.exportClosure(["version_import_attempt"]);

    const malformedStore = artifactStore();
    const malformedAuthorization = brokerFor(malformedStore).authorizeClosureImport(exported.manifest);
    expect(() => malformedStore.restoreClosure(malformedAuthorization, {})).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );
    expect(() => malformedStore.restoreClosure(malformedAuthorization, exported)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );

    const missingStore = artifactStore();
    const missingAuthorization = brokerFor(missingStore).authorizeClosureImport(exported.manifest);
    const missing = { ...exported, objects: [] };
    expect(() => missingStore.restoreClosure(missingAuthorization, missing)).toThrowError(
      expect.objectContaining({ code: "missing-blob" }),
    );
    expect(() => missingStore.restoreClosure(missingAuthorization, exported)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );

    const conflictStore = artifactStore();
    stageBlob(
      conflictStore,
      "broker_import_conflict",
      "blob_import_attempt",
      bytes("different durable bytes"),
    );
    conflictStore.promoteTransfer("broker_import_conflict");
    const conflictAuthorization = brokerFor(conflictStore).authorizeClosureImport(exported.manifest);
    expect(() => conflictStore.restoreClosure(conflictAuthorization, exported)).toThrowError(
      expect.objectContaining({ code: "identity-conflict" }),
    );
    expect(() => conflictStore.restoreClosure(conflictAuthorization, exported)).toThrowError(
      expect.objectContaining({ code: "unsafe-input" }),
    );
  });

  it("rejects restored closures with missing or corrupt transitive objects before replacing storage", () => {
    const source = artifactStore();
    const child = stageBlob(source, "broker_restore_child", "blob_restore_child", bytes("child"));
    source.promoteTransfer("broker_restore_child");
    const root = stageBlob(source, "broker_restore_root", "blob_restore_root", bytes("root"), [child.reference]);
    source.promoteTransfer("broker_restore_root");
    source.commitArtifact("broker_restore_root", artifactDraft("version_restore", root.reference));
    const exported = source.exportClosure(["version_restore"]);

    const missing = { ...exported, objects: exported.objects.filter((object) => object.blobId !== "blob_restore_child") };
    expect(() => restoreTrusted(missing, exported.manifest)).toThrowError(expect.objectContaining({ code: "missing-blob" }));

    const corrupt = source.exportClosure(["version_restore"]);
    const childObject = corrupt.objects.find((object) => object.blobId === "blob_restore_child");
    if (!childObject) throw new Error("test fixture did not contain child blob");
    childObject.bytes[0] ^= 0xff;
    expect(() => restoreTrusted(corrupt, exported.manifest)).toThrowError(expect.objectContaining({ code: "hash-mismatch" }));
  });

  it("rejects a decoded export whose manifest declares a missing object immediately", () => {
    const store = artifactStore();
    commitOne(store, "broker_missing_object", "blob_missing_object", bytes("missing object"), { versionId: "version_missing_object" });
    const exported = store.exportClosure(["version_missing_object"]);
    exported.objects = [];

    expect(() => decodeArtifactExport(exported)).toThrowError(expect.objectContaining({ code: "missing-blob" }));
  });

  it("rejects a decoded export with an extra undeclared object immediately", () => {
    const store = artifactStore();
    commitOne(store, "broker_extra_object", "blob_extra_object", bytes("extra object"), { versionId: "version_extra_object" });
    const exported = store.exportClosure(["version_extra_object"]);
    exported.objects.push({ blobId: "blob_not_declared", bytes: bytes("extra") });

    expect(() => decodeArtifactExport(exported)).toThrowError(expect.objectContaining({ code: "invalid-closure" }));
  });

  it("rejects duplicate export object identities and preserves the prior store on failed restore", () => {
    const store = artifactStore();
    commitOne(store, "broker_existing", "blob_existing", bytes("existing"), { versionId: "version_existing" });
    const exported = store.exportClosure(["version_existing"]);
    exported.objects.push({ ...exported.objects[0], bytes: new Uint8Array(exported.objects[0].bytes) });
    expect(() => decodeArtifactExport(exported)).toThrowError(expect.objectContaining({ code: "duplicate-id" }));

    const corrupt = store.exportClosure(["version_existing"]);
    corrupt.objects[0].bytes[0] ^= 0xff;
    const authorization = brokerFor(store).authorizeClosureImport(corrupt.manifest);
    expect(() => store.restoreClosure(authorization, corrupt)).toThrowError(expect.objectContaining({ code: "hash-mismatch" }));
    expect(store.getArtifact("version_existing")).not.toBeNull();
  });

  it("decodes transfer envelopes only when metadata and bytes match broker evidence", () => {
    const store = artifactStore();
    const broker = brokerFor(store);
    const data = bytes("safe");
    const blobDescriptor = descriptor(data);
    broker.registerTransfer({
      transferId: "broker_decode",
      blobId: "blob_decode",
      descriptor: blobDescriptor,
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    });
    const envelope = {
      schema: "prime.artifact-transfer/v1",
      transferId: "broker_decode",
      blobId: "blob_decode",
      descriptor: blobDescriptor,
      references: [],
      bytes: Array.from(data),
    };

    const decoded = decodeTransferEnvelope(envelope, broker);
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.bytes)).toEqual(Array.from(data));
    expect(() => decodeTransferEnvelope({ ...envelope, blobId: "blob_other" }, broker)).toThrowError(
      expect.objectContaining({ code: "provenance-mismatch" }),
    );
    expect(() => decodeTransferEnvelope({ ...envelope, transferId: "C:\\temp\\blob" }, broker)).toThrowError(
      expect.objectContaining({ code: "invalid-broker-id" }),
    );
    expect(() => decodeTransferEnvelope({ ...envelope, bytes: [256] }, broker)).toThrowError(
      expect.objectContaining({ code: "unsafe-number" }),
    );
  });

  it("snapshots hostile array lengths once before decoding references and bytes", () => {
    const broker = testHarness().createBroker();
    const data = bytes("safe");
    const childData = bytes("child");
    const reference = rootReference("blob_child", childData);
    const registration = {
      transferId: "broker_array_snapshot",
      blobId: "blob_array_snapshot",
      descriptor: descriptor(data),
      references: [reference],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    } satisfies BrokerTransferRegistration;
    broker.registerTransfer(registration);

    let referenceLengthReads = 0;
    const references = new Proxy([reference], {
      get(target, property, receiver) {
        if (property === "length") {
          referenceLengthReads += 1;
          return referenceLengthReads === 1 ? 0 : Reflect.get(target, property, receiver);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() =>
      decodeTransferEnvelope(
        {
          schema: "prime.artifact-transfer/v1",
          transferId: registration.transferId,
          blobId: registration.blobId,
          descriptor: registration.descriptor,
          references,
          bytes: Array.from(data),
        },
        broker,
      ),
    ).toThrowError(expect.objectContaining({ code: "provenance-mismatch" }));
    expect(referenceLengthReads).toBeLessThanOrEqual(1);

    let byteLengthReads = 0;
    const encodedBytes = new Proxy(Array.from(data), {
      get(target, property, receiver) {
        if (property === "length") {
          byteLengthReads += 1;
          return byteLengthReads === 1 ? 1 : Reflect.get(target, property, receiver);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() =>
      decodeTransferEnvelope(
        {
          schema: "prime.artifact-transfer/v1",
          transferId: registration.transferId,
          blobId: registration.blobId,
          descriptor: registration.descriptor,
          references: registration.references,
          bytes: encodedBytes,
        },
        broker,
      ),
    ).toThrowError(expect.objectContaining({ code: "length-mismatch" }));
    expect(byteLengthReads).toBeLessThanOrEqual(1);
  });

  it("does not let a tagged array bypass descriptor-safe byte decoding", () => {
    const broker = testHarness().createBroker();
    const data = new Uint8Array([0]);
    const registration = {
      transferId: "broker_tagged_byte_array",
      blobId: "blob_tagged_byte_array",
      descriptor: descriptor(data),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    } satisfies BrokerTransferRegistration;
    broker.registerTransfer(registration);
    let getterReads = 0;
    const taggedBytes = [0];
    Object.defineProperty(taggedBytes, Symbol.toStringTag, { value: "Uint8Array" });
    Object.defineProperty(taggedBytes, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return 0;
      },
    });

    expect(() =>
      decodeTransferEnvelope(
        {
          schema: "prime.artifact-transfer/v1",
          transferId: registration.transferId,
          blobId: registration.blobId,
          descriptor: registration.descriptor,
          references: registration.references,
          bytes: taggedBytes,
        },
        broker,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
    expect(getterReads).toBe(0);
  });

  it("rejects tag-spoofed non-byte views without invoking their accessors", () => {
    const broker = testHarness().createBroker();
    const data = new Uint8Array([0]);
    const registration = {
      transferId: "broker_spoofed_byte_view",
      blobId: "blob_spoofed_byte_view",
      descriptor: descriptor(data),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    } satisfies BrokerTransferRegistration;
    broker.registerTransfer(registration);

    for (const spoofedView of [new DataView(new ArrayBuffer(1)), new Uint16Array([0])]) {
      let accessorReads = 0;
      Object.defineProperty(spoofedView, Symbol.toStringTag, {
        configurable: true,
        get() {
          accessorReads += 1;
          return "Uint8Array";
        },
      });
      Object.defineProperty(spoofedView, "length", {
        configurable: true,
        get() {
          accessorReads += 1;
          return 1;
        },
      });

      expect(() =>
        decodeTransferEnvelope(
          {
            schema: "prime.artifact-transfer/v1",
            transferId: registration.transferId,
            blobId: registration.blobId,
            descriptor: registration.descriptor,
            references: registration.references,
            bytes: spoofedView,
          },
          broker,
        ),
      ).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
      expect(accessorReads).toBe(0);
    }

    let genuineAccessorReads = 0;
    const genuineBytes = new Uint8Array([0]);
    Object.defineProperty(genuineBytes, Symbol.toStringTag, {
      configurable: true,
      get() {
        genuineAccessorReads += 1;
        return "Uint8Array";
      },
    });
    Object.defineProperty(genuineBytes, "length", {
      configurable: true,
      get() {
        genuineAccessorReads += 1;
        return 1;
      },
    });
    expect(
      decodeTransferEnvelope(
        {
          schema: "prime.artifact-transfer/v1",
          transferId: registration.transferId,
          blobId: registration.blobId,
          descriptor: registration.descriptor,
          references: registration.references,
          bytes: genuineBytes,
        },
        broker,
      ).bytes[0],
    ).toBe(0);
    expect(genuineAccessorReads).toBe(0);
  });

  it(HEAP_PROBE_TEST_NAME, () => {
    if (process.env[HEAP_PROBE_ENVIRONMENT_KEY] === "1") {
      const broker = testHarness().createBroker();
      const blobDescriptor: BlobDescriptor = {
        byteLength: RUNTIME_BYTE_ARRAY_CAP,
        sha256: EXACT_CAP_ZERO_SHA256,
        mediaType: "application/octet-stream",
        schema: "bytes/v1",
      };
      const registration = {
        transferId: "broker_exact_cap_heap_probe",
        blobId: "blob_exact_cap_heap_probe",
        descriptor: blobDescriptor,
        references: [],
        binding: transferBinding(),
        expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
      } satisfies BrokerTransferRegistration;
      broker.registerTransfer(registration);
      let nextDescriptorIndex = 0;
      const exactCapBytes = new Proxy(new Array<number>(RUNTIME_BYTE_ARRAY_CAP), {
        getOwnPropertyDescriptor(_target, property) {
          if (property !== String(nextDescriptorIndex)) throw new Error("byte descriptors were not read once in order");
          nextDescriptorIndex += 1;
          return { value: 0, writable: true, enumerable: true, configurable: true };
        },
      });
      const decoded = decodeTransferEnvelope(
        {
          schema: "prime.artifact-transfer/v1",
          transferId: registration.transferId,
          blobId: registration.blobId,
          descriptor: registration.descriptor,
          references: registration.references,
          bytes: exactCapBytes,
        },
        broker,
      );
      expect(decoded.bytes).toBeInstanceOf(Uint8Array);
      expect(decoded.bytes).toHaveLength(RUNTIME_BYTE_ARRAY_CAP);
      expect(decoded.bytes[0]).toBe(0);
      expect(decoded.bytes[RUNTIME_BYTE_ARRAY_CAP - 1]).toBe(0);
      expect(nextDescriptorIndex).toBe(RUNTIME_BYTE_ARRAY_CAP);

      let descriptorReads = 0;
      const overCapBytes = new Proxy(new Array<number>(RUNTIME_BYTE_ARRAY_CAP + 1), {
        getOwnPropertyDescriptor(target, property) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      expect(() =>
        decodeTransferEnvelope(
          {
            schema: "prime.artifact-transfer/v1",
            transferId: registration.transferId,
            blobId: registration.blobId,
            descriptor: registration.descriptor,
            references: registration.references,
            bytes: overCapBytes,
          },
          broker,
        ),
      ).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
      expect(descriptorReads).toBe(0);
      return;
    }

    const vitestEntry = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        vitestEntry,
        "run",
        "src/artifactDomain.test.ts",
        "--pool=threads",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "-t",
        HEAP_PROBE_TEST_NAME,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, [HEAP_PROBE_ENVIRONMENT_KEY]: "1" },
        timeout: 300_000,
      },
    );
    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.status, diagnostics).toBe(0);
  }, 300_000);

  it("snapshots every manifest/export array and rejects cap+1 before item reads", () => {
    const store = artifactStore();
    commitOne(store, "broker_array_export", "blob_array_export", bytes("export"), {
      versionId: "version_array_export",
    });
    const exported = store.exportClosure(["version_array_export"]);

    for (const key of ["rootArtifactVersionIds", "artifacts", "blobs"] as const) {
      let lengthReads = 0;
      const source = exported.manifest[key];
      const view = new Proxy([...source], {
        get(target, property, receiver) {
          if (property === "length") {
            lengthReads += 1;
            return lengthReads === 1 ? 0 : Reflect.get(target, property, receiver);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      expect(() =>
        decodeArtifactExport({
          ...exported,
          manifest: { ...exported.manifest, [key]: view },
        }),
      ).toThrowError(ArtifactDomainError);
      expect(lengthReads).toBeLessThanOrEqual(1);
    }

    let objectLengthReads = 0;
    const objectView = new Proxy([...exported.objects], {
      get(target, property, receiver) {
        if (property === "length") {
          objectLengthReads += 1;
          return objectLengthReads === 1 ? 0 : Reflect.get(target, property, receiver);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => decodeArtifactExport({ ...exported, objects: objectView })).toThrowError(
      expect.objectContaining({ code: "missing-blob" }),
    );
    expect(objectLengthReads).toBeLessThanOrEqual(1);

    const reference = rootReference("blob_cap", bytes("cap"));
    let itemReads = 0;
    const overCap = new Proxy(new Array(4_097).fill(reference), {
      getOwnPropertyDescriptor(target, property) {
        if (typeof property === "string" && /^\d+$/u.test(property)) itemReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() =>
      testHarness().createBroker().registerTransfer({
        transferId: "broker_reference_cap",
        blobId: "blob_reference_cap",
        descriptor: descriptor(bytes("payload")),
        references: overCap,
        binding: transferBinding(),
        expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe-input" }));
    expect(itemReads).toBe(0);
  });

  it("decodes transfer envelopes only during the exact live inbound broker phase", () => {
    const broker = testHarness().createBroker();
    const data = bytes("phase-bound envelope");
    const blobDescriptor = descriptor(data);
    const registration = {
      transferId: "broker_decode_phase",
      blobId: "blob_decode_phase",
      descriptor: blobDescriptor,
      references: [],
      binding: transferBinding(),
      expiresAtMs: 10,
    } satisfies BrokerTransferRegistration;
    const envelope = {
      schema: "prime.artifact-transfer/v1",
      transferId: registration.transferId,
      blobId: registration.blobId,
      descriptor: registration.descriptor,
      references: registration.references,
      bytes: Array.from(data),
    };
    broker.registerTransfer(registration);

    expect(decodeTransferEnvelope(envelope, broker).transferId).toBe(registration.transferId);
    broker.authorizeArtifactCommit(registration.transferId);
    expect(() => decodeTransferEnvelope(envelope, broker)).toThrowError(
      expect.objectContaining({ code: "transfer-state" }),
    );
    broker.authorizeTransferAck(registration.transferId, "version_decode_phase");
    expect(() => decodeTransferEnvelope(envelope, broker)).toThrowError(
      expect.objectContaining({ code: "transfer-state" }),
    );

    const revoked = { ...registration, transferId: "broker_decode_revoked" };
    const revokedEnvelope = { ...envelope, transferId: revoked.transferId };
    broker.registerTransfer(revoked);
    broker.revokeTransfer(revoked.transferId);
    expect(() => decodeTransferEnvelope(revokedEnvelope, broker)).toThrowError(
      expect.objectContaining({ code: "transfer-state" }),
    );

    const expired = { ...registration, transferId: "broker_decode_expired", expiresAtMs: 5 };
    const expiredEnvelope = { ...envelope, transferId: expired.transferId };
    broker.registerTransfer(expired);
    broker.advanceTimeTo(5);
    expect(() => decodeTransferEnvelope(expiredEnvelope, broker)).toThrowError(
      expect.objectContaining({ code: "transfer-not-found" }),
    );
  });

  it("orders artifact identities by deterministic UTF-8 bytes without locale hooks", () => {
    const store = artifactStore();
    commitOne(store, "broker_sort_Z", "blob_sort_Z", bytes("uppercase"), { versionId: "version_Z" });
    commitOne(store, "broker_sort_a", "blob_sort_a", bytes("lowercase"), { versionId: "version_a" });
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("artifact canonicalization must not consult localeCompare");
    });

    try {
      expect(store.listArtifacts().map((artifact) => artifact.versionId)).toEqual(["version_Z", "version_a"]);
      expect(() => serializeArtifactExport(store.exportClosure(["version_a", "version_Z"]))).not.toThrow();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("serializes the same closure identically regardless of transfer insertion order", () => {
    const build = (reverse: boolean): string => {
      const store = artifactStore();
      const childData = bytes("child");
      const rootData = bytes("root");
      const childReference = rootReference("blob_order_child", childData);
      if (reverse) {
        stageBlob(store, "broker_order_root", "blob_order_root", rootData, [childReference]);
        store.promoteTransfer("broker_order_root");
        stageBlob(store, "broker_order_child", "blob_order_child", childData);
        store.promoteTransfer("broker_order_child");
      } else {
        stageBlob(store, "broker_order_child", "blob_order_child", childData);
        store.promoteTransfer("broker_order_child");
        stageBlob(store, "broker_order_root", "blob_order_root", rootData, [childReference]);
        store.promoteTransfer("broker_order_root");
      }
      store.commitArtifact("broker_order_root", artifactDraft("version_order", rootReference("blob_order_root", rootData)));
      return serializeArtifactExport(store.exportClosure(["version_order"]));
    };

    expect(build(true)).toBe(build(false));
  });

  it("keeps returned bytes detached from the immutable store", () => {
    const store = artifactStore();
    const data = bytes("immutable");
    commitOne(store, "broker_immutable", "blob_immutable", data, { versionId: "version_immutable" });
    const snapshot = store.getBlob("blob_immutable");
    if (!snapshot) throw new Error("test fixture did not contain blob");
    expect(snapshot.bytes).toBeInstanceOf(Uint8Array);
    snapshot.bytes[0] ^= 0xff;

    expect(Array.from(store.getBlob("blob_immutable")?.bytes ?? [])).toEqual(Array.from(data));
  });

  it("rejects path-like broker IDs, unsafe broker registrations, and non-canonical presentation paths", () => {
    const store = artifactStore();
    const broker = brokerFor(store);
    const data = bytes("safe");
    for (const transferId of ["..", "C:\\spool\\blob", "\\\\server\\share", "spool/../blob"]) {
      expect(() => broker.registerTransfer({
        transferId,
        blobId: "blob_safe",
        descriptor: descriptor(data),
        references: [],
        binding: transferBinding(),
        expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
      })).toThrowError(expect.objectContaining({ code: "invalid-broker-id" }));
    }

    const staged = stageBlob(store, "broker_path", "blob_path", data);
    store.promoteTransfer("broker_path");
    for (const presentationPath of ["/absolute.bin", "..\\escape.bin", "reports/../escape.bin", "reports//file.bin", "reports/."]) {
      expect(() => store.commitArtifact("broker_path", artifactDraft("version_" + presentationPath.length, staged.reference, { presentationPath }))).toThrowError(
        expect.objectContaining({ code: "invalid-path" }),
      );
    }
  });

  it("rejects unsafe numeric and digest values at the broker boundary", () => {
    const store = artifactStore();
    const broker = brokerFor(store);
    const data = bytes("safe");
    expect(() => broker.registerTransfer({
      transferId: "broker_unsafe_number",
      blobId: "blob_unsafe_number",
      descriptor: descriptor(data, { byteLength: Number.MAX_SAFE_INTEGER + 1 }),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    })).toThrowError(expect.objectContaining({ code: "unsafe-number" }));
    expect(() => broker.registerTransfer({
      transferId: "broker_digest",
      blobId: "blob_digest",
      descriptor: descriptor(data, { sha256: "not-a-sha" }),
      references: [],
      binding: transferBinding(),
      expiresAtMs: DEFAULT_TRANSFER_EXPIRY_MS,
    })).toThrowError(expect.objectContaining({ code: "invalid-digest" }));
  });

  it("exposes typed domain failures rather than generic runtime errors", () => {
    const error = new ArtifactDomainError("invalid-path", "path rejected");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("invalid-path");
    expect(error.message).toBe("path rejected");
  });
});

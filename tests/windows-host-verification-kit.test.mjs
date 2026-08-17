import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const paths = Object.freeze({
  schema: new URL("../docs/windows-host-preflight.schema.json", import.meta.url),
  guide: new URL("../docs/windows-host-verification.md", import.meta.url),
  review: new URL("../docs/windows-host-review-template.md", import.meta.url),
  module: new URL("../app/scripts/windows-host-verification/WindowsHostVerification.psm1", import.meta.url),
  collect: new URL("../app/scripts/windows-host-verification/Collect-WindowsHostPreflight.ps1", import.meta.url),
  bundle: new URL("../app/scripts/windows-host-verification/New-WindowsHostEvidenceBundle.ps1", import.meta.url),
  selfTest: new URL("../app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1", import.meta.url),
});

async function text(url) {
  return readFile(url, "utf8");
}

test("preflight schema is fail-closed for every external authority", async () => {
  const schema = JSON.parse(await text(paths.schema));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.classification.const, "HOST_COLLECTED_UNREVIEWED");
  assert.equal(schema.properties.reviewState.const, "HOST_COLLECTED_UNREVIEWED");
  assert.equal(schema.properties.releaseEligible.const, false);

  const claims = schema.$defs.claims.properties;
  assert.deepEqual(
    Object.keys(claims),
    [
      "sourceBuild",
      "exactPrimeClosure",
      "activation",
      "providerSession",
      "interactionWorker",
      "installerSigning",
      "releaseAuthority",
    ],
  );
  for (const key of Object.keys(claims).filter((key) => key !== "sourceBuild")) {
    assert.equal(claims[key].const, "NOT_ATTESTED", `${key} was not fixed to NOT_ATTESTED`);
  }

  assert.deepEqual(
    schema.$defs.identityFile.properties.path.enum,
    [
      "app/package.json",
      "app/package-lock.json",
      "app/src-tauri/Cargo.toml",
      "app/src-tauri/Cargo.lock",
      "app/src-tauri/tauri.conf.json",
      "rust-toolchain.toml",
    ],
  );
  assert.equal(schema.$defs.sourceIdentity.properties.identityFiles.minItems, 6);
  assert.equal(schema.$defs.sourceIdentity.properties.identityFiles.maxItems, 6);
});

test("collector and bundler expose only the reviewed bounded surface", async () => {
  const [moduleSource, collectSource, bundleSource, selfTestSource] = await Promise.all([
    text(paths.module),
    text(paths.collect),
    text(paths.bundle),
    text(paths.selfTest),
  ]);

  for (const source of [moduleSource, collectSource, bundleSource, selfTestSource]) {
    assert.match(source, /HOST_COLLECTED_UNREVIEWED/u);
    assert.doesNotMatch(source, /Get-ChildItem\s+Env:/iu);
    assert.doesNotMatch(source, /cmdkey|CredentialManager|Windows\.Security\.Credentials/iu);
  }

  assert.match(moduleSource, /MaxEvidenceFileBytes\s*=\s*2\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(moduleSource, /MaxEvidenceBundleBytes\s*=\s*32\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(moduleSource, /AllowedEvidenceExtensions\s*=\s*@\('\.txt', '\.json', '\.xml', '\.csv', '\.md', '\.log'\)/u);
  for (const exclusion of ["reparse_point", "extension_not_allowed", "file_too_large", "binary_content", "bundle_budget_exceeded"]) {
    assert.match(moduleSource, new RegExp(`['\"]${exclusion}['\"]`, "u"));
  }
  for (const marker of [
    "<REPOSITORY_ROOT>",
    "<USER_PROFILE>",
    "<TEMP>",
    "<REDACTED_GITHUB_TOKEN>",
    "<REDACTED_PROVIDER_KEY>",
    "<REDACTED_SLACK_TOKEN>",
    "<REDACTED_JWT>",
    "<EMAIL_REDACTED>",
  ]) {
    assert.ok(moduleSource.includes(marker), `missing redaction marker ${marker}`);
  }

  assert.match(collectSource, /Invoke-WindowsHostPreflightCollection/u);
  assert.match(bundleSource, /New-WindowsHostEvidenceBundle/u);
  assert.match(selfTestSource, /Management\.Automation\.Language\.Parser/u);
  assert.match(selfTestSource, /Bundle manifests were not deterministic/u);
  assert.match(selfTestSource, /Binary content was not excluded/u);
});

test("documentation keeps collection, review, effects, signing, and release separate", async () => {
  const [guide, review] = await Promise.all([text(paths.guide), text(paths.review)]);
  for (const document of [guide, review]) {
    assert.match(document, /HOST_COLLECTED_UNREVIEWED/u);
    assert.match(document, /exact Prime closure/iu);
    assert.match(document, /provider/iu);
    assert.match(document, /interaction worker/iu);
    assert.match(document, /signing/iu);
    assert.match(document, /release authori/iu);
  }

  assert.match(guide, /does\s+not attest the user's machine/iu);
  assert.match(guide, /includes only `\.txt`, `\.json`, `\.xml`, `\.csv`, `\.md`, and `\.log`/u);
  assert.match(guide, /fails or times out, the script writes the failed evidence and exits non-zero/iu);
  assert.match(review, /HOST_REVIEWED_NOT_RELEASED/u);
  assert.match(review, /A successful `--version` probe alone is insufficient/u);
  assert.match(review, /Admission-only source contracts or deterministic fixtures\s+cannot satisfy this section/u);
  assert.match(review, /does not authorize publication/u);
});

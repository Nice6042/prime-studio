import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const manifest = JSON.parse(read("docs/open-source-release-readiness.manifest.json"));

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.scope, "source-only-bootstrap");
assert.equal(manifest.sourcePublication.authorization, "user-requested");
assert.equal(manifest.sourcePublication.status, "conditional");
assert.deepEqual(manifest.sourcePublication.requiredHistoryShape, {
  rootCommits: 1,
  totalCommits: 1,
  defaultBranch: "main",
  tags: 0,
  remotesBeforePush: 0,
  sharedObjectStores: false,
});
assert.equal(manifest.sourcePublication.contributionIntake, "closed-until-maintainers-appointed");
assert.equal(manifest.sourcePublication.issues, "disabled-until-maintainers-appointed");
assert.equal(manifest.sourcePublication.discussions, "disabled");
assert.equal(manifest.sourcePublication.pages, "disabled");

for (const [surface, state] of Object.entries(manifest.distribution)) {
  if (surface === "signing") {
    assert.equal(state, "not-configured");
  } else {
    assert.equal(state, "blocked", `${surface} must remain blocked`);
  }
}

assert.equal(manifest.security.privateDevelopmentHistory, "excluded");
assert.equal(manifest.security.privateHistoryEvidence, "stored-outside-public-git");
for (const requirement of [
  "twoFactorAuthentication",
  "secretScanning",
  "pushProtection",
  "dependabotAlerts",
  "privateVulnerabilityReporting",
]) {
  assert.equal(manifest.security[requirement], "required", `${requirement} must be required`);
}

assert.equal(manifest.provenance.project.id, "prime-studio");
assert.equal(manifest.provenance.project.licenseExpression, "MIT");
assert.equal(
  manifest.provenance.project.copyrightNotice,
  "Copyright (c) 2026 Prime Studio Contributors",
);
for (const path of [
  "LICENSE",
  "AUTHORS",
  "SECURITY.md",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "THIRD_PARTY_NOTICES.md",
  manifest.provenance.sbom,
]) {
  assert.equal(existsSync(resolve(root, path)), true, `missing public policy artifact: ${path}`);
}

const workflows = `${read(".github/workflows/ci.yml")}\n${read(".github/workflows/security.yml")}`;
assert.doesNotMatch(
  workflows,
  /pull_request_target|actions\/upload-artifact|actions\/deploy-pages|gh\s+release\s+create|npm\s+publish/i,
);
assert.match(read("README.md"), /not a working Prime desktop client/i);

console.log("Source-only bootstrap policy is conditional; all binary distribution surfaces remain blocked.");

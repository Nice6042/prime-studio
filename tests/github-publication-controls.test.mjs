import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_CHECKS,
  auditPublicationDocuments,
  validateCleanRoomFacts,
  validateRemoteSnapshot,
  validateWorkflowSources,
} from "../scripts/validate-github-publication-controls.mjs";

const repositoryRoot = new URL("../", import.meta.url);

test("required checks exactly match every pull-request CI job", () => {
  assert.deepEqual(REQUIRED_CHECKS, [
    "Source policy and acceptance",
    "Frontend checks",
    "Strict browser shell",
    "Rust checks (Windows)",
    "npm audit",
    "Locked dependency policy",
    "Dependency review",
  ]);
});

test("workflows are read-only, SHA-pinned, and avoid pull_request_target", async () => {
  assert.deepEqual(await validateWorkflowSources(repositoryRoot), []);
});

test("the offline Windows SBOM check runs after Cargo has populated its locked graph", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const frontend = workflow.slice(workflow.indexOf("  frontend:"), workflow.indexOf("  browser-shell:"));
  const rust = workflow.slice(workflow.indexOf("  rust-windows:"));
  assert.doesNotMatch(frontend, /third-party-artifacts/u);
  assert.ok(rust.indexOf("cargo test") < rust.indexOf("third-party-artifacts"));
});

test("workflow validation rejects publication and artifact upload steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-studio-workflow-policy-"));
  try {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "release.yml"),
      `name: Release\n+on:\n+  pull_request:\n+permissions:\n+  contents: read\n+jobs:\n+  release:\n+    name: Source policy and acceptance\n+    runs-on: ubuntu-latest\n+    steps:\n+      - uses: actions/upload-artifact@${"a".repeat(40)}\n+`,
    );
    const findings = await validateWorkflowSources(root, {
      expectedChecks: ["Source policy and acceptance"],
    });
    assert.ok(findings.some((item) => item.id === "distribution-workflow"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the source audit has no known publication-document contradictions", async () => {
  const findingIds = (await auditPublicationDocuments(repositoryRoot)).map(
    (finding) => finding.id,
  );
  assert.deepEqual(findingIds, []);
});

test("clean-room facts require a standalone untagged one-commit object store", () => {
  const compliant = {
    rootCount: 1,
    commitCount: 1,
    shallow: false,
    sharedObjectStore: false,
    alternates: false,
    partialCloneConfiguration: "",
    tags: [],
    dirty: false,
  };
  assert.deepEqual(validateCleanRoomFacts(compliant), []);
  assert.deepEqual(
    validateCleanRoomFacts({
      ...compliant,
      sharedObjectStore: true,
      tags: ["v0.1.0"],
      partialCloneConfiguration: "remote.origin.promisor true",
    }).map((item) => item.id),
    ["shared-object-store", "partial-clone", "source-tags"],
  );
});

function compliantRemoteSnapshot() {
  return {
    maintainerCount: 1,
    repository: {
      private: false,
      default_branch: "main",
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      has_issues: false,
      has_discussions: false,
      has_pages: false,
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
      },
    },
    actions: {
      enabled: true,
      sha_pinning_required: true,
    },
    workflowPermissions: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
    forkApprovals: {
      approval_policy: "all_external_contributors",
    },
    rulesets: [
      {
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "required_linear_history" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 0,
              required_review_thread_resolution: true,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: REQUIRED_CHECKS.map((context) => ({ context })),
            },
          },
        ],
      },
    ],
    vulnerabilityAlertsEnabled: true,
    dependabotSecurityUpdatesEnabled: true,
    privateVulnerabilityReporting: { enabled: true },
    releases: [],
    pagesEnabled: false,
  };
}

test("a hardened solo-maintainer repository snapshot passes automated checks", () => {
  assert.deepEqual(validateRemoteSnapshot(compliantRemoteSnapshot()), []);
});

test("approval count is zero for one maintainer and one after a second is added", () => {
  const solo = compliantRemoteSnapshot();
  solo.rulesets[0].rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.required_approving_review_count = 1;
  assert.ok(
    validateRemoteSnapshot(solo).some(
      (finding) => finding.id === "required-approval-count",
    ),
  );

  const staffed = compliantRemoteSnapshot();
  staffed.maintainerCount = 2;
  assert.ok(
    validateRemoteSnapshot(staffed).some(
      (finding) => finding.id === "required-approval-count",
    ),
  );
});

test("remote validation rejects mutable actions and missing security controls", () => {
  const snapshot = compliantRemoteSnapshot();
  snapshot.actions.sha_pinning_required = false;
  snapshot.repository.security_and_analysis.secret_scanning.status = "disabled";
  snapshot.privateVulnerabilityReporting.enabled = false;
  snapshot.releases.push({ id: 1 });
  snapshot.repository.has_issues = true;

  assert.deepEqual(
    validateRemoteSnapshot(snapshot)
      .map((finding) => finding.id)
      .filter((id) =>
        [
          "action-sha-policy",
          "secret-scanning",
          "private-vulnerability-reporting",
          "release-assets",
          "intake-surfaces",
        ].includes(id),
      ),
    [
      "intake-surfaces",
      "action-sha-policy",
      "secret-scanning",
      "private-vulnerability-reporting",
      "release-assets",
    ],
  );
});

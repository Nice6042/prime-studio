import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const REQUIRED_CHECKS = Object.freeze([
  "Source policy and acceptance",
  "Frontend checks",
  "Strict browser shell",
  "Rust checks (Windows)",
  "npm audit",
  "Locked dependency policy",
  "Dependency review",
]);

const API_VERSION = "2026-03-10";

const finding = (id, message) => ({ id, message });

const asRootPath = (root) =>
  root instanceof URL ? fileURLToPath(root) : path.resolve(root);

const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));

export async function validateWorkflowSources(
  root,
  { expectedChecks = REQUIRED_CHECKS } = {},
) {
  const rootPath = asRootPath(root);
  const workflowDirectory = path.join(rootPath, ".github", "workflows");
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  const findings = [];
  const jobNames = [];

  for (const name of workflowFiles) {
    const source = await readFile(path.join(workflowDirectory, name), "utf8");
    if (/^\s*pull_request_target\s*:/mu.test(source)) {
      findings.push(finding("pull-request-target", `${name} uses pull_request_target`));
    }
    if (
      /(?:actions\/(?:upload-artifact|upload-pages-artifact|deploy-pages)@|\bgh\s+release\b|\bnpm\s+publish\b|\bcargo\s+publish\b|\bdocker\s+push\b)/u.test(
        source,
      )
    ) {
      findings.push(
        finding("distribution-workflow", `${name} contains a publishing or artifact-upload step`),
      );
    }
    if (!/^permissions:\r?\n\s{2}contents:\s*read\s*$/mu.test(source)) {
      findings.push(
        finding("workflow-permissions", `${name} must declare only contents: read`),
      );
    }

    for (const match of source.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+).*$/gmu)) {
      if (!/^[0-9a-f]{40}$/u.test(match[1])) {
        findings.push(
          finding("mutable-action", `${name} has a non-SHA action reference: ${match[0].trim()}`),
        );
      }
    }
    for (const match of source.matchAll(/^\s{4}name:\s*(.+?)\s*$/gmu)) {
      jobNames.push(match[1]);
    }
  }

  if (JSON.stringify(sorted(jobNames)) !== JSON.stringify(sorted(expectedChecks))) {
    findings.push(
      finding(
        "required-check-drift",
        `pull-request job names are ${JSON.stringify(jobNames)}, expected ${JSON.stringify(expectedChecks)}`,
      ),
    );
  }
  return findings;
}

async function read(rootPath, relativePath) {
  return readFile(path.join(rootPath, relativePath), "utf8");
}

export async function auditPublicationDocuments(root) {
  const rootPath = asRootPath(root);
  const [
    readme,
    maintainers,
    governance,
    releasing,
    manifestSource,
    npmSource,
    cargoSource,
  ] = await Promise.all([
      read(rootPath, "README.md"),
      read(rootPath, "MAINTAINERS.md"),
      read(rootPath, "GOVERNANCE.md"),
      read(rootPath, "RELEASING.md"),
      read(rootPath, "docs/open-source-release-readiness.manifest.json"),
      read(rootPath, "app/package.json"),
      read(rootPath, "app/src-tauri/Cargo.toml"),
    ]);
  const manifest = JSON.parse(manifestSource);
  const npmPackage = JSON.parse(npmSource);
  const packageIdentityCorrected =
    npmPackage.name === "prime-studio" &&
    npmPackage.author === "Prime Studio Contributors" &&
    npmPackage.license === "MIT" &&
    /^name\s*=\s*"prime-studio"$/mu.test(cargoSource) &&
    /^authors\s*=\s*\["Prime Studio Contributors"\]$/mu.test(cargoSource) &&
    /^license\s*=\s*"MIT"$/mu.test(cargoSource);
  const findings = [];

  if (
    existsSync(path.join(rootPath, "AUTHORS")) &&
    /No `AUTHORS` file is\s+published/u.test(`${readme}\n${maintainers}`)
  ) {
    findings.push(
      finding("authors-file-denied", "README.md or MAINTAINERS.md denies the tracked AUTHORS file"),
    );
  }
  if (packageIdentityCorrected && /scaffold or placeholder identity fields/u.test(readme)) {
    findings.push(
      finding("package-identity-stale", "README.md calls corrected package identity a placeholder"),
    );
  }
  if (
    packageIdentityCorrected &&
    /root license notice and package-manifest identity fields remain unresolved/u.test(releasing)
  ) {
    findings.push(
      finding("release-metadata-stale", "RELEASING.md contradicts LICENSE and package manifests"),
    );
  }

  if (
    manifest.scope !== "source-only-bootstrap" ||
    manifest.sourcePublication?.authorization !== "user-requested" ||
    Object.entries(manifest.distribution ?? {}).some(
      ([key, value]) => key !== "signing" && value !== "blocked",
    )
  ) {
    findings.push(
      finding(
        "readiness-manifest-boundary",
        "source bootstrap must be explicit while every binary distribution surface remains blocked",
      ),
    );
  }

  if (
    /No public maintainer identity/u.test(maintainers) &&
    /any public source or binary release/u.test(governance) &&
    /at least two approvals/u.test(governance)
  ) {
    findings.push(
      finding(
        "governance-bootstrap-impossible",
        "all roles are vacant while public-source publication requires two role-bearing approvals",
      ),
    );
  }
  return findings;
}

function ruleByType(ruleset, type) {
  return ruleset?.rules?.find((rule) => rule.type === type);
}

export function validateRemoteSnapshot(snapshot) {
  const findings = [];
  const repository = snapshot.repository ?? {};
  if (repository.private !== false || repository.default_branch !== "main") {
    findings.push(finding("repository-identity", "repository must be public with main as default"));
  }
  if (
    repository.allow_squash_merge !== true ||
    repository.allow_merge_commit !== false ||
    repository.allow_rebase_merge !== false
  ) {
    findings.push(finding("merge-policy", "allow squash merge only"));
  }
  if (repository.has_issues !== false || repository.has_discussions !== false) {
    findings.push(
      finding("intake-surfaces", "Issues and Discussions must remain disabled during bootstrap"),
    );
  }

  const ruleset = snapshot.rulesets?.find(
    (candidate) =>
      candidate.target === "branch" &&
      candidate.enforcement === "active" &&
      candidate.conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH"),
  );
  if (!ruleset) {
    findings.push(finding("main-ruleset", "no active default-branch ruleset was found"));
  } else {
    for (const [type, id, label] of [
      ["deletion", "deletion-protection", "restrict deletions"],
      ["non_fast_forward", "force-push-protection", "block force pushes"],
      ["required_linear_history", "linear-history", "require linear history"],
    ]) {
      if (!ruleByType(ruleset, type)) findings.push(finding(id, `main ruleset must ${label}`));
    }
    if ((ruleset.bypass_actors ?? []).length !== 0) {
      findings.push(finding("ruleset-bypass", "main ruleset must have no bypass actors"));
    }

    const pullRequest = ruleByType(ruleset, "pull_request");
    if (!pullRequest) {
      findings.push(finding("pull-request-rule", "main must require pull requests"));
    } else {
      const expectedApprovals = snapshot.maintainerCount >= 2 ? 1 : 0;
      if (pullRequest.parameters?.required_approving_review_count !== expectedApprovals) {
        findings.push(
          finding(
            "required-approval-count",
            `required approvals must be ${expectedApprovals} for ${snapshot.maintainerCount} maintainer(s)`,
          ),
        );
      }
      if (pullRequest.parameters?.required_review_thread_resolution !== true) {
        findings.push(
          finding("conversation-resolution", "main must require conversation resolution"),
        );
      }
    }

    const statusRule = ruleByType(ruleset, "required_status_checks");
    const actualChecks =
      statusRule?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
    if (JSON.stringify(sorted(actualChecks)) !== JSON.stringify(sorted(REQUIRED_CHECKS))) {
      findings.push(
        finding(
          "required-status-checks",
          `required checks must exactly equal ${JSON.stringify(REQUIRED_CHECKS)}`,
        ),
      );
    }
    if (statusRule?.parameters?.strict_required_status_checks_policy !== true) {
      findings.push(finding("strict-status-checks", "required checks must use strict mode"));
    }
  }

  if (snapshot.actions?.enabled !== true) {
    findings.push(finding("actions-disabled", "GitHub Actions must be enabled"));
  }
  if (snapshot.actions?.sha_pinning_required !== true) {
    findings.push(finding("action-sha-policy", "repository must require full action SHAs"));
  }
  if (
    snapshot.workflowPermissions?.default_workflow_permissions !== "read" ||
    snapshot.workflowPermissions?.can_approve_pull_request_reviews !== false
  ) {
    findings.push(
      finding("workflow-token", "GITHUB_TOKEN must be read-only and unable to approve pull requests"),
    );
  }
  if (snapshot.forkApprovals?.approval_policy !== "all_external_contributors") {
    findings.push(
      finding("fork-approvals", "all external contributors must require workflow approval"),
    );
  }
  if (repository.security_and_analysis?.secret_scanning?.status !== "enabled") {
    findings.push(finding("secret-scanning", "secret scanning must be enabled"));
  }
  if (
    repository.security_and_analysis?.secret_scanning_push_protection?.status !== "enabled"
  ) {
    findings.push(finding("push-protection", "secret scanning push protection must be enabled"));
  }
  if (snapshot.vulnerabilityAlertsEnabled !== true) {
    findings.push(finding("dependabot-alerts", "Dependabot alerts must be enabled"));
  }
  if (snapshot.dependabotSecurityUpdatesEnabled !== true) {
    findings.push(finding("dependabot-security-updates", "Dependabot security updates must be enabled"));
  }
  if (snapshot.privateVulnerabilityReporting?.enabled !== true) {
    findings.push(
      finding("private-vulnerability-reporting", "private vulnerability reporting must be enabled"),
    );
  }
  if ((snapshot.releases ?? []).length !== 0) {
    findings.push(finding("release-assets", "repository must have no releases or release assets"));
  }
  if (repository.has_pages === true || snapshot.pagesEnabled === true) {
    findings.push(finding("pages", "GitHub Pages must remain disabled"));
  }
  return findings;
}

function git(rootPath, args) {
  return execFileSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOptional(rootPath, args) {
  const result = spawnSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

export function validateCleanRoomFacts(facts) {
  const findings = [];
  if (facts.rootCount !== 1 || facts.commitCount !== 1) {
    findings.push(
      finding(
        "clean-room-history",
        `publication source must be a standalone one-root, one-commit repository; found ${facts.rootCount} root(s), ${facts.commitCount} commit(s)`,
      ),
    );
  }
  if (facts.shallow) {
    findings.push(finding("shallow-repository", "publication source must not be shallow"));
  }
  if (facts.sharedObjectStore) {
    findings.push(
      finding("shared-object-store", "publication source must own its Git object store"),
    );
  }
  if (facts.alternates) {
    findings.push(finding("object-alternates", "publication source must not use object alternates"));
  }
  if (facts.partialCloneConfiguration !== "") {
    findings.push(finding("partial-clone", "publication source must not be partial or promisor-backed"));
  }
  if (facts.tags.length !== 0) {
    findings.push(finding("source-tags", "source-only publication must begin without tags"));
  }
  if (facts.dirty) {
    findings.push(finding("dirty-tree", "publication source worktree must be clean"));
  }
  return findings;
}

export function auditCleanRoom(root) {
  const rootPath = asRootPath(root);
  const roots = git(rootPath, ["rev-list", "--max-parents=0", "HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean);
  const gitDirectory = path.resolve(rootPath, git(rootPath, ["rev-parse", "--git-dir"]));
  const commonDirectory = path.resolve(
    rootPath,
    git(rootPath, ["rev-parse", "--git-common-dir"]),
  );
  const partialCloneConfiguration = gitOptional(rootPath, [
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor|remote\\..*\\.partialclonefilter)$",
  ]);
  return validateCleanRoomFacts({
    rootCount: roots.length,
    commitCount: Number(git(rootPath, ["rev-list", "--count", "HEAD"])),
    shallow: git(rootPath, ["rev-parse", "--is-shallow-repository"]) !== "false",
    sharedObjectStore:
      process.platform === "win32"
        ? gitDirectory.toLowerCase() !== commonDirectory.toLowerCase()
        : gitDirectory !== commonDirectory,
    alternates: existsSync(path.join(commonDirectory, "objects", "info", "alternates")),
    partialCloneConfiguration,
    tags: gitOptional(rootPath, ["tag", "--list"])
      .split(/\r?\n/u)
      .filter(Boolean),
    dirty: git(rootPath, ["status", "--porcelain=v1"]) !== "",
  });
}

function ghJson(endpoint) {
  const result = spawnSync(
    "gh",
    ["api", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`read-only GitHub GET failed for ${endpoint}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function ghEnabled(endpoint) {
  const result = spawnSync(
    "gh",
    ["api", "--silent", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0;
}

export function collectRemoteSnapshot(repositoryName, maintainerCount) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName)) {
    throw new Error("--repo must be OWNER/REPO");
  }
  const prefix = `repos/${repositoryName}`;
  const summaries = ghJson(`${prefix}/rulesets?includes_parents=true&targets=branch&per_page=100`);
  const rulesets = summaries.map((summary) =>
    ghJson(`${prefix}/rulesets/${summary.id}?includes_parents=true`),
  );
  const repository = ghJson(prefix);
  return {
    maintainerCount,
    repository,
    actions: ghJson(`${prefix}/actions/permissions`),
    workflowPermissions: ghJson(`${prefix}/actions/permissions/workflow`),
    forkApprovals: ghJson(`${prefix}/actions/permissions/fork-pr-contributor-approval`),
    rulesets,
    vulnerabilityAlertsEnabled: ghEnabled(`${prefix}/vulnerability-alerts`),
    dependabotSecurityUpdatesEnabled: ghEnabled(`${prefix}/automated-security-fixes`),
    privateVulnerabilityReporting: ghJson(`${prefix}/private-vulnerability-reporting`),
    releases: ghJson(`${prefix}/releases?per_page=1`),
    pagesEnabled: repository.has_pages === true,
  };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), repo: null, maintainers: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--repo") options.repo = argv[++index];
    else if (argument === "--maintainers") options.maintainers = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.maintainers) || options.maintainers < 1) {
    throw new Error("--maintainers must be a positive integer");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const findings = [
    ...(await validateWorkflowSources(options.root)),
    ...(await auditPublicationDocuments(options.root)),
    ...auditCleanRoom(options.root),
  ];
  if (options.repo) {
    findings.push(
      ...validateRemoteSnapshot(collectRemoteSnapshot(options.repo, options.maintainers)),
    );
  }
  const manual = [
    "Verify 2FA at GitHub Settings > Password and authentication; do not infer it from API access.",
    "Subscribe to repository Security alerts and enable account email/web security notifications.",
    "Confirm the repository Packages view is empty; the validator deliberately does not enumerate owner-wide packages.",
  ];
  if (options.json) console.log(JSON.stringify({ findings, manual }, null, 2));
  else {
    for (const item of findings) console.error(`BLOCK ${item.id}: ${item.message}`);
    for (const item of manual) console.log(`MANUAL: ${item}`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

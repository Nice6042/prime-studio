#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "x86_64-pc-windows-msvc";
const CREATED = "2026-08-10T00:00:00Z";
const SCAFFOLD = Object.freeze({
  name: "create-tauri-app",
  version: "4.6.2",
  commit: "d959db0f057aa4c1b9cc4ad7f030cffedf3e48a6",
  license: "MIT OR Apache-2.0",
  repository: "https://github.com/tauri-apps/create-tauri-app",
});
const PRIME_AGENT = Object.freeze({
  commit: "a18809e00ea30638584d87b3afea7285a9d7296c",
  license: "MIT",
  repository: "https://github.com/PrimeIntellect-ai/prime-agent",
  notices: [
    "Copyright (c) 2025 Mario Zechner",
    "Copyright (c) 2026 Prime Intellect",
  ],
});
const BUILD_DATA = Object.freeze({ name: "caniuse-lite", version: "1.0.30001809" });

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageLockPath = path.join(repositoryRoot, "app", "package-lock.json");
const cargoLockPath = path.join(repositoryRoot, "app", "src-tauri", "Cargo.lock");
const cargoManifestPath = path.join(repositoryRoot, "app", "src-tauri", "Cargo.toml");
const noticePath = path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const bundledNoticePath = path.join(
  repositoryRoot,
  "app",
  "public",
  "THIRD_PARTY_NOTICES.md",
);
const sbomPath = path.join(
  repositoryRoot,
  "sbom",
  "prime-studio-windows-x86_64.spdx.json",
);

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function spdxId(prefix, ...parts) {
  const readable = parts
    .join("-")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `SPDXRef-${prefix}-${readable}-${digest("sha1", parts.join("\0")).slice(0, 10)}`;
}

function normalizeLicense(expression) {
  const slashAlternatives = new Map([
    ["Apache-2.0 / MIT", "Apache-2.0 OR MIT"],
    ["BSD-3-Clause/MIT", "BSD-3-Clause OR MIT"],
    ["MIT/Apache-2.0", "MIT OR Apache-2.0"],
    ["Unlicense/MIT", "Unlicense OR MIT"],
  ]);
  return slashAlternatives.get(expression) ?? expression;
}

function validateLicense(expression, component) {
  const known = new Set([
    "0BSD",
    "Apache-2.0",
    "BSD-3-Clause",
    "CC-BY-4.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "Unicode-3.0",
    "Unlicense",
    "Zlib",
  ]);
  const identifiers = expression.match(/[A-Za-z0-9.-]+/g) ?? [];
  const unknown = identifiers.filter(
    (identifier) => !known.has(identifier) && identifier !== "AND" && identifier !== "OR",
  );
  if (unknown.length > 0) {
    throw new Error(`${component} has an unreviewed license token: ${unknown.join(", ")}`);
  }
}

function npmNameFromPath(packagePath) {
  const parts = packagePath.split("/");
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules < 0 || nodeModules + 1 >= parts.length) {
    throw new Error(`Cannot derive npm package name from ${packagePath}`);
  }
  const first = parts[nodeModules + 1];
  return first.startsWith("@") ? `${first}/${parts[nodeModules + 2]}` : first;
}

function purlNpm(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function externalPurl(locator) {
  return [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: locator,
    },
  ];
}

function integrityChecksum(integrity, component) {
  const match = /^(sha512)-(.+)$/.exec(integrity ?? "");
  if (!match) {
    throw new Error(`${component} lacks a locked SHA-512 integrity value`);
  }
  return {
    algorithm: "SHA512",
    checksumValue: Buffer.from(match[2], "base64").toString("hex"),
  };
}

function parseCargoChecksums(text) {
  const checksums = new Map();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    const checksum = /^checksum = "([0-9a-f]+)"$/m.exec(block)?.[1];
    if (name && version && checksum) checksums.set(`${name}@${version}`, checksum);
  }
  return checksums;
}

function readCargoMetadata() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--filter-platform",
      TARGET,
      "--format-version",
      "1",
      "--manifest-path",
      cargoManifestPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function readCargoTree(metadata, edges) {
  const result = spawnSync(
    "cargo",
    [
      "tree",
      "--locked",
      "--offline",
      "--target",
      TARGET,
      "--edges",
      edges,
      "--prefix",
      "depth",
      "--format",
      "{p}",
      "--manifest-path",
      cargoManifestPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`cargo tree (${edges}) failed:\n${result.stderr || result.stdout}`);
  }

  const idsByNameVersion = new Map();
  for (const pkg of metadata.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const existing = idsByNameVersion.get(key);
    if (existing && existing !== pkg.id) {
      throw new Error(`Cargo tree identity is ambiguous for ${key}`);
    }
    idsByNameVersion.set(key, pkg.id);
  }

  const included = new Set();
  const treeEdges = new Set();
  const stack = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^(\d+)([^\s]+) v([^\s]+)/.exec(line);
    if (!match) throw new Error(`Cannot parse cargo tree (${edges}) line: ${line}`);
    const depth = Number.parseInt(match[1], 10);
    const id = idsByNameVersion.get(`${match[2]}@${match[3]}`);
    if (!id) throw new Error(`cargo tree (${edges}) package is absent from metadata: ${line}`);
    included.add(id);
    if (depth > 0) {
      const parent = stack[depth - 1];
      if (!parent) throw new Error(`cargo tree (${edges}) has an invalid depth transition`);
      treeEdges.add(`${parent}\0${id}`);
    }
    stack[depth] = id;
    stack.length = depth + 1;
  }
  if (!included.has(metadata.resolve.root)) {
    throw new Error(`cargo tree (${edges}) does not contain the workspace root`);
  }
  return { included, edges: treeEdges };
}

function collectNpm(packageLock) {
  const selectedEntries = Object.entries(packageLock.packages).filter(
    ([packagePath, record]) => packagePath && record.dev !== true,
  );
  const selectedPaths = new Set(selectedEntries.map(([packagePath]) => packagePath));
  const pathToComponent = new Map();

  for (const [packagePath, record] of selectedEntries) {
    const name = npmNameFromPath(packagePath);
    const license = normalizeLicense(record.license);
    validateLicense(license, `npm:${name}@${record.version}`);
    const component = {
      ecosystem: "npm",
      name,
      version: record.version,
      license,
      purpose: "npm-production-closure",
      source: record.resolved,
      repository: null,
      path: packagePath,
      spdx: {
        name,
        SPDXID: spdxId("npm", name, record.version, packagePath),
        versionInfo: record.version,
        downloadLocation: record.resolved,
        filesAnalyzed: false,
        checksums: [integrityChecksum(record.integrity, `npm:${name}@${record.version}`)],
        licenseConcluded: "NOASSERTION",
        licenseDeclared: license,
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: "LIBRARY",
        externalRefs: externalPurl(purlNpm(name, record.version)),
        sourceInfo:
          "Member of the locked npm production closure. Inclusion does not assert that every archive byte survives the frontend build; candidate output reconciliation remains required.",
      },
    };
    pathToComponent.set(packagePath, component);
  }

  const buildRecord = packageLock.packages[`node_modules/${BUILD_DATA.name}`];
  if (
    !buildRecord ||
    buildRecord.version !== BUILD_DATA.version ||
    buildRecord.dev !== true ||
    buildRecord.license !== "CC-BY-4.0"
  ) {
    throw new Error("The reviewed caniuse-lite build-data decision no longer matches package-lock.json");
  }
  const buildComponent = {
    ecosystem: "npm-build-input",
    name: BUILD_DATA.name,
    version: buildRecord.version,
    license: buildRecord.license,
    purpose: "build-data-not-shipped",
    source: buildRecord.resolved,
    repository: "https://github.com/browserslist/caniuse-lite",
    path: `node_modules/${BUILD_DATA.name}`,
    spdx: {
      name: BUILD_DATA.name,
      SPDXID: spdxId("npm-build", BUILD_DATA.name, buildRecord.version),
      versionInfo: buildRecord.version,
      downloadLocation: buildRecord.resolved,
      filesAnalyzed: false,
      checksums: [integrityChecksum(buildRecord.integrity, `npm:${BUILD_DATA.name}`)],
      licenseConcluded: "NOASSERTION",
      licenseDeclared: buildRecord.license,
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "OTHER",
      externalRefs: externalPurl(purlNpm(BUILD_DATA.name, buildRecord.version)),
      sourceInfo:
        "Build-only browser compatibility data. It is not in the npm production closure and is not copied as a runtime module.",
    },
  };

  function resolveDependency(parentPath, dependencyName) {
    let cursor = parentPath;
    while (true) {
      const candidate = cursor
        ? `${cursor}/node_modules/${dependencyName}`
        : `node_modules/${dependencyName}`;
      if (selectedPaths.has(candidate)) return candidate;
      if (!cursor) return null;
      cursor = cursor.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/, "");
    }
  }

  const edges = [];
  const rootRecord = packageLock.packages[""];
  for (const dependencyName of Object.keys(rootRecord.dependencies ?? {}).sort()) {
    const dependencyPath = resolveDependency("", dependencyName);
    if (!dependencyPath) throw new Error(`Cannot resolve root npm dependency ${dependencyName}`);
    edges.push(["root", pathToComponent.get(dependencyPath).spdx.SPDXID]);
  }
  for (const [packagePath, record] of selectedEntries) {
    const parent = pathToComponent.get(packagePath);
    const requiredDependencies = new Set(Object.keys(record.dependencies ?? {}));
    const requiredPeers = new Set(
      Object.keys(record.peerDependencies ?? {}).filter(
        (name) => record.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    );
    const dependencyNames = new Set([
      ...requiredDependencies,
      ...Object.keys(record.optionalDependencies ?? {}),
      ...Object.keys(record.peerDependencies ?? {}),
    ]);
    for (const dependencyName of [...dependencyNames].sort()) {
      const dependencyPath = resolveDependency(packagePath, dependencyName);
      if (dependencyPath) {
        edges.push([parent.spdx.SPDXID, pathToComponent.get(dependencyPath).spdx.SPDXID]);
      } else if (requiredDependencies.has(dependencyName) || requiredPeers.has(dependencyName)) {
        throw new Error(
          `Cannot resolve required npm dependency ${dependencyName} from ${packagePath}`,
        );
      }
    }
  }

  return {
    components: [...pathToComponent.values()],
    buildComponent,
    edges,
  };
}

function collectCargo(metadata, cargoChecksums, normalTree, fullTree) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const contexts = new Map([[metadata.resolve.root, new Set(["runtime"])]]);
  const queue = [[metadata.resolve.root, "runtime"]];
  const rawEdges = new Map();
  const adjacency = new Map();
  for (const edge of fullTree.edges) {
    const separator = edge.indexOf("\0");
    const parent = edge.slice(0, separator);
    const dependency = edge.slice(separator + 1);
    const dependencies = adjacency.get(parent) ?? new Set();
    dependencies.add(dependency);
    adjacency.set(parent, dependencies);
  }

  while (queue.length > 0) {
    const [parent, parentContext] = queue.shift();
    for (const dependency of adjacency.get(parent) ?? []) {
      const dependencyPackage = packages.get(dependency);
      const isProcMacro = dependencyPackage.targets.some(
        (target) =>
          target.kind.includes("proc-macro") || target.crate_types.includes("proc-macro"),
      );
      const treeEdge = `${parent}\0${dependency}`;
      const dependencyContext =
        parentContext === "build" || !normalTree.edges.has(treeEdge) || isProcMacro
          ? "build"
          : "runtime";
      const edgeKey = `${treeEdge}\0${dependencyContext}`;
      rawEdges.set(edgeKey, [parent, dependency, dependencyContext]);
      const knownContexts = contexts.get(dependency) ?? new Set();
      if (!knownContexts.has(dependencyContext)) {
        knownContexts.add(dependencyContext);
        contexts.set(dependency, knownContexts);
        queue.push([dependency, dependencyContext]);
      }
    }
  }
  if (contexts.size !== fullTree.included.size) {
    throw new Error("Cargo tree traversal did not reach every normal/build package");
  }

  const idToComponent = new Map();
  for (const id of contexts.keys()) {
    if (id === metadata.resolve.root) continue;
    const pkg = packages.get(id);
    const isRuntime = contexts.get(id).has("runtime");
    const license = normalizeLicense(pkg.license);
    if (!license) throw new Error(`cargo:${pkg.name}@${pkg.version} has no declared license`);
    validateLicense(license, `cargo:${pkg.name}@${pkg.version}`);
    const checksum = cargoChecksums.get(`${pkg.name}@${pkg.version}`);
    if (!checksum) throw new Error(`cargo:${pkg.name}@${pkg.version} has no locked checksum`);
    const source = `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`;
    idToComponent.set(id, {
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license,
      purpose: isRuntime ? "windows-runtime" : "windows-build-input",
      source,
      repository: pkg.repository,
      spdx: {
        name: pkg.name,
        SPDXID: spdxId("cargo", pkg.name, pkg.version, id),
        versionInfo: pkg.version,
        downloadLocation: source,
        filesAnalyzed: false,
        checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
        licenseConcluded: "NOASSERTION",
        licenseDeclared: license,
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: isRuntime ? "LIBRARY" : "OTHER",
        externalRefs: externalPurl(`pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`),
        ...(pkg.repository ? { homepage: pkg.repository } : {}),
        ...(!isRuntime
          ? {
              sourceInfo:
                "Build-only dependency in the locked Windows production build graph; not represented as a shipped runtime library.",
            }
          : {}),
      },
    });
  }

  return {
    components: [...idToComponent.values()],
    edges: [...rawEdges.values()].map(([parent, dependency, context]) => ({
      parent: parent === metadata.resolve.root ? "root" : idToComponent.get(parent).spdx.SPDXID,
      dependency: idToComponent.get(dependency).spdx.SPDXID,
      context,
    })),
  };
}

function scaffoldComponent() {
  const source = `${SCAFFOLD.repository}/archive/${SCAFFOLD.commit}.tar.gz`;
  return {
    ecosystem: "scaffold",
    name: SCAFFOLD.name,
    version: SCAFFOLD.version,
    license: SCAFFOLD.license,
    purpose: "source-scaffold",
    source,
    repository: SCAFFOLD.repository,
    spdx: {
      name: SCAFFOLD.name,
      SPDXID: spdxId("scaffold", SCAFFOLD.name, SCAFFOLD.version, SCAFFOLD.commit),
      versionInfo: SCAFFOLD.version,
      downloadLocation: source,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: SCAFFOLD.license,
      copyrightText: "2019-2022, The Tauri Programme in the Commons Conservancy",
      primaryPackagePurpose: "SOURCE",
      homepage: SCAFFOLD.repository,
      externalRefs: externalPurl(`pkg:github/tauri-apps/create-tauri-app@${SCAFFOLD.version}`),
      sourceInfo:
        `The retained React/TypeScript/Tauri scaffold matches create-tauri-app ${SCAFFOLD.version} at commit ${SCAFFOLD.commit}; stock branding assets have been replaced.`,
    },
  };
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

function renderNotice({ components, npmCount, cargoCount, lockDigests }) {
  const sorted = [...components].sort((left, right) =>
    stableCompare(
      [left.ecosystem, left.name, left.version, left.source].join("\0"),
      [right.ecosystem, right.name, right.version, right.source].join("\0"),
    ),
  );
  const mpl = sorted.filter((component) => component.license.includes("MPL-2.0"));
  const unicode = sorted.filter((component) => component.license.includes("Unicode-3.0"));
  const licenseCounts = new Map();
  for (const component of sorted) {
    licenseCounts.set(component.license, (licenseCounts.get(component.license) ?? 0) + 1);
  }
  const families = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Zlib"];
  const familyCounts = families.map((family) => [
    family,
    sorted.filter((component) => component.license.includes(family)).length,
  ]);

  const lines = [
    "# Third-party notices",
    "",
    "This file is generated from the committed npm and Cargo lockfiles. It records the",
    `declared-license inventory for ${npmCount} npm production packages, ${cargoCount} Rust`,
    `packages in the locked ${TARGET} non-development closure, one reviewed build-data`,
    "input, and the retained application scaffold. `licenseConcluded` remains `NOASSERTION`",
    "in the companion SPDX document: a package declaration is evidence, not a legal",
    "conclusion or an invented ownership claim.",
    "",
    "The source archive links below are immutable by version and lockfile checksum. A binary",
    "release must still reconcile these records to the unpacked installer and carry forward",
    "the exact copyright and license notices from those archives. This source-tree inventory",
    "does not authorize a release when provenance, signing, or candidate-output gates remain",
    "open.",
    "",
    "## Reproduction",
    "",
    "```text",
    `cargo fetch --manifest-path app/src-tauri/Cargo.toml --locked --target ${TARGET}`,
    "node scripts/generate-third-party-artifacts.mjs --check",
    "node scripts/generate-third-party-artifacts.mjs --write",
    "```",
    "",
    `- npm lock SHA-256: \`${lockDigests.npm}\``,
    `- Cargo lock SHA-256: \`${lockDigests.cargo}\``,
    `- Cargo target: \`${TARGET}\``,
    "- Cargo scope: normal and build dependencies reachable from the workspace package;",
    "  development dependencies are excluded.",
    "- npm scope: records marked as production by package-lock v3; development dependencies",
    "  are excluded except for the separately classified caniuse-lite build-data record.",
    "",
    "## Retained create-tauri-app scaffold",
    "",
    `The retained source scaffold is from ${markdownLink(`create-tauri-app ${SCAFFOLD.version}`, `${SCAFFOLD.repository}/tree/${SCAFFOLD.commit}`)}`,
    `(commit \`${SCAFFOLD.commit}\`), declared \`${SCAFFOLD.license}\`. The initial direct`,
    "React/TypeScript/Tauri manifest matches that tagged template. Stock Vite and Tauri",
    "branding is not part of this notice set because it has been replaced by locally generated",
    "original code-native branding recorded in `assets/branding/README.md`. This attribution covers the retained scaffold structure only and",
    "does not claim that create-tauri-app owns later Prime Studio source.",
    "",
    "## Mozilla Public License 2.0 source availability",
    "",
    "The following unmodified Rust crates are in the locked Windows production/build graph.",
    "Rows marked `windows-runtime` are present in executable form; build-input rows are used",
    "only to create it. Their exact Source Code Form is available from the versioned archives",
    "below under MPL-2.0. Prime Studio does not apply additional restrictions to those sources.",
    "Each archive contains the applicable",
    `license and package notices. The MPL-2.0 text is available from ${markdownLink("Mozilla", "https://www.mozilla.org/MPL/2.0/")}.`,
    "",
    "| Component | Version | Purpose | Exact source | Upstream repository |",
    "|---|---:|---|---|---|",
    ...mpl.map(
      (component) =>
        `| \`${component.name}\` | \`${component.version}\` | ${component.purpose} | ${markdownLink("crates.io archive", component.source)} | ${component.repository ? markdownLink("repository", component.repository) : "not declared"} |`,
    ),
    "",
    "## Unicode License v3",
    "",
    `The ${unicode.length} components below declare \`Unicode-3.0\` as all or part of their`,
    "license expression: 18 declare it alone and `unicode-ident` declares it together with",
    "permissive alternatives. Their versioned archives contain the package-specific Unicode",
    "copyright and permission notice, including the applicable year range; those notices must",
    "be retained in associated documentation for a binary distribution.",
    "",
    "| Component | Version | Purpose | Declared license | Exact source |",
    "|---|---:|---|---|---|",
    ...unicode.map(
      (component) =>
        `| \`${component.name}\` | \`${component.version}\` | ${component.purpose} | \`${component.license}\` | ${markdownLink("source archive", component.source)} |`,
    ),
    "",
    "## caniuse-lite CC-BY-4.0 build-data decision",
    "",
    `\`caniuse-lite@${BUILD_DATA.version}\` is locked as development-only browser compatibility`,
    `data from ${markdownLink("its exact npm archive", sorted.find((component) => component.name === BUILD_DATA.name && component.purpose === "build-data-not-shipped").source)} and declares \`CC-BY-4.0\`. It is`,
    "reachable through the build toolchain, is absent from the npm production closure, and is",
    "not imported by application runtime source. It is therefore recorded in the SPDX 2.3 file",
    "as `OTHER`, explicitly annotated as build-only, with `BUILD_DEPENDENCY_OF`; it is not a",
    "shipped runtime dependency. Final candidate",
    "output scanning must reopen this decision if any caniuse dataset or recognizable extract",
    "appears in the installer. Upstream package attribution: Ben Briggs (package author); source at",
    `${markdownLink("browserslist/caniuse-lite", "https://github.com/browserslist/caniuse-lite")}; license at`,
    `${markdownLink("Creative Commons Attribution 4.0", "https://creativecommons.org/licenses/by/4.0/")}.`,
    "",
    "## Permissive license families",
    "",
    "Every component and exact declared expression appears in the complete inventory below.",
    "The family counts make the MIT, Apache-2.0, BSD-3-Clause, ISC, and Zlib obligations",
    "visible even when a component offers alternative terms. Use the exact source archive for",
    "the copyright notice and license text that belongs to that component.",
    "",
    "| License family | Components whose expression includes it |",
    "|---|---:|",
    ...familyCounts.map(([family, count]) => `| \`${family}\` | ${count} |`),
    "",
    "## Prime Agent is not distributed",
    "",
    `Prime Agent is a separately installed runtime and is intentionally absent from this shipped`,
    `dependency SBOM. The audited interoperability reference is commit \`${PRIME_AGENT.commit}\``,
    `at ${markdownLink("PrimeIntellect-ai/prime-agent", `${PRIME_AGENT.repository}/tree/${PRIME_AGENT.commit}`)}, declared \`${PRIME_AGENT.license}\`. No Prime Agent source or`,
    "binary is vendored by this repository. If that boundary changes, regenerate the SBOM and",
    "perform a path-level pi-mono and nested-notice audit first. The audited upstream notices are:",
    "",
    ...PRIME_AGENT.notices.map((notice) => `- ${notice}`),
    "",
    "## Declared-license summary",
    "",
    "| SPDX expression | Component count |",
    "|---|---:|",
    ...[...licenseCounts.entries()]
      .sort(([left], [right]) => stableCompare(left, right))
      .map(([license, count]) => `| \`${license}\` | ${count} |`),
    "",
    "## Complete locked inventory",
    "",
    "| Ecosystem/scope | Component | Version | Purpose | Declared license | Exact source |",
    "|---|---|---:|---|---|---|",
    ...sorted.map(
      (component) =>
        `| ${component.ecosystem} | \`${component.name}\` | \`${component.version}\` | ${component.purpose} | \`${component.license}\` | ${markdownLink("archive", component.source)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

function validateSpdxDocument(sbom) {
  const allowedPurposes = new Set([
    "APPLICATION",
    "ARCHIVE",
    "CONTAINER",
    "DEVICE",
    "FILE",
    "FIRMWARE",
    "FRAMEWORK",
    "INSTALL",
    "LIBRARY",
    "OPERATING_SYSTEM",
    "OTHER",
    "SOURCE",
  ]);
  const allowedRelationships = new Set([
    "BUILD_DEPENDENCY_OF",
    "DEPENDS_ON",
    "DESCRIBES",
    "GENERATED_FROM",
  ]);
  const packageIds = new Set();
  for (const pkg of sbom.packages) {
    if (packageIds.has(pkg.SPDXID)) throw new Error(`Duplicate SPDX package ID ${pkg.SPDXID}`);
    packageIds.add(pkg.SPDXID);
    if (!allowedPurposes.has(pkg.primaryPackagePurpose)) {
      throw new Error(`${pkg.name} has an invalid SPDX 2.3 package purpose`);
    }
  }
  for (const relationship of sbom.relationships) {
    if (!allowedRelationships.has(relationship.relationshipType)) {
      throw new Error(`Unreviewed SPDX relationship ${relationship.relationshipType}`);
    }
    if (
      relationship.spdxElementId !== "SPDXRef-DOCUMENT" &&
      !packageIds.has(relationship.spdxElementId)
    ) {
      throw new Error(`Dangling SPDX relationship source ${relationship.spdxElementId}`);
    }
    if (!packageIds.has(relationship.relatedSpdxElement)) {
      throw new Error(`Dangling SPDX relationship target ${relationship.relatedSpdxElement}`);
    }
  }
  for (const described of sbom.documentDescribes) {
    if (!packageIds.has(described)) throw new Error(`Dangling documentDescribes ID ${described}`);
  }
}

function generate() {
  const packageLockText = readFileSync(packageLockPath, "utf8");
  const cargoLockText = readFileSync(cargoLockPath, "utf8");
  const packageLock = JSON.parse(packageLockText);
  const metadata = readCargoMetadata();
  const normalCargoTree = readCargoTree(metadata, "normal");
  const fullCargoTree = readCargoTree(metadata, "normal,build");
  const npm = collectNpm(packageLock);
  const cargo = collectCargo(
    metadata,
    parseCargoChecksums(cargoLockText),
    normalCargoTree,
    fullCargoTree,
  );
  const scaffold = scaffoldComponent();
  const rootRecord = packageLock.packages[""];
  const rootId = spdxId("application", rootRecord.name, rootRecord.version, TARGET);
  const rootPackage = {
    name: "Prime Studio",
    SPDXID: rootId,
    versionInfo: rootRecord.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: rootRecord.license ?? "NOASSERTION",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "APPLICATION",
  };
  const lockDigests = {
    npm: digest("sha256", packageLockText),
    cargo: digest("sha256", cargoLockText),
  };
  const documentSeed = [
    TARGET,
    rootRecord.version,
    lockDigests.npm,
    lockDigests.cargo,
    SCAFFOLD.commit,
  ].join("\0");
  const relationships = [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootId,
    },
    {
      spdxElementId: rootId,
      relationshipType: "GENERATED_FROM",
      relatedSpdxElement: scaffold.spdx.SPDXID,
    },
    {
      spdxElementId: npm.buildComponent.spdx.SPDXID,
      relationshipType: "BUILD_DEPENDENCY_OF",
      relatedSpdxElement: rootId,
    },
    ...npm.edges.map(([parent, dependency]) => ({
      spdxElementId: parent === "root" ? rootId : parent,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: dependency,
    })),
    ...cargo.edges.map(({ parent, dependency, context }) =>
      context === "runtime"
        ? {
            spdxElementId: parent === "root" ? rootId : parent,
            relationshipType: "DEPENDS_ON",
            relatedSpdxElement: dependency,
          }
        : {
            spdxElementId: dependency,
            relationshipType: "BUILD_DEPENDENCY_OF",
            relatedSpdxElement: parent === "root" ? rootId : parent,
          },
    ),
  ].sort((left, right) =>
    stableCompare(
      [left.spdxElementId, left.relationshipType, left.relatedSpdxElement].join("\0"),
      [right.spdxElementId, right.relationshipType, right.relatedSpdxElement].join("\0"),
    ),
  );
  const components = [
    ...npm.components,
    npm.buildComponent,
    ...cargo.components,
    scaffold,
  ];
  const sbomPackages = [rootPackage, ...components.map((component) => component.spdx)].sort(
    (left, right) => stableCompare(left.SPDXID, right.SPDXID),
  );
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Prime-Studio-${rootRecord.version}-windows-x86_64-production`,
    documentNamespace: `https://spdx.org/spdxdocs/prime-studio-windows-x86_64-${digest("sha256", documentSeed).slice(0, 32)}`,
    creationInfo: {
      created: CREATED,
      creators: ["Tool: prime-studio-third-party-artifacts"],
    },
    documentDescribes: [rootId],
    packages: sbomPackages,
    relationships,
  };
  validateSpdxDocument(sbom);
  return {
    notice: renderNotice({
      components,
      npmCount: npm.components.length,
      cargoCount: cargo.components.length,
      lockDigests,
    }),
    sbom: `${JSON.stringify(sbom, null, 2)}\n`,
  };
}

function checkFile(filePath, expected) {
  let actual;
  try {
    actual = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`${path.relative(repositoryRoot, filePath)} is missing; run with --write`);
  }
  if (actual !== expected) {
    throw new Error(`${path.relative(repositoryRoot, filePath)} is stale; run with --write`);
  }
}

function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--write"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/generate-third-party-artifacts.mjs (--check|--write)");
  }
  const artifacts = generate();
  if (mode === "--write") {
    mkdirSync(path.dirname(sbomPath), { recursive: true });
    writeFileSync(noticePath, artifacts.notice, "utf8");
    writeFileSync(bundledNoticePath, artifacts.notice, "utf8");
    writeFileSync(sbomPath, artifacts.sbom, "utf8");
    console.log(
      "Wrote root/bundled third-party notices and sbom/prime-studio-windows-x86_64.spdx.json",
    );
    return;
  }
  checkFile(noticePath, artifacts.notice);
  checkFile(bundledNoticePath, artifacts.notice);
  checkFile(sbomPath, artifacts.sbom);
  console.log("Third-party notice and SPDX SBOM match the locked Windows production graphs.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

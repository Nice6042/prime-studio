import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type EnvelopeClassification = "core" | "extension" | "unknown";
export type ParseIssueKind = "invalid_utf8" | "malformed_json" | "truncated_json" | "oversize_line";
export type ParseObservationKind = "duplicate" | "conflict" | "late" | "out_of_order";

export interface ParsedLegacyPrimeRecord {
  line: number;
  type: string | null;
  classification: EnvelopeClassification;
  event: Record<string, unknown>;
  raw: string;
  byteLength: number;
  lineEnding: "lf" | "crlf" | "eof";
}

export interface ParseIssue {
  line: number;
  kind: ParseIssueKind;
  byteLength: number | undefined;
}

export interface ParseObservation {
  kind: ParseObservationKind;
  line: number;
  relatedLine: number;
  fixtureId: string;
}

export interface LegacyPrimeJsonlParseReport {
  records: ParsedLegacyPrimeRecord[];
  issues: ParseIssue[];
  observations: ParseObservation[];
}

interface ExpectedRecord {
  line: number;
  type: string | null;
  classification: EnvelopeClassification;
}

interface ExpectedIssue {
  line: number;
  kind: ParseIssueKind;
  byteLength: number | undefined;
}

interface ScenarioExpectation {
  records: ExpectedRecord[];
  issues: ExpectedIssue[];
  observations: ParseObservation[];
}

interface ScenarioManifestEntry {
  id: string;
  file: string;
  expected: ScenarioExpectation;
}

interface ScenarioManifest {
  schemaVersion: number;
  fixtureSet: string;
  lineByteLimit: number;
  scenarios: ScenarioManifestEntry[];
}

export interface LegacyPrimeJsonlScenario {
  id: string;
  path: string;
  lineByteLimit: number;
  expected: ScenarioExpectation;
  report: LegacyPrimeJsonlParseReport;
}

const coreEnvelopeTypes = new Set([
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "response",
  "error",
]);

const extensionEnvelopeTypes = new Set([
  "extension_ui_request",
  "extension_ui_response",
  "rlm_child_update",
  "child_usage_attributed",
  "rate_limits",
  "session_info_changed",
]);

const classifications = new Set<EnvelopeClassification>(["core", "extension", "unknown"]);
const issueKinds = new Set<ParseIssueKind>([
  "invalid_utf8",
  "malformed_json",
  "truncated_json",
  "oversize_line",
]);
const observationKinds = new Set<ParseObservationKind>(["duplicate", "conflict", "late", "out_of_order"]);
const forbiddenFixturePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:\b|["'])(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)(?:\b|["'])\s*[:=]/i,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:[A-Z]:)?\\{1,2}Users\\{1,2}(?!synthetic(?:\\{1,2}|$))/i,
  /\/(?:home|Users)\/(?!synthetic(?:\/|$))/,
];

// Vitest serves test modules through Vite, where import.meta.url is not a file URL.
// This is test-only code and every app script runs with app/ as its working directory.
const fixtureRoot = resolve(process.cwd(), "src/test/fixtures/legacy-prime/v1");
const manifestPath = join(fixtureRoot, "scenarios.json");
const schemaPath = join(fixtureRoot, "scenario.schema.json");

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function expectedRecord(value: unknown, label: string): ExpectedRecord {
  const record = objectValue(value, label);
  const classification = stringValue(record.classification, `${label}.classification`);
  if (!classifications.has(classification as EnvelopeClassification)) {
    throw new Error(`${label}.classification is not recognized`);
  }
  const type = record.type;
  if (type !== null && typeof type !== "string") throw new Error(`${label}.type must be a string or null`);
  return {
    line: integerValue(record.line, `${label}.line`),
    type,
    classification: classification as EnvelopeClassification,
  };
}

function expectedIssue(value: unknown, label: string): ExpectedIssue {
  const issue = objectValue(value, label);
  const kind = stringValue(issue.kind, `${label}.kind`);
  if (!issueKinds.has(kind as ParseIssueKind)) throw new Error(`${label}.kind is not recognized`);
  const byteLength = issue.byteLength;
  if (byteLength !== undefined) integerValue(byteLength, `${label}.byteLength`);
  return {
    line: integerValue(issue.line, `${label}.line`),
    kind: kind as ParseIssueKind,
    byteLength: byteLength as number | undefined,
  };
}

function expectedObservation(value: unknown, label: string): ParseObservation {
  const observation = objectValue(value, label);
  const kind = stringValue(observation.kind, `${label}.kind`);
  if (!observationKinds.has(kind as ParseObservationKind)) {
    throw new Error(`${label}.kind is not recognized`);
  }
  return {
    kind: kind as ParseObservationKind,
    line: integerValue(observation.line, `${label}.line`),
    relatedLine: integerValue(observation.relatedLine, `${label}.relatedLine`),
    fixtureId: stringValue(observation.fixtureId, `${label}.fixtureId`),
  };
}

function expectedContract(value: unknown, label: string): ScenarioExpectation {
  const contract = objectValue(value, label);
  return {
    records: arrayValue(contract.records, `${label}.records`).map((record, index) =>
      expectedRecord(record, `${label}.records[${index}]`),
    ),
    issues: arrayValue(contract.issues, `${label}.issues`).map((issue, index) =>
      expectedIssue(issue, `${label}.issues[${index}]`),
    ),
    observations: arrayValue(contract.observations, `${label}.observations`).map((observation, index) =>
      expectedObservation(observation, `${label}.observations[${index}]`),
    ),
  };
}

function validateSchemaDocument(): void {
  const schema = objectValue(JSON.parse(readFileSync(schemaPath, "utf8")), "scenario schema");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("scenario schema must use JSON Schema draft 2020-12");
  }
  if (schema.$id !== "https://prime-studio.test/fixtures/legacy-prime/v1/scenario.schema.json") {
    throw new Error("scenario schema id is not the synthetic v1 id");
  }
  const properties = objectValue(schema.properties, "scenario schema.properties");
  const schemaVersion = objectValue(properties.schemaVersion, "scenario schema.properties.schemaVersion");
  if (schemaVersion.const !== 1) throw new Error("scenario schema must pin version 1");
}

function loadManifest(): ScenarioManifest {
  validateSchemaDocument();
  const manifest = objectValue(JSON.parse(readFileSync(manifestPath, "utf8")), "scenario manifest");
  if (manifest.$schema !== "./scenario.schema.json") {
    throw new Error("scenario manifest must name its local schema");
  }
  if (manifest.schemaVersion !== 1) throw new Error("scenario manifest must use schema version 1");
  const lineByteLimit = integerValue(manifest.lineByteLimit, "scenario manifest.lineByteLimit");
  if (lineByteLimit <= 0) throw new Error("scenario manifest.lineByteLimit must be positive");

  const scenarios = arrayValue(manifest.scenarios, "scenario manifest.scenarios").map((value, index) => {
    const entry = objectValue(value, `scenario manifest.scenarios[${index}]`);
    const id = stringValue(entry.id, `scenario manifest.scenarios[${index}].id`);
    const file = stringValue(entry.file, `scenario manifest.scenarios[${index}].file`);
    if (!/^[a-z0-9-]+\.jsonl$/.test(file)) {
      throw new Error(`scenario ${id} must use a direct .jsonl fixture filename`);
    }
    return { id, file, expected: expectedContract(entry.expected, `scenario ${id}.expected`) };
  });

  if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new Error("scenario ids must be unique");
  }
  return {
    schemaVersion: 1,
    fixtureSet: stringValue(manifest.fixtureSet, "scenario manifest.fixtureSet"),
    lineByteLimit,
    scenarios,
  };
}

function fixturePath(file: string): string {
  const candidate = resolve(fixtureRoot, file);
  const relativePath = relative(fixtureRoot, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`fixture path ${file} escapes the fixture root`);
  }
  return candidate;
}

function classificationOf(type: string | null): EnvelopeClassification {
  if (type && coreEnvelopeTypes.has(type)) return "core";
  if (type && extensionEnvelopeTypes.has(type)) return "extension";
  return "unknown";
}

interface FramedLine {
  line: number;
  bytes: Uint8Array;
  lineEnding: ParsedLegacyPrimeRecord["lineEnding"];
}

function splitOnLfOnly(bytes: Uint8Array): FramedLine[] {
  const lines: FramedLine[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const content = bytes.subarray(start, index);
    lines.push({
      line,
      bytes: content,
      lineEnding: content.length > 0 && content[content.length - 1] === 0x0d ? "crlf" : "lf",
    });
    start = index + 1;
    line += 1;
  }
  if (start < bytes.length) {
    const content = bytes.subarray(start);
    lines.push({ line, bytes: content, lineEnding: "eof" });
  }
  return lines;
}

function fixtureIdOf(event: Record<string, unknown>): string | undefined {
  return typeof event.fixtureId === "string" && event.fixtureId ? event.fixtureId : undefined;
}

function fixtureSequenceOf(event: Record<string, unknown>): number | undefined {
  return typeof event.fixtureSequence === "number" && Number.isSafeInteger(event.fixtureSequence)
    ? event.fixtureSequence
    : undefined;
}

export function findForbiddenFixturePattern(text: string): RegExp | undefined {
  return forbiddenFixturePatterns.find((pattern) => pattern.test(text));
}

export function parseLegacyPrimeJsonl(bytes: Uint8Array, lineByteLimit: number): LegacyPrimeJsonlParseReport {
  const records: ParsedLegacyPrimeRecord[] = [];
  const issues: ParseIssue[] = [];
  const observations: ParseObservation[] = [];
  const knownFixtureIds = new Map<string, { line: number; raw: string }>();
  let latestSequence: { line: number; value: number } | undefined;
  let terminalLine: number | undefined;

  for (const framed of splitOnLfOnly(bytes)) {
    const byteLength = framed.bytes.length - (framed.lineEnding === "crlf" ? 1 : 0);
    if (byteLength === 0) continue;
    if (byteLength > lineByteLimit) {
      issues.push({ line: framed.line, kind: "oversize_line", byteLength });
      continue;
    }

    const eventBytes = framed.lineEnding === "crlf" ? framed.bytes.subarray(0, -1) : framed.bytes;
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(eventBytes);
    } catch {
      issues.push({ line: framed.line, kind: "invalid_utf8", byteLength: undefined });
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = objectValue(JSON.parse(raw), `line ${framed.line}`);
    } catch {
      issues.push({
        line: framed.line,
        kind: framed.lineEnding === "eof" ? "truncated_json" : "malformed_json",
        byteLength: undefined,
      });
      continue;
    }

    const type = typeof event.type === "string" && event.type ? event.type : null;
    const record: ParsedLegacyPrimeRecord = {
      line: framed.line,
      type,
      classification: classificationOf(type),
      event,
      raw,
      byteLength,
      lineEnding: framed.lineEnding,
    };
    records.push(record);

    const id = fixtureIdOf(event);
    if (id) {
      const previous = knownFixtureIds.get(id);
      if (previous) {
        observations.push({
          kind: previous.raw === raw ? "duplicate" : "conflict",
          line: framed.line,
          relatedLine: previous.line,
          fixtureId: id,
        });
      } else {
        knownFixtureIds.set(id, { line: framed.line, raw });
      }
    }

    const sequence = fixtureSequenceOf(event);
    if (sequence !== undefined) {
      if (latestSequence && sequence < latestSequence.value) {
        observations.push({
          kind: "out_of_order",
          line: framed.line,
          relatedLine: latestSequence.line,
          fixtureId: id ?? "unlabeled-synthetic-event",
        });
      }
      if (!latestSequence || sequence > latestSequence.value) {
        latestSequence = { line: framed.line, value: sequence };
      }
    }

    if (terminalLine !== undefined) {
      observations.push({
        kind: "late",
        line: framed.line,
        relatedLine: terminalLine,
        fixtureId: id ?? "unlabeled-synthetic-event",
      });
    }
    if (type === "agent_end") terminalLine = framed.line;
  }

  return { records, issues, observations };
}

export function loadLegacyPrimeJsonlScenarios(): LegacyPrimeJsonlScenario[] {
  const manifest = loadManifest();
  return manifest.scenarios.map(({ id, file, expected }) => {
    const path = fixturePath(file);
    const bytes = readFileSync(path);
    return {
      id,
      path,
      lineByteLimit: manifest.lineByteLimit,
      expected,
      report: parseLegacyPrimeJsonl(bytes, manifest.lineByteLimit),
    };
  });
}

export function fixtureFiles(): string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  walk(fixtureRoot);
  return paths.sort();
}

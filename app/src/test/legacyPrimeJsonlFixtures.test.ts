import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  findForbiddenFixturePattern,
  fixtureFiles,
  loadLegacyPrimeJsonlScenarios,
  type LegacyPrimeJsonlScenario,
} from "./legacyPrimeJsonlFixtures";

const scenarios = loadLegacyPrimeJsonlScenarios();

function scenario(id: string): LegacyPrimeJsonlScenario {
  const found = scenarios.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`synthetic scenario ${id} is missing`);
  return found;
}

function contractOf(input: LegacyPrimeJsonlScenario) {
  return {
    records: input.report.records.map(({ line, type, classification }) => ({ line, type, classification })),
    issues: input.report.issues.map(({ line, kind, byteLength }) => ({ line, kind, byteLength })),
    observations: input.report.observations,
  };
}

describe("synthetic legacy Prime JSONL fixtures", () => {
  it("loads a deterministic schema-v1 corpus", () => {
    expect(scenarios.map(({ id }) => id)).toEqual([
      "known-core-and-extension-envelopes",
      "unknown-envelope",
      "malformed-json",
      "truncated-json",
      "duplicate-and-conflicting-events",
      "late-and-out-of-order-events",
      "utf8-and-lf-only-framing",
      "crlf-framing",
      "oversize-boundary",
    ]);
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
  });

  for (const input of scenarios) {
    it(`${input.id} matches its declared parser contract`, () => {
      expect(contractOf(input)).toEqual(input.expected);
    });
  }

  it("classifies the documented core and extension envelopes", () => {
    const parsed = scenario("known-core-and-extension-envelopes").report.records;

    expect(parsed.filter(({ classification }) => classification === "core").map(({ type }) => type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "turn_end",
      "response",
      "error",
      "agent_end",
    ]);
    expect(parsed.filter(({ classification }) => classification === "extension").map(({ type }) => type)).toEqual([
      "extension_ui_request",
      "extension_ui_response",
      "rlm_child_update",
      "child_usage_attributed",
      "rate_limits",
      "session_info_changed",
    ]);
  });

  it("keeps unknown envelopes intact instead of coercing them into a core event", () => {
    const parsed = scenario("unknown-envelope").report.records;

    expect(parsed.map(({ classification, type }) => ({ classification, type }))).toEqual([
      { classification: "unknown", type: null },
      { classification: "unknown", type: "future_extension" },
    ]);
    expect(parsed[1]?.event).toMatchObject({ payload: { marker: "opaque-synthetic-value" } });
  });

  it("separates malformed and unfinished tail records from parsed events", () => {
    const malformed = scenario("malformed-json").report;
    const truncated = scenario("truncated-json").report;

    expect(malformed.issues).toEqual([{ line: 2, kind: "malformed_json", byteLength: undefined }]);
    expect(truncated.issues).toEqual([{ line: 2, kind: "truncated_json", byteLength: undefined }]);
    expect(malformed.records).toHaveLength(1);
    expect(truncated.records).toHaveLength(1);
  });

  it("reports duplicate and conflicting fixture ids without dropping either envelope", () => {
    const parsed = scenario("duplicate-and-conflicting-events").report;

    expect(parsed.records).toHaveLength(4);
    expect(parsed.observations).toEqual([
      { kind: "duplicate", line: 2, relatedLine: 1, fixtureId: "evt-duplicate" },
      { kind: "conflict", line: 4, relatedLine: 3, fixtureId: "evt-conflict" },
    ]);
  });

  it("reports late and out-of-order envelopes while retaining arrival order", () => {
    const parsed = scenario("late-and-out-of-order-events").report;

    expect(parsed.records.map(({ type }) => type)).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "agent_end",
      "message_end",
    ]);
    expect(parsed.observations).toEqual([
      { kind: "out_of_order", line: 3, relatedLine: 2, fixtureId: "evt-sequence-2" },
      { kind: "late", line: 5, relatedLine: 4, fixtureId: "evt-late-after-end" },
    ]);
  });

  it("keeps multibyte UTF-8 and U+2028/U+2029 inside a single LF-delimited record", () => {
    const parsed = scenario("utf8-and-lf-only-framing").report.records;

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.event).toMatchObject({
      message: { content: [{ type: "text", text: "café 🧪 still-one-value " }] },
    });
    expect(parsed[0]?.byteLength).toBeGreaterThan(
      (parsed[0]?.raw ?? "").length,
    );
  });

  it("accepts byte-exact CRLF records while treating LF as the only delimiter", () => {
    const input = scenario("crlf-framing");
    const source = readFileSync(input.path);

    expect(source.toString("utf8")).toContain("\r\n");
    expect(input.report.records).toHaveLength(2);
    expect(input.report.records.every(({ lineEnding }) => lineEnding === "crlf")).toBe(true);
  });

  it("accepts the exact line limit and rejects only the one-byte oversize line", () => {
    const input = scenario("oversize-boundary");

    expect(input.lineByteLimit).toBe(256);
    expect(input.report.records.map(({ byteLength }) => byteLength)).toEqual([256]);
    expect(input.report.issues).toEqual([{ line: 2, kind: "oversize_line", byteLength: 257 }]);
  });

  it("recognizes JSON-quoted secrets and escaped personal paths", () => {
    expect(findForbiddenFixturePattern('{"password":"must-not-ship"}')).toBeDefined();
    expect(findForbiddenFixturePattern('{"path":"C:\\\\Users\\\\real-person"}')).toBeDefined();
    expect(findForbiddenFixturePattern('{"path":"C:\\\\synthetic\\\\prime"}')).toBeUndefined();
  });

  it("contains no secret or personal-data-shaped values", () => {
    for (const path of fixtureFiles()) {
      const text = readFileSync(path, "utf8");
      const pattern = findForbiddenFixturePattern(text);
      expect(pattern, `${path} matched ${pattern}`).toBeUndefined();
    }
  });
});

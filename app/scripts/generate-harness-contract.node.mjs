import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateHarnessContract,
  loadHarnessSchema,
  validateHarnessSchema,
} from "./generate-harness-contract.mjs";

const schemaUrl = new URL("../contracts/harness-v1.schema.json", import.meta.url);

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    walk(child, visit);
  }
}

test("every protocol object is closed and every collection is bounded", async () => {
  const schema = await loadHarnessSchema(schemaUrl);
  validateHarnessSchema(schema);

  let objects = 0;
  let arrays = 0;
  walk(schema, (node) => {
    if (node.type === "object") {
      objects += 1;
      assert.equal(node.additionalProperties, false);
      assert.ok(Array.isArray(node.required));
    }
    if (node.type === "array") {
      arrays += 1;
      assert.ok(Number.isSafeInteger(node.maxItems));
      assert.ok(node.maxItems > 0 && node.maxItems <= 4096);
    }
  });

  assert.ok(objects >= 20, "the protocol must model its authority-bound records explicitly");
  assert.ok(arrays >= 8, "the protocol must bound every repeated domain");
  assert.equal(schema.properties.studioProtocol.const, 1);
  assert.equal(schema.$defs.RequestId.pattern, "^[A-Za-z0-9_-]{16,96}$");
  assert.equal(schema.$defs.SafeInteger.maximum, Number.MAX_SAFE_INTEGER);
});

test("generation is deterministic and bound to the source schema hash", async () => {
  const schema = await loadHarnessSchema(schemaUrl);
  const first = generateHarnessContract(schema);
  const second = generateHarnessContract(schema);

  assert.deepEqual(first, second);
  assert.match(first.typescript, /^\/\/ Generated from harness-v1\.schema\.json; SHA-256: [a-f0-9]{64}/);
  assert.match(first.rust, /^\/\/ Generated from harness-v1\.schema\.json; SHA-256: [a-f0-9]{64}/);
  assert.match(first.typescript, /export type StudioRequest/);
  assert.match(first.typescript, /export interface RootSessionSnapshot/);
  assert.match(first.rust, /pub enum StudioRequest/);
  assert.match(first.rust, /pub struct RootSessionSnapshot/);
});

test("checked-in generated files exactly match the schema", async () => {
  const schema = await loadHarnessSchema(schemaUrl);
  const generated = generateHarnessContract(schema);
  const [typescript, rust] = await Promise.all([
    readFile(new URL("../src/shared/ipc/harness.generated.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/harness/generated.rs", import.meta.url), "utf8"),
  ]);

  assert.equal(typescript, generated.typescript);
  assert.equal(rust, generated.rust);
});

test("schema validation rejects open or unbounded authority records", async () => {
  const schema = await loadHarnessSchema(schemaUrl);
  const open = structuredClone(schema);
  open.$defs.RuntimeIdentity.additionalProperties = true;
  assert.throws(() => validateHarnessSchema(open), /closed object/);

  const unbounded = structuredClone(schema);
  delete unbounded.$defs.RootSessionSnapshot.properties.children.maxItems;
  assert.throws(() => validateHarnessSchema(unbounded), /bounded array/);
});

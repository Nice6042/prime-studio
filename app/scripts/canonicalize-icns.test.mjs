import { expect, test } from "vitest";

import { canonicalizeIcns } from "./canonicalize-icns.mjs";

function chunk(type, payload) {
  const result = Buffer.alloc(8 + payload.length);
  result.write(type, 0, 4, "ascii");
  result.writeUInt32BE(result.length, 4);
  payload.copy(result, 8);
  return result;
}

function icns(...chunks) {
  const length = 8 + chunks.reduce((total, item) => total + item.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(length, 4);
  return Buffer.concat([header, ...chunks]);
}

test("canonicalizeIcns sorts chunks by type and bytes", () => {
  const unordered = icns(
    chunk("zzzz", Buffer.from([9])),
    chunk("aaaa", Buffer.from([2])),
    chunk("aaaa", Buffer.from([1])),
  );

  const actual = canonicalizeIcns(unordered);
  const expected = icns(
    chunk("aaaa", Buffer.from([1])),
    chunk("aaaa", Buffer.from([2])),
    chunk("zzzz", Buffer.from([9])),
  );

  expect(actual).toEqual(expected);
});

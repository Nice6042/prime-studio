import { describe, expect, it } from "vitest";

import { canonicalBrowserJson, decodeBrowserTransport } from "./transport";

describe("bounded browser JSON transport", () => {
  it("rejects raw objects without reflecting on them", () => {
    let reflected = false;
    const hostile = new Proxy({}, {
      ownKeys: () => {
        reflected = true;
        throw new Error("must not reflect");
      },
      get: () => {
        reflected = true;
        throw new Error("must not read");
      },
    });

    expect(() => decodeBrowserTransport(hostile)).not.toThrow();
    expect(decodeBrowserTransport(hostile)).toBeNull();
    expect(reflected).toBe(false);
  });

  it("preflights UTF-8 bytes before parsing", () => {
    const oversized = JSON.stringify("\u{1f600}".repeat(65_537));
    expect(decodeBrowserTransport(oversized)).toBeNull();
  });

  it("enforces aggregate array, object, string, node, and depth budgets", () => {
    expect(decodeBrowserTransport(JSON.stringify(Array.from({ length: 257 }, () => 0)))).toBeNull();
    expect(decodeBrowserTransport(JSON.stringify(Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key${index}`, index]),
    )))).toBeNull();
    expect(decodeBrowserTransport(JSON.stringify("a".repeat(131_073)))).toBeNull();

    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) deep = [deep];
    expect(decodeBrowserTransport(JSON.stringify(deep))).toBeNull();

    const manyNodes = Array.from({ length: 256 }, () =>
      Array.from({ length: 8 }, () => ({ value: 1 })),
    );
    expect(decodeBrowserTransport(JSON.stringify(manyNodes))).toBeNull();
  });

  it("rejects malformed JSON and duplicate object keys", () => {
    expect(decodeBrowserTransport("{not-json")).toBeNull();
    expect(decodeBrowserTransport('{"intentId":"one","intentId":"two"}')).toBeNull();
  });

  it("returns bounded parser-owned JSON and a stable canonical form", () => {
    const decoded = decodeBrowserTransport('{"z":[true,null],"a":{"b":2}}');
    expect(decoded).toEqual({ z: [true, null], a: { b: 2 } });
    expect(canonicalBrowserJson(decoded!)).toBe('{"a":{"b":2},"z":[true,null]}');
  });
});

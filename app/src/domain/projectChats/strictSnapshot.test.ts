import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_CHAT_SNAPSHOT_DEPTH,
  MAX_PROJECT_CHAT_SNAPSHOT_NODES,
  MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES,
  MAX_PROJECT_CHAT_SNAPSHOT_WORK,
  snapshotUntrusted,
} from "./strictSnapshot";

function nested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.next = child;
    cursor = child;
  }
  return root;
}

describe("strict untrusted snapshots", () => {
  it("accepts the container-node cap and rejects cap plus one", () => {
    const atCap = Array.from(
      { length: MAX_PROJECT_CHAT_SNAPSHOT_NODES - 1 },
      () => ({}),
    );
    const overCap = [...atCap, {}];

    expect(snapshotUntrusted(atCap).status).toBe("ok");
    expect(snapshotUntrusted(overCap)).toEqual({ status: "rejected" });
  });

  it("accepts the depth cap and rejects cap plus one", () => {
    expect(snapshotUntrusted(nested(MAX_PROJECT_CHAT_SNAPSHOT_DEPTH)).status).toBe("ok");
    expect(snapshotUntrusted(nested(MAX_PROJECT_CHAT_SNAPSHOT_DEPTH + 1))).toEqual({
      status: "rejected",
    });
  });

  it("accepts the UTF-8 scalar-byte cap and rejects cap plus one", () => {
    const keyBytes = "value".length;
    const multibytePrefix = "é";
    const atCap = {
      value:
        multibytePrefix +
        "x".repeat(
            MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES -
            keyBytes -
            2,
        ),
    };
    const overCap = { value: `${atCap.value}x` };

    expect(snapshotUntrusted(atCap).status).toBe("ok");
    expect(snapshotUntrusted(overCap)).toEqual({ status: "rejected" });
  });

  it("charges cached scalar bytes again for each shared-object edge", () => {
    const reads = { keys: 0, descriptor: 0 };
    const shared = new Proxy(
      {
        value: "x".repeat((MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES - 16) / 2),
      },
      {
        ownKeys(current) {
          reads.keys += 1;
          return Reflect.ownKeys(current);
        },
        getOwnPropertyDescriptor(current, property) {
          reads.descriptor += 1;
          return Reflect.getOwnPropertyDescriptor(current, property);
        },
      },
    );
    const atCap = { a: shared, b: shared, tail: "" };

    expect(snapshotUntrusted(atCap).status).toBe("ok");
    expect(reads).toEqual({ keys: 1, descriptor: 1 });
    atCap.tail = "x";
    expect(snapshotUntrusted(atCap)).toEqual({ status: "rejected" });
    expect(reads).toEqual({ keys: 2, descriptor: 2 });
  });

  it("validates cached subtree height at each shared-object edge", () => {
    const reads = { keys: 0, descriptor: 0 };
    const shared = new Proxy(nested(MAX_PROJECT_CHAT_SNAPSHOT_DEPTH - 1), {
      ownKeys(current) {
        reads.keys += 1;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor(current, property) {
        reads.descriptor += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    expect(snapshotUntrusted({ shallow: shared, atCap: shared }).status).toBe("ok");
    expect(reads).toEqual({ keys: 1, descriptor: 1 });

    expect(
      snapshotUntrusted({ shallow: shared, deeper: { alias: shared } }),
    ).toEqual({ status: "rejected" });
    expect(reads).toEqual({ keys: 2, descriptor: 2 });
  });

  it("accepts the own-key work cap and rejects cap plus one", () => {
    const atCap = Array.from(
      { length: MAX_PROJECT_CHAT_SNAPSHOT_WORK - 1 },
      () => null,
    );
    const reads = { lengthDescriptor: 0, keys: 0, indexDescriptor: 0 };
    const overCap = new Proxy([...atCap, null], {
      ownKeys(current) {
        reads.keys += 1;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor(current, property) {
        if (property === "length") reads.lengthDescriptor += 1;
        else reads.indexDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    expect(snapshotUntrusted(atCap).status).toBe("ok");
    expect(snapshotUntrusted(overCap)).toEqual({ status: "rejected" });
    expect(reads).toEqual({ lengthDescriptor: 1, keys: 0, indexDescriptor: 0 });
  });

  it("reads each hostile proxy view and data descriptor only once", () => {
    const reads = {
      prototype: 0,
      keys: 0,
      alphaDescriptor: 0,
      nestedDescriptor: 0,
    };
    const target = { alpha: "one", nested: { beta: "two" } };
    const proxy = new Proxy(target, {
      getPrototypeOf(current) {
        reads.prototype += 1;
        return Reflect.getPrototypeOf(current);
      },
      ownKeys(current) {
        reads.keys += 1;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor(current, property) {
        if (property === "alpha") reads.alphaDescriptor += 1;
        if (property === "nested") reads.nestedDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    expect(snapshotUntrusted(proxy).status).toBe("ok");
    expect(reads).toEqual({
      prototype: 1,
      keys: 1,
      alphaDescriptor: 1,
      nestedDescriptor: 1,
    });
  });

  it("reads a proxy array length descriptor only once", () => {
    const reads = { prototype: 0, keys: 0, lengthDescriptor: 0, indexDescriptor: 0 };
    const proxy = new Proxy(["one"], {
      getPrototypeOf(current) {
        reads.prototype += 1;
        return Reflect.getPrototypeOf(current);
      },
      ownKeys(current) {
        reads.keys += 1;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor(current, property) {
        if (property === "length") reads.lengthDescriptor += 1;
        else reads.indexDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    expect(snapshotUntrusted(proxy).status).toBe("ok");
    expect(reads).toEqual({
      prototype: 1,
      keys: 1,
      lengthDescriptor: 1,
      indexDescriptor: 1,
    });
  });
});

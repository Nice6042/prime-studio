import { utf8ByteLengthWithin } from "./validation";

export type StrictSnapshotResult =
  | Readonly<{ status: "ok"; value: unknown }>
  | Readonly<{ status: "rejected" }>;

type SnapshotRecord = Record<string, unknown>;

const objectHasOwn = Object.prototype.hasOwnProperty;

/** Unique record/array containers that a snapshot may allocate. */
export const MAX_PROJECT_CHAT_SNAPSHOT_NODES = 10_000;
/** Root is depth zero; every property or array edge increases depth by one. */
export const MAX_PROJECT_CHAT_SNAPSHOT_DEPTH = 64;
/** UTF-8 bytes across logical string/key occurrences, including shared-object edges. */
export const MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES = 8 * 1024 * 1024;
/** Own keys examined, including the non-enumerable array length property. */
export const MAX_PROJECT_CHAT_SNAPSHOT_WORK = 100_000;

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key === "") return false;
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function rejected(): StrictSnapshotResult {
  return { status: "rejected" };
}

export function snapshotUntrusted(value: unknown): StrictSnapshotResult {
  const snapshots = new WeakMap<object, object>();
  const scalarCosts = new WeakMap<object, number>();
  const subtreeHeights = new WeakMap<object, number>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let scalarBytes = 0;
  let work = 0;

  const consumeScalar = (candidate: string): boolean => {
    const bytes = utf8ByteLengthWithin(
      candidate,
      MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES - scalarBytes,
    );
    if (bytes === undefined) return false;
    scalarBytes += bytes;
    return true;
  };

  const consumeScalarBytes = (bytes: number): boolean => {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_PROJECT_CHAT_SNAPSHOT_SCALAR_BYTES - scalarBytes
    ) {
      return false;
    }
    scalarBytes += bytes;
    return true;
  };

  const canConsumeWork = (units: number): boolean =>
    Number.isSafeInteger(units) &&
    units >= 0 &&
    units <= MAX_PROJECT_CHAT_SNAPSHOT_WORK - work;

  const cachedSubtreeHeight = (candidate: unknown): number | undefined =>
    typeof candidate === "object" && candidate !== null
      ? subtreeHeights.get(candidate)
      : 0;

  const visit = (candidate: unknown, depth: number): StrictSnapshotResult => {
    if (depth > MAX_PROJECT_CHAT_SNAPSHOT_DEPTH) return rejected();
    if (typeof candidate !== "object" || candidate === null) {
      if (typeof candidate === "string" && !consumeScalar(candidate)) {
        return rejected();
      }
      return { status: "ok", value: candidate };
    }

    const previous = snapshots.get(candidate);
    if (previous) {
      if (active.has(candidate)) return rejected();
      const scalarCost = scalarCosts.get(candidate);
      const subtreeHeight = subtreeHeights.get(candidate);
      return scalarCost !== undefined &&
        subtreeHeight !== undefined &&
        depth + subtreeHeight <= MAX_PROJECT_CHAT_SNAPSHOT_DEPTH &&
        consumeScalarBytes(scalarCost)
        ? { status: "ok", value: previous }
        : rejected();
    }
    if (active.has(candidate)) return rejected();
    if (nodes >= MAX_PROJECT_CHAT_SNAPSHOT_NODES) return rejected();
    nodes += 1;
    const scalarStart = scalarBytes;
    let subtreeHeight = 0;

    active.add(candidate);
    try {
      const isArray = Array.isArray(candidate);
      let arrayLengthDescriptor: PropertyDescriptor | undefined;
      if (isArray) {
        arrayLengthDescriptor = Object.getOwnPropertyDescriptor(
          candidate,
          "length",
        );
        const length = arrayLengthDescriptor?.value;
        if (
          !arrayLengthDescriptor ||
          arrayLengthDescriptor.enumerable ||
          !objectHasOwn.call(arrayLengthDescriptor, "value") ||
          typeof length !== "number" ||
          !Number.isInteger(length) ||
          length < 0 ||
          length > 2 ** 32 - 1 ||
          !canConsumeWork(length + 1)
        ) {
          return rejected();
        }
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (
        isArray
          ? prototype !== Array.prototype && prototype !== null
          : prototype !== Object.prototype && prototype !== null
      ) {
        return rejected();
      }

      const keys = Reflect.ownKeys(candidate);
      if (!canConsumeWork(keys.length)) return rejected();
      work += keys.length;
      const seenKeys = new Set<string>();
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        if (typeof key !== "string" || seenKeys.has(key)) return rejected();
        seenKeys.add(key);
        if (key !== "length" || !isArray) {
          if (!consumeScalar(key)) return rejected();
        }

        const descriptor =
          isArray && key === "length"
            ? arrayLengthDescriptor
            : Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !objectHasOwn.call(descriptor, "value")) {
          return rejected();
        }
        if (isArray && key === "length") {
          descriptors.set(key, descriptor);
          continue;
        }
        if (!descriptor.enumerable) return rejected();
        descriptors.set(key, descriptor);
      }

      if (isArray) {
        const lengthDescriptor = arrayLengthDescriptor;
        if (
          !lengthDescriptor ||
          lengthDescriptor.enumerable ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 2 ** 32 - 1
        ) {
          return rejected();
        }
        const length = lengthDescriptor.value;
        for (const key of descriptors.keys()) {
          if (key !== "length" && !isCanonicalArrayIndex(key, length)) {
            return rejected();
          }
        }
        if (descriptors.size !== length + 1) return rejected();

        const snapshot: unknown[] = [];
        Object.setPrototypeOf(snapshot, null);
        snapshots.set(candidate, snapshot);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors.get(String(index));
          if (!descriptor || !descriptor.enumerable) return rejected();
          const child = visit(descriptor.value, depth + 1);
          if (child.status === "rejected") return child;
          const childHeight = cachedSubtreeHeight(descriptor.value);
          if (childHeight === undefined) return rejected();
          subtreeHeight = Math.max(subtreeHeight, childHeight + 1);
          Object.defineProperty(snapshot, String(index), {
            configurable: true,
            enumerable: true,
            value: child.value,
            writable: true,
          });
        }
        scalarCosts.set(candidate, scalarBytes - scalarStart);
        subtreeHeights.set(candidate, subtreeHeight);
        return { status: "ok", value: snapshot };
      }

      const snapshot = Object.create(null) as SnapshotRecord;
      snapshots.set(candidate, snapshot);
      for (const [key, descriptor] of descriptors) {
        const child = visit(descriptor.value, depth + 1);
        if (child.status === "rejected") return child;
        const childHeight = cachedSubtreeHeight(descriptor.value);
        if (childHeight === undefined) return rejected();
        subtreeHeight = Math.max(subtreeHeight, childHeight + 1);
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          value: child.value,
          writable: true,
        });
      }
      scalarCosts.set(candidate, scalarBytes - scalarStart);
      subtreeHeights.set(candidate, subtreeHeight);
      return { status: "ok", value: snapshot };
    } catch {
      return rejected();
    } finally {
      active.delete(candidate);
    }
  };

  try {
    return visit(value, 0);
  } catch {
    return rejected();
  }
}

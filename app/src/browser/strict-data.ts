export type PlainDataRecord = Record<string, unknown>;

export const DEFAULT_MAX_DATA_ARRAY_ITEMS = 256;
const MAX_SUPPORTED_DATA_ARRAY_ITEMS = 4_096;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Copies a closed plain-data object without invoking property getters.
 * Reflection is contained because revoked or adversarial proxies may throw.
 */
export function readDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): PlainDataRecord | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > allowed.size) return null;
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (requiredKeys.some((key) => !hasOwn(value, key))) return null;

    const copy: PlainDataRecord = {};
    for (const key of ownKeys) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

/** Copies a dense, undecorated array through data descriptors only. */
export function readDataArray(
  value: unknown,
  maxItems = DEFAULT_MAX_DATA_ARRAY_ITEMS,
): readonly unknown[] | null {
  try {
    if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > MAX_SUPPORTED_DATA_ARRAY_ITEMS) return null;
    if (!Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxItems) return null;

    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return null;
    }

    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!hasOwn(value, key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return null;
  }
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (!seen.has(object)) {
      seen.add(object);
      for (const child of Object.values(object)) deepFreeze(child, seen);
      Object.freeze(object);
    }
  }
  return value;
}

export const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const nonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

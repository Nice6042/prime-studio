export type BrowserJsonPrimitive = null | boolean | number | string;
export type BrowserJsonValue = BrowserJsonPrimitive | BrowserJsonValue[] | { [key: string]: BrowserJsonValue };

const MAX_TRANSPORT_BYTES = 262_144;
const MAX_DEPTH = 32;
const MAX_NODES = 2_048;
const MAX_STRING_CHARACTERS = 131_072;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 64;

interface ScanFrame {
  readonly kind: "array" | "object";
  readonly keys?: Set<string>;
}

function hasDuplicateObjectKey(input: string): boolean {
  const stack: ScanFrame[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      const start = index;
      index += 1;
      for (; index < input.length; index += 1) {
        if (input[index] === "\\") {
          index += 1;
          continue;
        }
        if (input[index] === '"') break;
      }
      if (index >= input.length) return false;
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) lookahead += 1;
      if (input[lookahead] === ":") {
        const frame = stack[stack.length - 1];
        if (frame?.kind !== "object" || !frame.keys) return false;
        try {
          const key = JSON.parse(input.slice(start, index + 1)) as string;
          if (frame.keys.has(key)) return true;
          frame.keys.add(key);
        } catch {
          return false;
        }
      }
      continue;
    }
    if (character === "{") stack.push({ kind: "object", keys: new Set<string>() });
    else if (character === "[") stack.push({ kind: "array" });
    else if (character === "}" || character === "]") stack.pop();
  }
  return false;
}

function withinAggregateBudget(root: unknown): root is BrowserJsonValue {
  let nodes = 0;
  let stringCharacters = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES || current.depth > MAX_DEPTH) return false;
    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === "string") {
      stringCharacters += value.length;
      if (stringCharacters > MAX_STRING_CHARACTERS) return false;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) return false;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > MAX_OBJECT_KEYS) return false;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stringCharacters += key.length;
      if (stringCharacters > MAX_STRING_CHARACTERS) return false;
      pending.push({ value: record[key], depth: current.depth + 1 });
    }
  }
  return true;
}

/** Authority transport accepts only bounded JSON text, never caller-owned objects. */
export function decodeBrowserTransport(input: unknown): BrowserJsonValue | null {
  if (typeof input !== "string" || input.length > MAX_TRANSPORT_BYTES || hasDuplicateObjectKey(input)) return null;
  try {
    if (new TextEncoder().encode(input).byteLength > MAX_TRANSPORT_BYTES) return null;
    const parsed: unknown = JSON.parse(input);
    return withinAggregateBudget(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function canonicalBrowserJson(value: BrowserJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBrowserJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBrowserJson(value[key]!)}`)
    .join(",")}}`;
}

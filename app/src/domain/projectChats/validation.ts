export const MAX_PROJECT_CHAT_ID_BYTES = 128;
export const MAX_PROJECT_CHAT_LABEL_SCALARS = 200;
export const MAX_PRIME_SESSION_FILE_BYTES = 255;
export const MAX_PROJECT_CHAT_JSON_BYTES = 8 * 1024 * 1024;

const ASCII_SPACE = 0x20;
const ASCII_TILDE = 0x7e;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const UNSAFE_LABEL_CATEGORY = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const PRIME_SESSION_FILE_CHARACTER = /^[A-Za-z0-9._-]+$/;

/** Printable ASCII, 1-128 bytes, with no leading or trailing ASCII space. */
export function isProjectChatId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROJECT_CHAT_ID_BYTES ||
    value.charCodeAt(0) === ASCII_SPACE ||
    value.charCodeAt(value.length - 1) === ASCII_SPACE
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < ASCII_SPACE || codeUnit > ASCII_TILDE) return false;
  }
  return true;
}

/**
 * Already-trimmed text containing 1-200 Unicode scalar values and no
 * C0/C1 controls, DEL, format controls, line separators, or paragraph separators.
 */
export function isProjectChatLabel(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROJECT_CHAT_LABEL_SCALARS * 2 ||
    value.trim() !== value ||
    UNSAFE_LABEL_CATEGORY.test(value)
  ) {
    return false;
  }

  let scalarCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first <= 0x1f || (first >= 0x7f && first <= 0x9f)) return false;
    if (first >= HIGH_SURROGATE_START && first <= HIGH_SURROGATE_END) {
      const second = value.charCodeAt(index + 1);
      if (second < LOW_SURROGATE_START || second > LOW_SURROGATE_END) return false;
      index += 1;
    } else if (first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END) {
      return false;
    }
    scalarCount += 1;
    if (scalarCount > MAX_PROJECT_CHAT_LABEL_SCALARS) return false;
  }
  return scalarCount > 0;
}

/** Non-authoritative Prime transcript leaf name; never a path. */
export function isPrimeSessionFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PRIME_SESSION_FILE_BYTES &&
    value !== "." &&
    value !== ".." &&
    PRIME_SESSION_FILE_CHARACTER.test(value)
  );
}

/** Returns the UTF-8 byte count only when it is within the caller's cap. */
export function utf8ByteLengthWithin(
  value: string,
  maximum: number,
): number | undefined {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || value.length > maximum) {
    return undefined;
  }

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first <= 0x7f) {
      bytes += 1;
    } else if (first <= 0x7ff) {
      bytes += 2;
    } else if (first >= HIGH_SURROGATE_START && first <= HIGH_SURROGATE_END) {
      const second = value.charCodeAt(index + 1);
      if (second >= LOW_SURROGATE_START && second <= LOW_SURROGATE_END) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

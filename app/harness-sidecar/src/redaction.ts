const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s]+/gi,
  /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|secret(?:[_-]access[_-]key)?|password)\b\s*(?:[=:]\s*|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
];

const WINDOWS_PROFILE = /[A-Za-z]:\\Users\\[^\\\s]+\\(?:AppData|\.prime|\.codex)(?:\\[^\s]*)?/gi;
const UNIX_PROFILE = /\/(?:home|Users)\/[^/\s]+\/(?:\.prime|\.codex|Library)(?:\/[^\s]*)?/g;

const ACTIVITY_WINDOWS_PROFILE = /[A-Za-z]:\\Users\\[^\\\r\n"'`]+(?:\\[^\r\n"'`|<>]*)?/gi;
const ACTIVITY_UNIX_PROFILE = /\/(?:home|Users)\/[^/\r\n"'`]+(?:\/[^\r\n"'`|<>]*)?/g;
const UNSAFE_VISIBLE_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const ESCAPED_TEXT_PREFIX = "[escaped] ";
const MAX_ACTIVITY_INPUT_CODE_POINTS = 32_768;
const MAX_ACTIVITY_COMMAND_CODE_POINTS = 2_048;

export interface SanitizedActivityCommand {
  readonly command: string;
  readonly redacted: boolean;
}

function boundedCodePoints(value: string, maximum: number): Readonly<{ value: string; truncated: boolean }> {
  const points = [...value];
  if (points.length <= maximum) return { value, truncated: false };
  return { value: points.slice(0, maximum).join(""), truncated: true };
}

function visualizeUnsafeText(value: string): Readonly<{ value: string; changed: boolean }> {
  if (!UNSAFE_VISIBLE_CHARACTER.test(value) && !value.startsWith(ESCAPED_TEXT_PREFIX)) {
    return { value, changed: false };
  }
  let visible = ESCAPED_TEXT_PREFIX;
  for (const character of value) {
    if (character === "\\") visible += "\\\\";
    else if (character === "\n") visible += "\\n";
    else if (character === "\r") visible += "\\r";
    else if (character === "\t") visible += "\\t";
    else if (UNSAFE_VISIBLE_CHARACTER.test(character)) visible += `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`;
    else visible += character;
  }
  return { value: visible, changed: true };
}

/**
 * Converts an untrusted Prime tool argument into the only command value that
 * may cross the sidecar/renderer boundary.
 */
export function sanitizeActivityCommand(value: unknown): SanitizedActivityCommand {
  const input = boundedCodePoints(typeof value === "string" ? value : "Tool", MAX_ACTIVITY_INPUT_CODE_POINTS);
  let command = input.value;
  let redacted = input.truncated;
  for (const pattern of SECRET_PATTERNS) {
    const next = command.replace(pattern, "[REDACTED_SECRET]");
    redacted ||= next !== command;
    command = next;
  }
  for (const pattern of [ACTIVITY_WINDOWS_PROFILE, ACTIVITY_UNIX_PROFILE]) {
    const next = command.replace(pattern, "[REDACTED_PROFILE_PATH]");
    redacted ||= next !== command;
    command = next;
  }
  const visible = visualizeUnsafeText(command);
  redacted ||= visible.changed;
  const output = boundedCodePoints(visible.value, MAX_ACTIVITY_COMMAND_CODE_POINTS);
  redacted ||= output.truncated;
  return Object.freeze({ command: output.value || "Tool", redacted });
}

export function sanitizeDiagnostic(value: unknown): string {
  let text = String(value).slice(0, 4096);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  text = text.replace(WINDOWS_PROFILE, "[REDACTED_PROFILE_PATH]");
  text = text.replace(UNIX_PROFILE, "[REDACTED_PROFILE_PATH]");
  return text;
}

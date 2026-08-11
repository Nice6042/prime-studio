const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s]+/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
];

const WINDOWS_PROFILE = /[A-Za-z]:\\Users\\[^\\\s]+\\(?:AppData|\.prime|\.codex)(?:\\[^\s]*)?/gi;
const UNIX_PROFILE = /\/(?:home|Users)\/[^/\s]+\/(?:\.prime|\.codex|Library)(?:\/[^\s]*)?/g;

export function sanitizeDiagnostic(value: unknown): string {
  let text = String(value).slice(0, 4096);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  text = text.replace(WINDOWS_PROFILE, "[REDACTED_PROFILE_PATH]");
  text = text.replace(UNIX_PROFILE, "[REDACTED_PROFILE_PATH]");
  return text;
}

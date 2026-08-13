import type { AppSettings } from "../../types";

export function residentCreationDisabledReason(settings: AppSettings): string | null {
  const selected = [
    settings.defaultAccount ? "account" : null,
    settings.defaultProvider ? "provider" : null,
    settings.defaultModel ? "model" : null,
    settings.defaultThinking ? "thinking" : null,
  ].filter((value): value is string => value !== null);
  if (selected.length === 0) return null;
  return `New chat is disabled because the verified resident creation route cannot bind the selected ${selected.join(", ")}. Reset ${selected.length === 1 ? "it" : "them"} to Harness default before creating a chat.`;
}

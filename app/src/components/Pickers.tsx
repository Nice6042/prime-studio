import { useMemo } from "react";
import { THINKING_LEVELS } from "../types";
import type { ModelInfo, ThinkingLevel } from "../types";

/**
 * The two controls that make Prime what it is: provider+model and thinking level
 * both switch mid-conversation (context and kernel state survive). Shared so the
 * top bar and the session rail can never drift apart.
 */
export function ModelSelect({
  models,
  model,
  onModel,
  className = "picker",
}: {
  models: ModelInfo[];
  model: { provider: string; model: string } | null;
  onModel: (provider: string, model: string) => void;
  className?: string;
}) {
  const grouped = useMemo(() => {
    const by = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = by.get(m.provider) ?? [];
      list.push(m);
      by.set(m.provider, list);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  return (
    <select
      className={className}
      value={model ? `${model.provider} ${model.model}` : ""}
      title="Provider + model — switch mid-conversation"
      onChange={(e) => {
        const [provider, id] = e.target.value.split(" ");
        if (provider && id) onModel(provider, id);
      }}
    >
      {!model && <option value="">{models.length ? "Default model" : "No models"}</option>}
      {grouped.map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((m) => (
            <option key={`${provider}/${m.model}`} value={`${provider} ${m.model}`}>
              {m.name ?? m.model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function ThinkingSelect({
  thinking,
  onThinking,
  className = "picker picker-sm",
}: {
  thinking: ThinkingLevel;
  onThinking: (l: ThinkingLevel) => void;
  className?: string;
}) {
  return (
    <select
      className={className}
      value={thinking}
      title="Thinking level"
      onChange={(e) => onThinking(e.target.value as ThinkingLevel)}
    >
      {THINKING_LEVELS.map((l) => (
        <option key={l} value={l}>
          think: {l}
        </option>
      ))}
    </select>
  );
}

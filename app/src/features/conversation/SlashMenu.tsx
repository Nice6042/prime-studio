import type { SlashCommand } from "./composerModel";
import { controlBinding } from "./controlBinding";

export function SlashMenu({ commands, onSelect }: {
  readonly commands: readonly SlashCommand[];
  readonly onSelect: (command: SlashCommand) => void;
}) {
  if (commands.length === 0) return null;
  return <div className="composer-slash-menu" role="listbox" aria-label="Slash commands">
    {commands.map((command) => <button type="button" {...controlBinding(`slash-${command.id}`, "composer.slash.select", command.enabled ? null : (command.unavailableReason ?? "This slash command is unavailable."))} role="option" aria-selected="false" key={command.id} disabled={!command.enabled} title={command.unavailableReason} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command)}>
      <strong>{command.label}</strong><span>{command.unavailableReason ?? command.description}</span>
    </button>)}
  </div>;
}

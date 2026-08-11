import type { SlashCommand } from "./composerModel";

export function SlashMenu({ commands, onSelect }: {
  readonly commands: readonly SlashCommand[];
  readonly onSelect: (command: SlashCommand) => void;
}) {
  if (commands.length === 0) return null;
  return <div className="composer-slash-menu" role="listbox" aria-label="Slash commands">
    {commands.map((command) => <button type="button" role="option" aria-selected="false" key={command.id} disabled={!command.enabled} title={command.unavailableReason} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command)}>
      <strong>{command.label}</strong><span>{command.unavailableReason ?? command.description}</span>
    </button>)}
  </div>;
}

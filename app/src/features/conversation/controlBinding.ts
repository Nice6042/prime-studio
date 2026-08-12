import { createControlBinding, type StudioActionId } from "../../contracts/studioOperations";

export function controlBinding(controlId: string, action: StudioActionId, disabledReason: string | null = null) {
  const binding = createControlBinding(controlId, action, disabledReason);
  return {
    "data-control-id": binding.controlId,
    "data-studio-action": binding.action,
  } as const;
}

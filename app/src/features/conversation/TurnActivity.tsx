import type { MessageBlock } from "../../shared/ipc/harness.generated";

export function TurnActivity({ blocks }: { readonly blocks: readonly MessageBlock[] }) {
  const activityCount = blocks.filter((block) => block.kind !== "text").length;
  if (activityCount === 0) return null;
  return <span className="sr-only">{activityCount} activity items are available in the Harness inspector.</span>;
}

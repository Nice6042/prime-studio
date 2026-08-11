import type { AttachmentMetadata } from "./composerModel";

export function AttachmentChips({ attachments, onRemove }: {
  readonly attachments: readonly AttachmentMetadata[];
  readonly onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return <div className="composer-attachments" aria-label="Attachments">
    {attachments.map((attachment) => <span className="composer-attachment" key={attachment.id}>
      <span title={attachment.name}>{attachment.name}</span>
      {onRemove && <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}>Remove</button>}
    </span>)}
  </div>;
}

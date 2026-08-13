import type { HarnessCursor, ParentMessage } from "../../shared/ipc/harness.generated";

export interface ParentTranscriptState {
  readonly cursor: HarnessCursor | null;
  readonly messages: readonly ParentMessage[];
  readonly omittedBefore: number;
  readonly payloadClipped: boolean;
}

export type ParentTranscriptEvent =
  | Readonly<{
      type: "snapshot";
      cursor: HarnessCursor;
      messages: readonly ParentMessage[];
      omittedBefore: number;
    }>
  | Readonly<{
      type: "message";
      cursor: HarnessCursor;
      message: ParentMessage;
    }>;

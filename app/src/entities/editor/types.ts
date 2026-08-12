export interface ArtifactRef {
  readonly brokerId: string;
  readonly rootSessionId: string;
  readonly artifactId: string;
  readonly revision: number;
}

export interface CanvasRef {
  readonly chatId: string;
  readonly messageId: string;
  readonly displayRevision: number;
}

export interface StructuredDiffRow {
  readonly kind: "context" | "add" | "delete";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface ArtifactDocument {
  readonly label: string;
  readonly ref: ArtifactRef;
  readonly identity: string;
  readonly content: string;
  readonly writable: boolean;
  readonly diff: readonly StructuredDiffRow[];
}

export interface ArtifactSaveRequest {
  readonly ref: ArtifactRef;
  readonly expectedRevision: number;
  readonly expectedIdentity: string;
  readonly content: string;
}

export type ArtifactSaveResult =
  | Readonly<{ kind: "saved"; revision: number; identity: string }>
  | Readonly<{ kind: "conflict" | "unsupported" | "error"; message: string }>;

export type ArtifactOpenResult =
  | Readonly<{ kind: "opened"; document: ArtifactDocument }>
  | Readonly<{ kind: "unsupported"; reason: string }>;

export type EditorTab =
  | Readonly<{ id: string; kind: "artifact"; label: string; ref: ArtifactRef; brokerRef: ArtifactRef; identity: string; revision: number; originalContent: string; content: string; dirty: boolean; writable: boolean }>
  | Readonly<{ id: string; kind: "canvas"; label: string; ref: CanvasRef; brokerRef: null; identity: null; revision: number; originalContent: string; content: string; dirty: boolean; writable: true }>;

export interface EditorState {
  readonly tabs: readonly EditorTab[];
  readonly activeTabId: string | null;
}

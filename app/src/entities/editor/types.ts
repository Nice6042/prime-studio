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

export type EditorTab =
  | Readonly<{ id: string; kind: "artifact"; label: string; ref: ArtifactRef; brokerRef: ArtifactRef; identity: string; revision: number; originalContent: string; content: string; dirty: boolean; writable: boolean }>
  | Readonly<{ id: string; kind: "canvas"; label: string; ref: CanvasRef; brokerRef: null; identity: null; revision: number; originalContent: string; content: string; dirty: boolean; writable: true }>;

export interface EditorState {
  readonly tabs: readonly EditorTab[];
  readonly activeTabId: string | null;
}

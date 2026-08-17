import type { ArtifactDocument } from "../../entities/editor/types";

export const MAX_EDITOR_BUFFER_ENTRIES = 64;
export const MAX_EDITOR_BUFFER_CODE_UNITS = 2 * 1024 * 1024;
export const MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS = 8 * 1024 * 1024;
const MAX_EDITOR_DOCUMENT_ID_CODE_UNITS = 2_048;
const UNSAFE_DOCUMENT_ID_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export interface CanvasEditorIdentity {
  readonly sessionId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly sourceVersion: number;
  readonly displayRevision: number;
}

export interface EditorBufferState {
  readonly order: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly totalCodeUnits: number;
}

function own(record: Readonly<Record<string, string>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function freezeValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const detached = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) detached[key] = value;
  return Object.freeze(detached);
}

function frozenState(
  order: readonly string[],
  values: Readonly<Record<string, string>>,
  totalCodeUnits: number,
): EditorBufferState {
  return Object.freeze({
    order: Object.freeze([...order]),
    values: freezeValues(values),
    totalCodeUnits,
  });
}

export function createEditorBufferState(): EditorBufferState {
  return frozenState([], Object.create(null) as Record<string, string>, 0);
}

function assertDocumentId(documentId: string): void {
  if (
    typeof documentId !== "string"
    || documentId.length === 0
    || documentId.length > MAX_EDITOR_DOCUMENT_ID_CODE_UNITS
    || UNSAFE_DOCUMENT_ID_CHARACTER.test(documentId)
  ) throw new TypeError("Editor document identity is invalid.");
}

export function boundEditorBufferContent(content: string): string {
  if (content.length <= MAX_EDITOR_BUFFER_CODE_UNITS) return content;
  let end = MAX_EDITOR_BUFFER_CODE_UNITS;
  const finalCodeUnit = content.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return content.slice(0, end);
}

export function artifactEditorDocumentId(document: ArtifactDocument): string {
  return JSON.stringify([
    "artifact",
    document.ref.brokerId,
    document.ref.rootSessionId,
    document.ref.artifactId,
    document.ref.revision,
    document.identity,
  ]);
}

export function canvasEditorDocumentId(document: CanvasEditorIdentity): string {
  return JSON.stringify([
    "canvas",
    document.sessionId,
    document.chatId,
    document.messageId,
    document.sourceVersion,
    document.displayRevision,
  ]);
}

export function readEditorBuffer(state: EditorBufferState, documentId: string): string | undefined {
  assertDocumentId(documentId);
  return own(state.values, documentId) ? state.values[documentId] : undefined;
}

export function writeEditorBuffer(
  state: EditorBufferState,
  documentId: string,
  content: string,
): EditorBufferState {
  assertDocumentId(documentId);
  if (typeof content !== "string") throw new TypeError("Editor buffer content is invalid.");

  const nextContent = boundEditorBufferContent(content);
  const previousLength = own(state.values, documentId) ? state.values[documentId]!.length : 0;
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(state.values)) values[key] = value;
  values[documentId] = nextContent;
  const order = [...state.order.filter((candidate) => candidate !== documentId), documentId];
  let totalCodeUnits = state.totalCodeUnits - previousLength + nextContent.length;

  while (
    order.length > MAX_EDITOR_BUFFER_ENTRIES
    || totalCodeUnits > MAX_EDITOR_BUFFER_TOTAL_CODE_UNITS
  ) {
    const evicted = order.shift();
    if (evicted === undefined) break;
    if (own(values, evicted)) {
      totalCodeUnits -= values[evicted]!.length;
      delete values[evicted];
    }
  }

  return frozenState(order, values, totalCodeUnits);
}

export function removeEditorBuffer(state: EditorBufferState, documentId: string): EditorBufferState {
  assertDocumentId(documentId);
  if (!own(state.values, documentId)) return state;

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(state.values)) {
    if (key !== documentId) values[key] = value;
  }
  return frozenState(
    state.order.filter((candidate) => candidate !== documentId),
    values,
    state.totalCodeUnits - state.values[documentId]!.length,
  );
}

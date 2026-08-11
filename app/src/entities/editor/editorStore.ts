import type { ArtifactRef, EditorState, EditorTab } from "./types";

const MAX_EDITOR_CONTENT = 2 * 1024 * 1024;

export type EditorIntent =
  | Readonly<{ type: "artifact/open"; ref: ArtifactRef; label: string; content: string; identity: string; writable: boolean }>
  | Readonly<{ type: "canvas/open"; chatId: string; messageId: string; displayRevision: number; content: string }>
  | Readonly<{ type: "tab/select"; tabId: string }>
  | Readonly<{ type: "tab/close"; tabId: string }>
  | Readonly<{ type: "buffer/change"; tabId: string; content: string }>
  | Readonly<{ type: "save/succeeded"; tabId: string; expectedRevision: number; revision: number; identity: string }>;

export function createEditorState(): EditorState {
  return Object.freeze({ tabs: Object.freeze([]), activeTabId: null });
}

function safeText(value: string, max = 512) {
  return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function replaceTab(state: EditorState, tabId: string, replace: (tab: EditorTab) => EditorTab): EditorState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const replacement = replace(state.tabs[index]!);
  if (replacement === state.tabs[index]) return state;
  const tabs = state.tabs.map((tab, candidate) => candidate === index ? Object.freeze(replacement) : tab);
  return Object.freeze({ ...state, tabs: Object.freeze(tabs) });
}

export function reduceEditorState(state: EditorState, intent: EditorIntent): EditorState {
  switch (intent.type) {
    case "artifact/open": {
      if (intent.content.length > MAX_EDITOR_CONTENT || !safeText(intent.label) || !safeText(intent.identity, 1024)) return state;
      const id = `artifact:${intent.ref.brokerId}:${intent.ref.rootSessionId}:${intent.ref.artifactId}`;
      const existing = state.tabs.find((tab) => tab.id === id);
      if (existing) return Object.freeze({ ...state, activeTabId: id });
      const tab: EditorTab = Object.freeze({ id, kind: "artifact", label: intent.label, ref: Object.freeze({ ...intent.ref }), brokerRef: Object.freeze({ ...intent.ref }), identity: intent.identity, revision: intent.ref.revision, originalContent: intent.content, content: intent.content, dirty: false, writable: intent.writable });
      return Object.freeze({ tabs: Object.freeze([...state.tabs, tab].slice(-12)), activeTabId: id });
    }
    case "canvas/open": {
      if (intent.content.length > MAX_EDITOR_CONTENT || !safeText(intent.chatId) || !safeText(intent.messageId)) return state;
      const id = `canvas:${intent.chatId}:${intent.messageId}`;
      const tab: EditorTab = Object.freeze({ id, kind: "canvas", label: "Canvas", ref: Object.freeze({ chatId: intent.chatId, messageId: intent.messageId, displayRevision: intent.displayRevision }), brokerRef: null, identity: null, revision: intent.displayRevision, originalContent: intent.content, content: intent.content, dirty: false, writable: true });
      const tabs = state.tabs.some((candidate) => candidate.id === id) ? state.tabs.map((candidate) => candidate.id === id ? tab : candidate) : [...state.tabs, tab].slice(-12);
      return Object.freeze({ tabs: Object.freeze(tabs), activeTabId: id });
    }
    case "tab/select": return state.tabs.some((tab) => tab.id === intent.tabId) ? Object.freeze({ ...state, activeTabId: intent.tabId }) : state;
    case "tab/close": {
      const index = state.tabs.findIndex((tab) => tab.id === intent.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== intent.tabId);
      const activeTabId = state.activeTabId === intent.tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTabId;
      return Object.freeze({ tabs: Object.freeze(tabs), activeTabId });
    }
    case "buffer/change": {
      if (intent.content.length > MAX_EDITOR_CONTENT) return state;
      return replaceTab(state, intent.tabId, (tab) => ({ ...tab, content: intent.content, dirty: intent.content !== tab.originalContent }));
    }
    case "save/succeeded": return replaceTab(state, intent.tabId, (tab) => {
      if (tab.kind !== "artifact" || tab.revision !== intent.expectedRevision || !tab.writable) return tab;
      return { ...tab, revision: intent.revision, identity: intent.identity, ref: { ...tab.ref, revision: intent.revision }, brokerRef: { ...tab.brokerRef, revision: intent.revision }, originalContent: tab.content, dirty: false };
    });
  }
}

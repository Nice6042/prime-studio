import { useEffect, useState } from "react";

import * as rpc from "../rpc";
import type { LayoutPreferencesV1 } from "../types";
import { RuntimeStatusBar } from "../features/shell/RuntimeStatusBar";
import { TitleBar } from "../features/shell/TitleBar";
import { WorkspaceShell } from "../features/shell/WorkspaceShell";
import { useStudioSelector } from "./AppProviders";

function useViewportWidth() {
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export function StudioApp() {
  const navigation = useStudioSelector((state) => state.navigation);
  const selectedChat = useStudioSelector((state) => navigation.selectedChatId ? state.chats[navigation.selectedChatId] : null);
  const selectedSession = useStudioSelector((state) => Object.values(state.sessions).find((session) => session.chatId === navigation.selectedChatId) ?? null);
  const compatibility = useStudioSelector((state) => state.compatibility);
  const viewport = useViewportWidth();
  const [layout, setLayout] = useState<LayoutPreferencesV1>({
    schemaVersion: 1,
    sidebarOpen: true,
    sidebarWidth: 264,
    inspectorOpen: true,
    inspectorWidth: 384,
    editorOpen: false,
    editorWidth: 400,
  });

  useEffect(() => {
    let active = true;
    void rpc.getLayoutPreferences().then((preferences) => {
      if (active) setLayout(preferences);
    });
    return () => { active = false; };
  }, []);

  const changeLayout = (patch: Partial<LayoutPreferencesV1>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    void rpc.setLayoutPreferences(next).catch(() => undefined);
  };

  if (navigation.route === "settings") {
    return <main aria-label="Settings"><h1>Settings</h1></main>;
  }

  const title = selectedChat?.title ?? "Prime Studio";
  return <div className="studio-application">
    <TitleBar title={title} />
    <WorkspaceShell
      viewport={viewport}
      sidebar={{ open: layout.sidebarOpen, preferred: layout.sidebarWidth }}
      inspector={{ open: layout.inspectorOpen, preferred: layout.inspectorWidth }}
      editor={{ open: layout.editorOpen, preferred: layout.editorWidth }}
      conversationLabel={title}
      onSidebarPreferred={(sidebarWidth) => changeLayout({ sidebarWidth })}
      onInspectorPreferred={(inspectorWidth) => changeLayout({ inspectorWidth })}
      onEditorPreferred={(editorWidth) => changeLayout({ editorWidth })}
      sidebarContent={<div><strong>Prime Studio</strong><p>Projects and chats</p></div>}
      conversation={<section aria-label={title}><h1>{title}</h1><p>Parent conversation</p></section>}
      inspectorContent={<div><strong>Harness</strong><p>{compatibility.status.replace("_", " ")}</p></div>}
    />
    <RuntimeStatusBar session={selectedSession} />
  </div>;
}

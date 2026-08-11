import { useStudioSelector } from "./AppProviders";

export function StudioApp() {
  const navigation = useStudioSelector((state) => state.navigation);
  const selectedChat = useStudioSelector((state) => navigation.selectedChatId ? state.chats[navigation.selectedChatId] : null);

  if (navigation.route === "settings") {
    return <main aria-label="Settings"><h1>Settings</h1></main>;
  }

  return (
    <main aria-label={selectedChat?.title ?? "Prime Studio workspace"}>
      <h1>{selectedChat?.title ?? "Prime Studio"}</h1>
    </main>
  );
}

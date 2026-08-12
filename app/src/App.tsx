import { AppProviders } from "./app/AppProviders";
import { StudioApp } from "./app/StudioApp";
import { createStudioStore, initialStudioState } from "./shared/state/store";

const studioStore = createStudioStore(initialStudioState());

export default function App() {
  return (
    <AppProviders store={studioStore}>
      <StudioApp />
    </AppProviders>
  );
}

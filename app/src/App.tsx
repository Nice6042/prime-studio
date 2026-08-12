import { AppProviders } from "./app/AppProviders";
import { StudioApp } from "./app/StudioApp";
import { createStudioStore, initialStudioState } from "./shared/state/store";
import { createProductionHarnessInspectorAdapter } from "./features/harness/productionAdapter";

const studioStore = createStudioStore(initialStudioState());
const harnessAdapter = createProductionHarnessInspectorAdapter(studioStore);

export default function App() {
  return (
    <AppProviders store={studioStore}>
      <StudioApp harnessAdapter={harnessAdapter} />
    </AppProviders>
  );
}

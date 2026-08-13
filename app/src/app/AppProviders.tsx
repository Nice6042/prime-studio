import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";

import type { StudioAppState, StudioStore } from "../shared/state/store";

const StudioStoreContext = createContext<StudioStore | null>(null);

export function AppProviders({ children, store }: { children: ReactNode; store: StudioStore }) {
  return <StudioStoreContext.Provider value={store}>{children}</StudioStoreContext.Provider>;
}

export function useStudioStore(): StudioStore {
  const store = useContext(StudioStoreContext);
  if (!store) throw new Error("Studio store is unavailable.");
  return store;
}

export function useStudioSelector<T>(selector: (state: StudioAppState) => T): T {
  const store = useStudioStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()), () => selector(store.getSnapshot()));
}

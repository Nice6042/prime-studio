import type { RootSessionProjection } from "../../entities/harness/types";

export function RuntimeStatusBar({ session }: { readonly session: RootSessionProjection | null }) {
  const status = session ? `${session.state} · ${session.freshness}` : "Harness unavailable";
  return <div className="studio-statusbar" role="status">{status}</div>;
}

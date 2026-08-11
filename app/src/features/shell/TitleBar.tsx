import type { ReactNode } from "react";

export function TitleBar({ title, actions }: { readonly title: string; readonly actions?: ReactNode }) {
  return <div className="studio-titlebar"><strong>{title}</strong><span className="studio-titlebar-actions">{actions}</span></div>;
}

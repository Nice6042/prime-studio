from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


replace_once(
    "app/src/app/StudioApp.tsx",
    '''  useLayoutEffect(() => {
    const hostChanged = previousSidebarHost.current !== workspaceFooterHost;
    previousSidebarHost.current = workspaceFooterHost;
    if (workspaceMenuHostRef.current === null) {
      const controlId = sidebarReplacementFocus.current ?? (hostChanged && sidebarHadFocus.current
        ? workspaceFooterHost === "rail" ? "rail.sidebar.toggle" : workspaceFooterHost === "pane" || workspaceFooterHost === "sheet" ? "sidebar.collapse" : null
        : null);
      const target = controlId ? document.querySelector<HTMLButtonElement>(`[data-control-id="${controlId}"]`) : null;
      if (target) target.focus();
    }
    sidebarReplacementFocus.current = null;
  }, [workspaceFooterHost]);''',
    '''  useLayoutEffect(() => {
    const hostChanged = previousSidebarHost.current !== workspaceFooterHost;
    previousSidebarHost.current = workspaceFooterHost;
    if (workspaceMenuHostRef.current !== null) return;

    const controlId = sidebarReplacementFocus.current ?? (hostChanged && sidebarHadFocus.current
      ? workspaceFooterHost === "rail" ? "rail.sidebar.toggle" : workspaceFooterHost === "pane" || workspaceFooterHost === "sheet" ? "sidebar.collapse" : null
      : null);
    if (!controlId) return;

    let cancelled = false;
    const focusReplacement = () => {
      if (cancelled) return false;
      const target = document.querySelector<HTMLButtonElement>(`[data-control-id="${controlId}"]`);
      if (!target?.isConnected) return false;
      target.focus();
      if (sidebarReplacementFocus.current === controlId) sidebarReplacementFocus.current = null;
      return true;
    };
    if (focusReplacement()) return;
    const frame = window.requestAnimationFrame(() => { focusReplacement(); });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [activeSheet, layout.sidebarOpen, workspaceFooterHost]);''',
)

replace_once(
    "app/src/features/navigation/ProjectSidebar.tsx",
    '''        aria-label={sidebarCommands.collapse.label}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCollapse();
        }}
        onClick={onCollapse}''',
    '''        aria-label={sidebarCommands.collapse.label}
        onClick={onCollapse}''',
)

Path(".github/workflows/fix-sidebar-focus.yml").unlink()
Path(".github/scripts/fix-sidebar-focus.py").unlink()

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PaneSeparator } from "./PaneSeparator";
import { WorkspaceShell } from "./WorkspaceShell";

describe("WorkspaceShell", () => {
  it("renders one navigation, main conversation, and complementary inspector", () => {
    render(
      <WorkspaceShell
        viewport={1440}
        sidebar={{ open: true, preferred: 264 }}
        inspector={{ open: true, preferred: 384 }}
        editor={{ open: false, preferred: 400 }}
        sidebarContent={<div>Projects</div>}
        conversation={<div>Conversation</div>}
        inspectorContent={<div>Harness</div>}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Projects and chats" })).toBeVisible();
    expect(screen.getByRole("main", { name: "Conversation" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Harness" })).toBeVisible();
  });

  it("keeps the package reading order sidebar, conversation, editor, then Harness", () => {
    const { container } = render(
      <WorkspaceShell
        viewport={1800}
        sidebar={{ open: true, preferred: 264 }}
        inspector={{ open: true, preferred: 384 }}
        editor={{ open: true, preferred: 400 }}
        sidebarContent={<div>Projects</div>}
        conversation={<div>Conversation</div>}
        editorContent={<div>Editor</div>}
        inspectorContent={<div>Harness</div>}
      />,
    );
    const regions = Array.from(container.querySelectorAll("nav, main, section[aria-label='Editor'], aside[aria-label='Harness']"));
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "Projects and chats",
      "Conversation",
      "Editor",
      "Harness",
    ]);
  });

  it("resizes with keyboard increments and clamps/reset controls", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(<PaneSeparator label="Resize project sidebar" value={264} min={210} max={380} onChange={onChange} onReset={onReset} />);
    const separator = screen.getByRole("separator", { name: "Resize project sidebar" });

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    fireEvent.doubleClick(separator);

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([272, 232, 210, 380]);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("keeps a visible 52px rail and no horizontal overflow at 640 CSS px (200% desktop zoom)", () => {
    const { container } = render(
      <WorkspaceShell
        viewport={640}
        sidebar={{ open: true, preferred: 264 }}
        inspector={{ open: true, preferred: 384 }}
        editor={{ open: false, preferred: 400 }}
        sidebarContent={<div>Projects</div>}
        conversation={<div>Conversation</div>}
        inspectorContent={<div>Harness</div>}
      />,
    );
    expect((container.firstElementChild as HTMLElement).style.gridTemplateColumns).toBe("52px 8px 580px");
    expect(screen.getByRole("navigation", { name: "Projects and chats" })).toHaveAttribute("data-mode", "rail");
    expect(screen.getByRole("main")).toBeVisible();
  });

  it("uses shared native-compatible inspector bounds on the resize separator", () => {
    render(
      <WorkspaceShell
        viewport={1440}
        sidebar={{ open: false, preferred: 264 }}
        inspector={{ open: true, preferred: 384 }}
        editor={{ open: false, preferred: 400 }}
        sidebarContent={<div>Projects</div>}
        conversation={<div>Conversation</div>}
        inspectorContent={<div>Harness</div>}
        onInspectorPreferred={() => undefined}
      />,
    );
    const separator = screen.getByRole("separator", { name: "Resize Harness inspector" });
    expect(separator).toHaveAttribute("aria-valuemin", "300");
    expect(separator).toHaveAttribute("aria-valuemax", "600");
  });

  it("uses dedicated compact navigation when center pressure collapses the sidebar to a rail", () => {
    render(<WorkspaceShell
      viewport={1280}
      sidebar={{ open: true, preferred: 264 }}
      inspector={{ open: true, preferred: 384 }}
      editor={{ open: true, preferred: 400 }}
      sidebarContent={<div>Full projects</div>}
      sidebarRailContent={<div>Compact projects</div>}
      conversation={<div>Conversation</div>}
      inspectorContent={<div>Harness</div>}
      editorContent={<div>Editor</div>}
    />);
    expect(screen.getByText("Compact projects")).toBeVisible();
    expect(screen.queryByText("Full projects")).not.toBeInTheDocument();
  });
});

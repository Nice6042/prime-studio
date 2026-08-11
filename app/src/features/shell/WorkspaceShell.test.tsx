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

  it("does not leave hidden grid tracks in front of the conversation in sheet mode", () => {
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
    expect((container.firstElementChild as HTMLElement).style.gridTemplateColumns).toBe("640px");
    expect(screen.getByRole("main")).toBeVisible();
  });
});

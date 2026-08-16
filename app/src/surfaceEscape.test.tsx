import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  hasOpenStudioOverlay,
  isTopmostStudioSurface,
  usePopoverSurface,
  useTopmostSurfaceEscape,
} from "./surfaceEscape";

function PopoverHarness({ onClose = () => undefined }: { readonly onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const close = () => {
    onClose();
    setOpen(false);
  };
  usePopoverSurface(surfaceRef, close, open);

  return <>
    <button type="button" onClick={() => setOpen((value) => !value)}>Trigger</button>
    {open && <div ref={surfaceRef} data-studio-overlay="menu" role="menu" aria-label="Test menu">
      <button type="button" role="menuitem">Inside</button>
    </div>}
    <button type="button">Outside</button>
  </>;
}

function NestedSurfaceHarness() {
  const [parentOpen, setParentOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  usePopoverSurface(parentRef, () => setParentOpen(false), parentOpen);
  useTopmostSurfaceEscape(childRef, () => setChildOpen(false), childOpen);

  return <>
    <button type="button" onClick={() => setParentOpen(true)}>Open parent</button>
    {parentOpen && <div ref={parentRef} data-studio-overlay="menu" role="menu" aria-label="Parent menu">
      <button type="button" role="menuitem" onClick={() => setChildOpen(true)}>Open child</button>
    </div>}
    {childOpen && <div ref={childRef} data-studio-overlay="dialog" role="dialog" aria-label="Child dialog">
      <button type="button">Child action</button>
    </div>}
  </>;
}

describe("studio surface ownership", () => {
  it("closes a popover on outside pointer transfer without stealing destination focus", async () => {
    const onClose = vi.fn();
    render(<PopoverHarness onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Trigger" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Inside" }));
    expect(screen.getByRole("menu", { name: "Test menu" })).toBeVisible();

    const outside = screen.getByRole("button", { name: "Outside" });
    await userEvent.click(outside);

    expect(screen.queryByRole("menu", { name: "Test menu" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on outside focus transfer and does not restore the opener", async () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    const outside = screen.getByRole("button", { name: "Outside" });

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Inside" }));
    outside.focus();

    await waitFor(() => expect(screen.queryByRole("menu", { name: "Test menu" })).not.toBeInTheDocument());
    expect(outside).toHaveFocus();
  });

  it("restores the opener when Escape closes the topmost popover", async () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Trigger" });

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Inside" }));
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Test menu" })).not.toBeInTheDocument();
  });

  it("gives Escape to only the last presented nested surface", async () => {
    render(<NestedSurfaceHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Open parent" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open child" }));

    const parent = screen.getByRole("menu", { name: "Parent menu" });
    const child = screen.getByRole("dialog", { name: "Child dialog" });
    expect(isTopmostStudioSurface(child)).toBe(true);
    expect(isTopmostStudioSurface(parent)).toBe(false);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Child dialog" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Parent menu" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Parent menu" })).not.toBeInTheDocument();
  });

  it("ignores hidden or aria-hidden surface residue", () => {
    render(<>
      <div data-studio-overlay="menu" hidden />
      <div data-studio-overlay="dialog" aria-hidden="true" />
    </>);
    expect(hasOpenStudioOverlay()).toBe(false);
  });
});

import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { hasOpenStudioOverlay, usePopoverSurface } from "./surfaceEscape";

function SinglePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  usePopoverSurface(surface, () => setOpen(false), open, root);
  return <>
    <div ref={root}>
      <button type="button" onClick={() => setOpen((value) => !value)}>Open menu</button>
      {open && <div ref={surface} data-studio-overlay="menu" role="menu" aria-label="Single menu">
        <button type="button" role="menuitem">Inside</button>
      </div>}
    </div>
    <button type="button">Outside</button>
  </>;
}

function NestedPopovers() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerRoot = useRef<HTMLDivElement>(null);
  const outerSurface = useRef<HTMLDivElement>(null);
  const innerRoot = useRef<HTMLDivElement>(null);
  const innerSurface = useRef<HTMLDivElement>(null);
  usePopoverSurface(outerSurface, () => setOuterOpen(false), outerOpen, outerRoot);
  usePopoverSurface(innerSurface, () => setInnerOpen(false), innerOpen, innerRoot);
  return <div ref={outerRoot}>
    <button type="button" onClick={() => setOuterOpen((value) => !value)}>Outer trigger</button>
    {outerOpen && <div ref={outerSurface} data-studio-overlay="menu" role="menu" aria-label="Outer menu">
      <div ref={innerRoot}>
        <button type="button" role="menuitem" onClick={() => setInnerOpen((value) => !value)}>Inner trigger</button>
        {innerOpen && <div ref={innerSurface} data-studio-overlay="menu" role="menu" aria-label="Inner menu">
          <button type="button" role="menuitem">Inner action</button>
        </div>}
      </div>
      <button type="button" role="menuitem">Outer action</button>
    </div>}
  </div>;
}

describe("Studio surface ownership", () => {
  it("dismisses the topmost popover on outside pointer without stealing the clicked target", async () => {
    render(<SinglePopover />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    const outside = screen.getByRole("button", { name: "Outside" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Single menu" })).toBeVisible();
    expect(hasOpenStudioOverlay()).toBe(true);

    await userEvent.click(outside);

    expect(screen.queryByRole("menu", { name: "Single menu" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
    expect(hasOpenStudioOverlay()).toBe(false);
  });

  it("restores the opener when Escape closes the topmost popover", async () => {
    render(<SinglePopover />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Single menu" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("lets an outside pointer close only the nested topmost surface", async () => {
    render(<NestedPopovers />);
    const outerTrigger = screen.getByRole("button", { name: "Outer trigger" });
    await userEvent.click(outerTrigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Inner trigger" }));
    expect(screen.getByRole("menu", { name: "Outer menu" })).toBeVisible();
    expect(screen.getByRole("menu", { name: "Inner menu" })).toBeVisible();

    await userEvent.click(screen.getByRole("menuitem", { name: "Outer action" }));

    expect(screen.queryByRole("menu", { name: "Inner menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Outer menu" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Outer menu" })).not.toBeInTheDocument();
    await waitFor(() => expect(outerTrigger).toHaveFocus());
  });
});

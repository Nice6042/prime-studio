import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense, useState, type ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownFallback, SurfaceFallback } from "./lazyBoundaries";

describe("lazy boundaries", () => {
  it("renders a non-focusable live status with the target surface geometry", () => {
    render(<SurfaceFallback surface="modal" label="Loading settings" />);

    const status = screen.getByRole("status", { name: "Loading settings" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).not.toHaveAttribute("tabindex");
    expect(status).toHaveClass("lazy-surface", "lazy-surface-modal");
  });

  it("keeps plaintext available while formatted Markdown is loading", () => {
    render(<MarkdownFallback text="A **streaming** answer" />);

    const status = screen.getByRole("status", { name: "Loading formatted message" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("A **streaming** answer");
    expect(status).toHaveClass("md", "md-fallback");
  });

  it("uses the native modal and palette shells while code is deferred", () => {
    render(
      <>
        <SurfaceFallback surface="modal" label="Loading settings" />
        <SurfaceFallback surface="palette" label="Loading command palette" />
      </>,
    );

    expect(screen.getByRole("status", { name: "Loading settings" })).toHaveClass("modal");
    expect(screen.getByRole("status", { name: "Loading command palette" })).toHaveClass(
      "palette",
    );
  });

  it.each([
    ["modal", "settings"],
    ["palette", "command palette"],
  ] as const)(
    "closes an unresolved %s on Escape without bubbling or stealing opener focus",
    async (surface, name) => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onAbort = vi.fn();
      let resolveSurface: ((module: { default: ComponentType }) => void) | undefined;
      const DeferredSurface = lazy(
        () =>
          new Promise<{ default: ComponentType }>((resolve) => {
            resolveSurface = resolve;
          }),
      );

      function Harness() {
        const [open, setOpen] = useState(false);
        const close = () => {
          onClose();
          setOpen(false);
        };
        return (
          <>
            <button onClick={() => setOpen(true)}>Open {name}</button>
            {open && (
              <Suspense
                fallback={
                  <SurfaceFallback
                    surface={surface}
                    label={`Loading ${name}`}
                    onClose={close}
                  />
                }
              >
                <DeferredSurface />
              </Suspense>
            )}
          </>
        );
      }

      window.addEventListener("keydown", onAbort);
      try {
        render(<Harness />);
        const trigger = screen.getByRole("button", { name: `Open ${name}` });
        await user.click(trigger);
        expect(trigger).toHaveFocus();
        expect(screen.getByRole("status", { name: `Loading ${name}` })).toBeInTheDocument();

        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onAbort).not.toHaveBeenCalled();
        expect(
          screen.queryByRole("status", { name: `Loading ${name}` }),
        ).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();

        await act(async () =>
          resolveSurface?.({
            default: () => <input aria-label={`${name} loaded`} autoFocus />,
          }),
        );
        expect(
          screen.queryByRole("textbox", { name: `${name} loaded` }),
        ).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
      } finally {
        window.removeEventListener("keydown", onAbort);
      }
    },
  );

  it("lets only the topmost unresolved surface own each Escape", async () => {
    const user = userEvent.setup();
    const closeSettings = vi.fn();
    const closePalette = vi.fn();
    const onAbort = vi.fn();

    function Harness() {
      const [settingsOpen, setSettingsOpen] = useState(true);
      const [paletteOpen, setPaletteOpen] = useState(true);
      return (
        <>
          <button>Surface opener</button>
          {settingsOpen && (
            <SurfaceFallback
              surface="modal"
              label="Loading settings"
              onClose={() => {
                closeSettings();
                setSettingsOpen(false);
              }}
            />
          )}
          {paletteOpen && (
            <SurfaceFallback
              surface="palette"
              label="Loading command palette"
              onClose={() => {
                closePalette();
                setPaletteOpen(false);
              }}
            />
          )}
        </>
      );
    }

    window.addEventListener("keydown", onAbort);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Surface opener" });
      opener.focus();

      await user.keyboard("{Escape}");
      expect(closePalette).toHaveBeenCalledTimes(1);
      expect(closeSettings).not.toHaveBeenCalled();
      expect(screen.getByRole("status", { name: "Loading settings" })).toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: "Loading command palette" }),
      ).not.toBeInTheDocument();
      expect(onAbort).not.toHaveBeenCalled();
      expect(opener).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(closeSettings).toHaveBeenCalledTimes(1);
      expect(onAbort).not.toHaveBeenCalled();
      expect(opener).toHaveFocus();
    } finally {
      window.removeEventListener("keydown", onAbort);
    }
  });

  it.each([
    ["modal", "settings"],
    ["palette", "command palette"],
  ] as const)(
    "closes an unresolved %s from its backdrop and ignores late resolution",
    async (surface, name) => {
      const onClose = vi.fn();
      let resolveSurface: ((module: { default: ComponentType }) => void) | undefined;
      const DeferredSurface = lazy(
        () =>
          new Promise<{ default: ComponentType }>((resolve) => {
            resolveSurface = resolve;
          }),
      );

      function Harness() {
        const [open, setOpen] = useState(true);
        const close = () => {
          onClose();
          setOpen(false);
        };
        return (
          <>
            <button>Open {name}</button>
            {open && (
              <Suspense
                fallback={
                  <SurfaceFallback
                    surface={surface}
                    label={`Loading ${name}`}
                    onClose={close}
                  />
                }
              >
                <DeferredSurface />
              </Suspense>
            )}
          </>
        );
      }

      render(<Harness />);
      const trigger = screen.getByRole("button", { name: `Open ${name}` });
      trigger.focus();
      fireEvent.click(screen.getByRole("status", { name: `Loading ${name}` }).parentElement!);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(trigger).toHaveFocus();

      await act(async () =>
        resolveSurface?.({
          default: () => <input aria-label={`${name} loaded`} autoFocus />,
        }),
      );
      expect(screen.queryByRole("textbox", { name: `${name} loaded` })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    },
  );
});

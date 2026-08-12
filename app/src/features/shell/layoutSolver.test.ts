import { describe, expect, it } from "vitest";

import { solveLayout } from "./layoutSolver";

describe("workspace layout solver", () => {
  it.each([320, 480, 640, 820, 1024, 1280, 1600, 2560])(
    "returns finite non-negative geometry at %ipx",
    (viewport) => {
      for (const sidebarOpen of [false, true]) {
        for (const inspectorOpen of [false, true]) {
          for (const editorOpen of [false, true]) {
            const result = solveLayout({
              viewport,
              sidebar: { open: sidebarOpen, preferred: Number.NaN },
              inspector: { open: inspectorOpen, preferred: Number.POSITIVE_INFINITY },
              editor: { open: editorOpen, preferred: -500 },
            });
            for (const value of [result.sidebar.width, result.inspector.width, result.editor.width, result.centerWidth]) {
              expect(Number.isFinite(value)).toBe(true);
              expect(value).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    },
  );

  it("clamps pane preferences and preserves a 340px center on wide screens", () => {
    const result = solveLayout({
      viewport: 1644,
      sidebar: { open: true, preferred: 900 },
      inspector: { open: true, preferred: 10 },
      editor: { open: true, preferred: 900 },
    });
    expect(result.sidebar).toEqual({ mode: "pane", width: 380 });
    expect(result.inspector).toEqual({ mode: "pane", width: 280 });
    expect(result.editor).toEqual({ mode: "pane", width: 600 });
    expect(result.centerWidth).toBe(360);
  });

  it("collapses the sidebar before converting the active editor to a sheet", () => {
    const result = solveLayout({
      viewport: 960,
      sidebar: { open: true, preferred: 300 },
      inspector: { open: true, preferred: 360 },
      editor: { open: true, preferred: 360 },
    });
    expect(result.sidebar.mode).toBe("rail");
    expect(result.editor.mode).toBe("pane");
    expect(result.inspector.mode).toBe("sheet");
    expect(result.centerWidth).toBeGreaterThanOrEqual(340);
  });

  it("uses modal sheets instead of crushing the conversation on narrow screens", () => {
    const result = solveLayout({
      viewport: 640,
      sidebar: { open: true, preferred: 264 },
      inspector: { open: true, preferred: 384 },
      editor: { open: false, preferred: 400 },
    });
    expect(result.sidebar).toEqual({ mode: "sheet", width: 320 });
    expect(result.inspector).toEqual({ mode: "sheet", width: 384 });
    expect(result.editor).toEqual({ mode: "closed", width: 0 });
    expect(result.centerWidth).toBe(640);
  });

  it("clamps the Harness inspector to the approved 280–520px range", () => {
    expect(solveLayout({
      viewport: 1600,
      sidebar: { open: false, preferred: 264 },
      inspector: { open: true, preferred: 900 },
      editor: { open: false, preferred: 400 },
    }).inspector.width).toBe(520);
    expect(solveLayout({
      viewport: 1200,
      sidebar: { open: false, preferred: 264 },
      inspector: { open: true, preferred: 12 },
      editor: { open: false, preferred: 400 },
    }).inspector.width).toBe(280);
  });

  it("keeps the compact rail when every secondary surface is closed", () => {
    expect(solveLayout({
      viewport: 800,
      sidebar: { open: false, preferred: 264 },
      inspector: { open: false, preferred: 384 },
      editor: { open: false, preferred: 400 },
    })).toEqual({
      sidebar: { mode: "rail", width: 56 },
      inspector: { mode: "closed", width: 0 },
      editor: { mode: "closed", width: 0 },
      centerWidth: 736,
    });
  });
});

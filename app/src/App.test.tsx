import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./app/StudioApp", () => ({
  StudioApp: () => <main aria-label="Studio workspace">Studio workspace</main>,
}));

import App from "./App";

describe("application entry point", () => {
  it("always mounts the typed Studio workspace instead of the legacy raw-RPC shell", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "Studio workspace" })).toBeVisible();
  });
});

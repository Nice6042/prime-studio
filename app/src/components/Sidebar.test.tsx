import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

it("gives session search a durable programmatic label", () => {
  render(
    <Sidebar
      sessions={[]}
      activeId={null}
      accountName="Claude work"
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onRefresh={vi.fn()}
      agents={[]}
      searchRef={{ current: null }}
    />,
  );

  expect(screen.getByRole("searchbox", { name: "Search sessions" })).toBeInTheDocument();
});

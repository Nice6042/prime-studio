import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

function renderComposer() {
  return render(<div>
    <Composer
      draft=""
      state={{ kind: "idle", draft: "", canSend: false }}
      models={[
        { id: "model-a", label: "Model A", enabled: true },
        { id: "model-b", label: "Model B", enabled: true },
      ]}
      selectedModel="model-a"
      thinking="low"
      thinkingLevels={["low", "medium", "high"]}
      onSelectModel={vi.fn()}
      onSelectThinking={vi.fn()}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onOpenUsage={vi.fn()}
    />
    <button type="button">Outside composer</button>
  </div>);
}

describe("Composer popover contract", () => {
  it("uses selected-first roving focus for the thinking menu", async () => {
    renderComposer();
    const trigger = screen.getByRole("button", { name: "Thinking low" });
    await userEvent.click(trigger);

    const low = screen.getByRole("menuitemradio", { name: /Low/ });
    const medium = screen.getByRole("menuitemradio", { name: /Medium/ });
    const high = screen.getByRole("menuitemradio", { name: /High/ });
    expect(low).toHaveFocus();
    expect(low).toHaveAttribute("tabindex", "0");
    expect(medium).toHaveAttribute("tabindex", "-1");
    expect(high).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{ArrowDown}");
    expect(medium).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(high).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(low).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(high).toHaveFocus();
  });

  it("opens a menu from arrow keys and restores its trigger on Escape", async () => {
    renderComposer();
    const trigger = screen.getByRole("button", { name: "Thinking low" });
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");

    expect(screen.getByRole("menu", { name: "Thinking level" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: /High/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Thinking level" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses model and thinking menus outside without stealing pointer focus", async () => {
    renderComposer();
    const outside = screen.getByRole("button", { name: "Outside composer" });

    await userEvent.click(screen.getByRole("button", { name: "Choose model Model A" }));
    expect(screen.getByRole("menu", { name: "Verified models" })).toBeVisible();
    await userEvent.click(outside);
    expect(screen.queryByRole("menu", { name: "Verified models" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Thinking low" }));
    expect(screen.getByRole("menu", { name: "Thinking level" })).toBeVisible();
    await userEvent.click(outside);
    expect(screen.queryByRole("menu", { name: "Thinking level" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
});

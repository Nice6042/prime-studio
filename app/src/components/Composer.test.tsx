import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Composer } from "./Composer";

it("preloads Markdown on composer focus and before a normal send", async () => {
  const user = userEvent.setup();
  const preloadMarkdown = vi.fn();
  const onSend = vi.fn();
  render(
    <Composer
      busy={false}
      readOnly={false}
      onSend={onSend}
      onSteer={vi.fn()}
      onQueue={vi.fn()}
      onPreloadMarkdown={preloadMarkdown}
    />,
  );

  const composer = screen.getByPlaceholderText("Message Prime, or / for commands");
  expect(composer).toHaveAccessibleName("Message Prime");
  await user.click(composer);
  expect(composer).toHaveFocus();
  expect(preloadMarkdown).toHaveBeenCalledTimes(1);

  await user.type(composer, "Build a dashboard");
  await user.keyboard("{Enter}");
  expect(preloadMarkdown).toHaveBeenCalledTimes(2);
  expect(onSend).toHaveBeenCalledWith("Build a dashboard");
  expect(composer).toHaveFocus();
});

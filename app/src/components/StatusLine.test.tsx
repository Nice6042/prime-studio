import { act, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatState } from "../reducer";
import { StatusLine } from "./StatusLine";

afterEach(() => vi.useRealTimers());

it("keeps elapsed-second updates out of the live status announcement", () => {
  vi.useFakeTimers();
  const chat: ChatState = {
    timeline: [],
    tools: {},
    children: {},
    busy: true,
    retention: {
      totalItems: 0,
      omittedItems: 0,
      totalTurns: 0,
      firstUserText: "",
      payloadTruncated: false,
      windowStart: 0,
      windowEnd: 0,
      windowContiguous: true,
    },
  };
  const { container } = render(<StatusLine chat={chat} onStop={vi.fn()} />);

  const liveStatus = screen.getByRole("status", { name: "Live session status" });
  expect(liveStatus).toHaveTextContent("Thinking.");

  act(() => vi.advanceTimersByTime(2_000));

  expect(container.querySelector(".status-text")).toHaveTextContent("Thinking, 2s.");
  expect(within(liveStatus).getByText("Thinking.")).toBeInTheDocument();
});

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../useSession", () => ({
  useSession: () => ({
    chat: {
      busy: false,
      timeline: [],
      children: {},
      tools: {},
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
    },
    openDiskSession: vi.fn(),
    abort: vi.fn(),
    daemon: false,
    newChat: vi.fn(),
    endAgent: vi.fn(),
    compact: vi.fn(),
    sessionKey: null,
    setCwd: vi.fn(),
    chooseModel: vi.fn(),
    starting: false,
    readOnly: false,
    cwd: null,
    model: null,
    thinking: "medium",
    stats: null,
    prompt: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    showOlderMessages: vi.fn(),
    showLatestMessages: vi.fn(),
  }),
}));
vi.mock("../transcript", () => ({ isQuiet: () => true }));
vi.mock("./TopBar", () => ({ TopBar: () => null }));
vi.mock("./MessageList", () => ({ MessageList: () => null }));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./RightRail", () => ({
  RightRail: () => null,
  kernelLine: () => "",
  useKernel: () => ({}),
}));
vi.mock("./StatusLine", () => ({ StatusLine: () => null }));

import { ChatPane } from "./ChatPane";

const callbacks = {
  onTheme: vi.fn(),
  onToggleArtifacts: vi.fn(),
  onAccount: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenUsage: vi.fn(),
  onOpenSession: vi.fn(),
  onNewTab: vi.fn(),
  onIdle: vi.fn(),
  onBusy: vi.fn(),
  onTitle: vi.fn(),
};

describe("ChatPane tab panel semantics", () => {
  it("owns the panel identified and labelled by its session tab", () => {
    const props = {
      active: true,
      accountId: null,
      accounts: [],
      models: [],
      sessions: [],
      theme: "dark" as const,
      artifactsOpen: false,
      panelId: "session-panel-tab-7",
      tabId: "session-tab-tab-7",
      ...callbacks,
    };
    const { rerender } = render(<ChatPane {...props} />);

    const panel = screen.getByRole("tabpanel");
    expect(panel.tagName).toBe("DIV");
    expect(panel).toHaveAttribute("id", "session-panel-tab-7");
    expect(panel).toHaveAttribute("aria-labelledby", "session-tab-tab-7");
    expect(within(panel).getByRole("main")).toBeInTheDocument();

    rerender(<ChatPane {...props} active={false} />);
    expect(screen.getByRole("tabpanel", { hidden: true })).not.toBeVisible();
  });
});

import { expect, test } from "./support/browser-shell";

const STREAMING_REFLOW_FIXTURE = "PRIME_STUDIO_REFLOW_STREAMING_FIXTURE";

test("the reflow streaming state is admitted through the actual Studio operation boundary", async ({ shellPage }) => {
  await shellPage.setViewportSize({ width: 1280, height: 800 });
  await shellPage.reload();
  const workspace = shellPage.getByRole("main", { name: "Prime Harness architecture" });
  const composer = shellPage.getByPlaceholder("Message Prime Studio — try / for commands");

  await composer.fill(STREAMING_REFLOW_FIXTURE);
  await composer.press("Enter");

  const streamingTurn = workspace.locator('.parent-assistant-turn[aria-busy="true"]').last();
  await expect(streamingTurn).toContainText("Synthetic streaming response retained for deterministic reflow evidence.");
  await expect(streamingTurn.getByRole("status")).toHaveText("Responding");

  const admittedThroughStudioOperation = await shellPage.evaluate((marker) => {
    const requests = (window as typeof window & {
      __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string; args: Record<string, unknown> }>;
    }).__PRIME_STUDIO_BROWSER_REQUESTS__ ?? [];
    return requests.some(({ command, args }) => {
      if (command !== "harness_studio_operation") return false;
      const request = args.request as { action?: unknown; payloadJson?: unknown } | undefined;
      const action = typeof request?.action === "string" ? request.action : "";
      return ["harness.session.prompt", "harness.session.follow-up", "harness.session.steer"].includes(action)
        && typeof request?.payloadJson === "string"
        && request.payloadJson.includes(marker);
    });
  }, STREAMING_REFLOW_FIXTURE);

  expect(admittedThroughStudioOperation).toBe(true);
  await expect(composer).toHaveValue("");
});

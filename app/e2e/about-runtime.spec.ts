import { expect } from "@playwright/test";

import { expectNoSeriousOrCriticalAxeViolations, test } from "./support/browser-shell";
import { expectNoDocumentOverflow } from "./support/acceptance-matrix";

for (const viewport of [
  { name: "wide", width: 1280, height: 800 },
  { name: "narrow", width: 390, height: 760 },
] as const) {
  test(`About exposes verified runtime identity and honest actions at ${viewport.name} width`, async ({ shellPage }) => {
    await shellPage.setViewportSize(viewport);
    await shellPage.keyboard.press("Control+,");
    const settings = shellPage.getByRole("main", { name: "Settings" });
    await settings.getByRole("button", { name: /About/ }).click();

    await expect(settings.getByText("0.1.0", { exact: true })).toBeVisible();
    await expect(settings.getByText("prime-agent 0.7.1", { exact: true })).toBeVisible();
    await expect(settings.getByText("prime-agent.daemon v7", { exact: true })).toBeVisible();
    await expect(settings.getByText("protocol-7-schema-13-816309b1cd50 r13", { exact: true })).toBeVisible();
    for (const exactIdentity of [
      "ready \u00b7 prime-agent-daemon-v7-schema13-816309b1cd50",
      "prime-agent 0.7.1",
      "prime-agent.daemon v7",
      "protocol-7-schema-13-816309b1cd50 r13",
    ]) {
      await expect(settings.getByText(exactIdentity, { exact: true })).toHaveCSS("text-transform", "none");
    }
    await expect(settings.getByText(/^sha256:[a-f0-9]{64}$/).first()).toBeVisible();
    await expect(settings.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await expect(settings.getByText("Unavailable \u00b7 no signed update channel configured", { exact: true })).toBeVisible();

    await settings.getByRole("button", { name: "Open license notices" }).click();
    await expect.poll(() => shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_PACKAGED_LICENSE_OPENS__?: number }).__PRIME_STUDIO_PACKAGED_LICENSE_OPENS__)).toBe(1);
    await expect.poll(() => shellPage.evaluate(() => (window as typeof window & { __PRIME_STUDIO_OPENED_URLS__?: string[] }).__PRIME_STUDIO_OPENED_URLS__)).toEqual([]);

    await expectNoDocumentOverflow(shellPage);
    await expectNoSeriousOrCriticalAxeViolations(shellPage, `about-runtime-${viewport.name}`);
  });
}

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { isLoopbackRequestUrl } from "./network.mjs";

type ShellFixtures = {
  shellPage: Page;
};

const SERIOUS_IMPACTS = new Set(["serious", "critical"]);
const axeMode = process.env.PRIME_STUDIO_AXE_MODE ?? "strict";

type AxeFingerprint = {
  id: string;
  impact: string;
  targets: string[];
};

const axeBaseline: Record<string, AxeFingerprint[]> = JSON.parse(
  readFileSync(new URL("../axe-baseline.json", import.meta.url), "utf8"),
);

export const test = base.extend<ShellFixtures>({
  shellPage: async ({ context, page }, use) => {
    await context.route("**/*", async (route) => {
      if (isLoopbackRequestUrl(route.request().url())) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });

    await page.addInitScript(() => {
      type Callback = (payload: unknown) => unknown;
      type TauriInternals = {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback: Callback, once?: boolean) => number;
        unregisterCallback: (id: number) => void;
        callbacks: Map<number, Callback>;
      };

      const global = window as typeof window & {
        __TAURI_INTERNALS__?: TauriInternals;
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener: (event: string, id: number) => void;
        };
      };
      const callbacks = new Map<number, Callback>();
      const listeners = new Map<string, number[]>();
      let nextCallback = 1;

      const emit = (event: string, payload: unknown) => {
        for (const id of listeners.get(event) ?? []) {
          callbacks.get(id)?.({ event, id, payload });
        }
      };

      const emitTranscriptWithToolError = (sessionKey: string) => {
        const assistant = {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5",
          content: [
            { type: "text", text: "I ran the command and it failed." },
            {
              type: "toolCall",
              id: "tool-e2e-1",
              name: "ipython",
              arguments: { code: "%%bash\npython --version" },
            },
          ],
        };

        window.setTimeout(() => {
          emit("prime://event", { sessionKey, event: { type: "agent_start" } });
          emit("prime://event", { sessionKey, event: { type: "message_start", message: assistant } });
          emit("prime://event", { sessionKey, event: { type: "message_update", message: assistant } });
          emit("prime://event", {
            sessionKey,
            event: {
              type: "tool_execution_start",
              toolCallId: "tool-e2e-1",
              toolName: "ipython",
              args: { code: "%%bash\npython --version" },
            },
          });
          emit("prime://event", {
            sessionKey,
            event: {
              type: "tool_execution_end",
              toolCallId: "tool-e2e-1",
              toolName: "ipython",
              isError: true,
              result: {
                content: [{ type: "text", text: "exit code: 127\n-bash: python: command not found\n" }],
                details: {
                  stderr: "-bash: python: command not found\n",
                  durationMs: 12,
                },
              },
            },
          });
          emit("prime://event", { sessionKey, event: { type: "message_end", message: assistant } });
          emit("prime://event", { sessionKey, event: { type: "agent_end" } });
        }, 0);
      };

      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") {
          const event = String(args.event ?? "");
          const handler = Number(args.handler);
          listeners.set(event, [...(listeners.get(event) ?? []), handler]);
          return handler;
        }
        if (command === "plugin:event|unlisten") {
          const event = String(args.event ?? "");
          const id = Number(args.eventId);
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((listener) => listener !== id),
          );
          callbacks.delete(id);
          return null;
        }

        switch (command) {
          case "resolve_prime_cli":
            return {
              path: "C:\\fixture\\prime-agent",
              source: "browser-shell fixture",
              shim: false,
              configured: null,
              daemon: false,
              daemonSocket: null,
              error: null,
            };
          case "list_accounts":
            return [
              {
                id: "account-e2e",
                label: "Browser shell",
                provider: "openai-codex",
                agentDir: "C:\\fixture\\agent",
                createdAt: 0,
              },
            ];
          case "get_app_settings":
            return {
              theme: "dark",
              defaultAccount: "account-e2e",
              defaultProvider: "openai-codex",
              defaultModel: "gpt-5",
              defaultThinking: "high",
              defaultCwd: null,
              lastSection: "accounts",
            };
          case "scheduler_projection":
            return {
              schemaVersion: 1,
              revision: null,
              status: "unavailable",
              dispatchAvailable: false,
            };
          case "list_models":
            return [
              {
                provider: "openai-codex",
                model: "gpt-5",
                name: "GPT-5",
                context: 128000,
                max_out: 16000,
                thinking: true,
                images: true,
              },
            ];
          case "list_disk_sessions":
          case "list_workspace_files":
          case "files_touched":
            return [];
          case "kernel_status":
            return {
              python: "C:\\Python311\\python.exe",
              source: "browser-shell fixture",
              exists: true,
              version: "Python 3.11.9",
              ipykernel: "6.29.0",
              error: null,
            };
          case "account_status":
            return {
              authed: true,
              provider: "openai-codex",
              health: "signedIn",
              expires: null,
              expiresInMs: null,
            };
          case "fleet_list":
            return { agents: [], daemon: false, error: null };
          case "scheduler_projection":
            return {
              schemaVersion: 1,
              revision: 0,
              status: "planned",
              dispatchAvailable: false,
            };
          case "start_session":
            return "browser-shell-session";
          case "send_rpc": {
            const sessionKey = String(args.sessionKey ?? "browser-shell-session");
            const rpc = (args.command ?? {}) as { type?: string; id?: string };
            if (rpc.type === "prompt") emitTranscriptWithToolError(sessionKey);
            if (rpc.type === "get_session_stats") {
              window.setTimeout(() => {
                emit("prime://event", {
                  sessionKey,
                  event: {
                    type: "response",
                    id: rpc.id,
                    command: "get_session_stats",
                    success: true,
                    data: { cost: 0.02, toolCalls: 1, toolResults: 1 },
                  },
                });
              }, 0);
            }
            return null;
          }
          case "set_app_setting":
          case "stop_session":
          case "detach_session":
          case "note_agent":
          case "open_external":
            return null;
          default:
            return null;
        }
      };

      const unregisterCallback = (id: number) => {
        callbacks.delete(id);
        for (const [event, ids] of listeners) {
          listeners.set(
            event,
            ids.filter((listener) => listener !== id),
          );
        }
      };

      global.__TAURI_INTERNALS__ = {
        invoke,
        transformCallback: (callback: Callback, once = false) => {
          const id = nextCallback++;
          callbacks.set(id, (payload) => {
            if (once) unregisterCallback(id);
            return callback(payload);
          });
          return id;
        },
        unregisterCallback,
        callbacks,
      };
      global.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => unregisterCallback(id) };
    });

    await page.goto("/");
    await expect(page.getByPlaceholder("Message Prime, or / for commands")).toBeVisible();
    await use(page);
  },
});

export { expect };

export async function expectNoSeriousOrCriticalAxeViolations(page: Page, scenario: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations
    .filter((violation) => SERIOUS_IMPACTS.has(violation.impact ?? ""))
    .flatMap((violation) =>
      violation.nodes.map((node) => ({
        id: violation.id,
        impact: violation.impact ?? "unknown",
        targets: node.target.map(String).sort(),
      })),
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  if (axeMode === "baseline") {
    const expected = axeBaseline[scenario];
    if (!expected) {
      throw new Error(
        `Missing axe baseline for ${scenario}. Exact fingerprint:\n${JSON.stringify(violations, null, 2)}`,
      );
    }
    expect(violations, `axe baseline mismatch for ${scenario}`).toEqual(expected);
    return;
  }

  expect(violations, `strict axe gate failed for ${scenario}`).toEqual([]);
}

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
const harnessScenario = JSON.parse(
  readFileSync(new URL("../../harness-sidecar/test/fixtures/fake-daemon/scenario-manifest.json", import.meta.url), "utf8"),
) as {
  runtime: { capabilities: string[] };
  sessions: Array<Record<string, unknown>>;
};

export const test = base.extend<ShellFixtures>({
  shellPage: async ({ context, page }, use) => {
    await context.route("**/*", async (route) => {
      if (isLoopbackRequestUrl(route.request().url())) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });

    await page.addInitScript((scenario) => {
      type Callback = (payload: unknown) => unknown;
      type TauriInternals = {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback: Callback, once?: boolean) => number;
        unregisterCallback: (id: number) => void;
        callbacks: Map<number, Callback>;
      };

      const global = window as typeof window & {
        __PRIME_STUDIO_BROWSER_INVOKES__?: string[];
        __PRIME_STUDIO_BROWSER_REQUESTS__?: Array<{ command: string; args: Record<string, unknown> }>;
        __PRIME_STUDIO_CLIPBOARD__?: string[];
        __PRIME_STUDIO_OPENED_URLS__?: string[];
        __PRIME_STUDIO_PACKAGED_LICENSE_OPENS__?: number;
        __TAURI_INTERNALS__?: TauriInternals;
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener: (event: string, id: number) => void;
        };
      };
      const callbacks = new Map<number, Callback>();
      global.__PRIME_STUDIO_BROWSER_INVOKES__ = [];
      global.__PRIME_STUDIO_BROWSER_REQUESTS__ = [];
      global.__PRIME_STUDIO_CLIPBOARD__ = [];
      global.__PRIME_STUDIO_OPENED_URLS__ = [];
      global.__PRIME_STUDIO_PACKAGED_LICENSE_OPENS__ = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { global.__PRIME_STUDIO_CLIPBOARD__?.push(text); } },
      });
      const listeners = new Map<string, number[]>();
      let nextCallback = 1;
      let projectedHarnessSessions = scenario.sessions.map((session) => ({
        ...session,
        freshness: "live",
        workerRecovery: {
          status: "ready",
          closureReason: null,
          observationId: null,
          automaticRetryCount: 0,
          detail: null,
        },
        performance: {
          status: "available",
          sessionId: session.sessionId,
          cursor: { ...session.cursor },
          firstTokenLatencyMs: 142,
          outputTokens: 368,
          generationDurationMs: 20_000,
          tokensPerSecond: 18.4,
        },
      }));
      let appSettings: Record<string, string | null> = {
        theme: "dark",
        defaultAccount: "account-e2e",
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5",
        defaultThinking: "high",
        defaultCwd: "D:\\fixture\\Prime Studio",
        lastSection: "accounts",
      };
      let layoutPreferences = {
        schemaVersion: 1,
        sidebarOpen: true,
        sidebarWidth: 264,
        inspectorOpen: true,
        inspectorWidth: 384,
        editorOpen: false,
        editorWidth: 400,
        expandedProjectIds: ["project:personal"],
      };
      let artifactRevision = 1;
      let artifactIdentity = `sha256:${"a".repeat(64)}`;
      let artifactContent = "# Verified browser artifact\n\nOpened through an opaque Harness candidate.";
      const settledExtensionRequests = new Set<string>();
      let attentionRevision = 0;
      const chatDisplayRecords = new Map<string, { chatId: string; messageId: string; revision: number; sourceContent: string; content: string }>();
      let attentionRecord = { chatId: "chat-e2e", chatSeen: null, activitySeen: null } as {
        chatId: string;
        chatSeen: null | { runtimeGeneration: string; marker: string; occurredAtMs: number };
        activitySeen: null | { runtimeGeneration: string; marker: string; occurredAtMs: number };
      };

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
        global.__PRIME_STUDIO_BROWSER_INVOKES__?.push(command);
        global.__PRIME_STUDIO_BROWSER_REQUESTS__?.push({ command, args });
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
          case "account_usage_series":
            return [{
              ts: Date.now(), provider: "openai-codex", cost: 1.25,
              input: 100, output: 20, cacheRead: 30, cacheWrite: 0,
            }];
          case "codex_subscription_usage":
            return {
              usedPercent: 42.5,
              windowMinutes: 300,
              resetsAt: 1_800_000_000,
              planType: "pro",
              secondary: { usedPercent: 70, windowMinutes: 10_080, resetsAt: 1_800_600_000 },
              staleAsOf: 1_799_999_000_000,
            };
          case "get_app_settings":
            return { ...appSettings };
          case "set_app_setting": {
            const key = String(args.key ?? "");
            const value = args.value;
            if (typeof value === "string" && value.trim()) appSettings = { ...appSettings, [key]: value.trim() };
            else {
              const next = { ...appSettings };
              delete next[key];
              appSettings = next;
            }
            return { ...appSettings };
          }
          case "scheduler_projection":
            return {
              schemaVersion: 1,
              revision: null,
              status: "unavailable",
              dispatchAvailable: false,
            };
          case "harness_bootstrap":
            return {
              compatibility: {
                status: "ready",
                profile: "prime-agent-daemon-v7-schema13-816309b1cd50",
                capabilities: [...scenario.runtime.capabilities],
              },
              runtime: { ...scenario.runtime, capabilities: [...scenario.runtime.capabilities] },
              sessions: projectedHarnessSessions,
            };
          case "plugin:app|version":
            return "0.1.0";
          case "open_external": {
            if (args.url === "prime-studio:packaged-license-notices") {
              global.__PRIME_STUDIO_PACKAGED_LICENSE_OPENS__ = (global.__PRIME_STUDIO_PACKAGED_LICENSE_OPENS__ ?? 0) + 1;
            }
            return null;
          }
          case "plugin:opener|open_url": {
            const url = typeof args.url === "string" ? args.url : null;
            if (!url) throw new Error("External document URL unavailable");
            global.__PRIME_STUDIO_OPENED_URLS__?.push(url);
            return null;
          }
          case "harness_attach_session": {
            const request = args.request as { sessionId?: string } | undefined;
            const index = projectedHarnessSessions.findIndex((session) => session.sessionId === request?.sessionId);
            if (index < 0) throw new Error("Harness session unavailable");
            const current = projectedHarnessSessions[index]!;
            const updated = { ...current, cursor: { ...current.cursor as Record<string, unknown>, sequence: Number((current.cursor as { sequence: number }).sequence) + 1 } };
            projectedHarnessSessions = projectedHarnessSessions.map((session, candidate) => candidate === index ? updated : session);
            return updated;
          }
          case "harness_session_command": {
            const request = args.request as {
              sessionId?: string;
              commandId?: string;
              expectedCursor?: { runtimeGeneration?: string; sequence?: number };
              kind?: string;
              text?: string;
            } | undefined;
            const index = projectedHarnessSessions.findIndex((session) => session.sessionId === request?.sessionId);
            if (index < 0 || !request?.commandId || !request.expectedCursor) throw new Error("Harness command unavailable");
            const current = projectedHarnessSessions[index]! as Record<string, unknown> & {
              cursor: { runtimeGeneration: string; sequence: number };
              parentMessages: Array<Record<string, unknown>>;
              usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number | null };
            };
            if (request.expectedCursor.runtimeGeneration !== current.cursor.runtimeGeneration || request.expectedCursor.sequence !== current.cursor.sequence) throw new Error("Harness cursor stale");
            const sequence = current.cursor.sequence + 1;
            const input = request.kind === "abort" ? 0 : Math.max(1, Math.ceil((request.text ?? "").length / 4));
            const output = request.kind === "abort" ? 0 : 12;
            const messages = request.kind === "abort" ? current.parentMessages : [...current.parentMessages,
              { channel: "parent", kind: "user", id: `${request.commandId}-user`, text: request.text, emittedAtMs: 1_775_995_220_000 },
              { channel: "parent", kind: "assistant", id: `${request.commandId}-assistant`, blocks: [{ kind: "text", text: "Synthetic Harness response admitted through the verified Studio protocol." }], streaming: false, emittedAtMs: 1_775_995_220_001 },
            ];
            const updated = {
              ...current,
              cursor: { ...current.cursor, sequence },
              performance: {
                status: "unavailable", sessionId: current.sessionId,
                cursor: { ...current.cursor, sequence }, reason: "event_chronology_unavailable",
              },
              state: request.kind === "abort" ? "idle" : "working",
              parentMessages: messages,
              usage: { ...current.usage, input: current.usage.input + input, output: current.usage.output + output, totalTokens: current.usage.totalTokens + input + output },
            };
            projectedHarnessSessions = projectedHarnessSessions.map((session, candidate) => candidate === index ? updated : session);
            return { commandId: request.commandId, outcome: "accepted", session: updated };
          }
          case "harness_studio_operation": {
            const request = args.request as { sessionId?: string; operationId?: string; action?: string; payloadJson?: string; expectedCursor?: { runtimeGeneration?: string; sequence?: number }; idempotencyKey?: string } | undefined;
            const index = projectedHarnessSessions.findIndex((session) => session.sessionId === request?.sessionId);
            if (index < 0 || !request?.operationId || !request.expectedCursor || request.idempotencyKey !== request.operationId) throw new Error("Harness Studio operation unavailable");
            const current = projectedHarnessSessions[index]! as Record<string, unknown> & {
              cursor: { runtimeGeneration: string; sequence: number };
              parentMessages: Array<Record<string, unknown>>;
              usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number | null };
            };
            if (request.expectedCursor.runtimeGeneration !== current.cursor.runtimeGeneration || request.expectedCursor.sequence !== current.cursor.sequence) throw new Error("Harness cursor stale");
            if (request.action === "harness.overload.retry") {
              return {
                operationId: request.operationId,
                status: "rejected",
                commandId: null,
                position: null,
                revision: null,
                reason: "The verified runtime rejected this retry before admission.",
                retryable: true,
                session: null,
              };
            }
            if (request.action === "harness.child.stop") {
              const payload = JSON.parse(request.payloadJson ?? "null") as { sessionId?: string; childId?: string } | null;
              const children = Array.isArray(current.children) ? current.children as Array<Record<string, unknown>> : [];
              const matches = children.filter((child) => child.id === payload?.childId);
              if (payload?.sessionId !== current.sessionId || matches.length !== 1 || (matches[0]!.status !== "running" && matches[0]!.status !== "queued")) {
                throw new Error("Harness child cancellation precondition unavailable");
              }
              const sequence = current.cursor.sequence + 1;
              const updated = {
                ...current,
                cursor: { ...current.cursor, sequence },
                performance: { status: "unavailable", sessionId: current.sessionId, cursor: { ...current.cursor, sequence }, reason: "event_chronology_unavailable" },
                children: children.filter((child) => child.id !== payload.childId),
              };
              projectedHarnessSessions = projectedHarnessSessions.map((session, candidate) => candidate === index ? updated : session);
              return {
                operationId: request.operationId, status: "updated", commandId: null, position: null,
                revision: String(sequence), reason: null, retryable: null, session: updated,
              };
            }
            const sessionKind = request.action === "harness.session.prompt" ? "prompt"
              : request.action === "harness.session.follow-up" ? "follow_up"
                : request.action === "harness.session.steer" ? "steer"
                  : request.action === "harness.session.abort" ? "abort" : null;
            if (sessionKind) {
              const payload = JSON.parse(request.payloadJson ?? "null") as { text?: string } | null;
              const text = sessionKind === "abort" ? "" : payload?.text;
              if (sessionKind !== "abort" && !text) throw new Error("Harness Studio command payload unavailable");
              const sequence = current.cursor.sequence + 1;
              const input = sessionKind === "abort" ? 0 : Math.max(1, Math.ceil((text ?? "").length / 4));
              const output = sessionKind === "abort" ? 0 : 12;
              const messages = sessionKind === "abort" ? current.parentMessages : [...current.parentMessages,
                { channel: "parent", kind: "user", id: `${request.operationId}-user`, text, emittedAtMs: 1_775_995_220_000 },
                { channel: "parent", kind: "assistant", id: `${request.operationId}-assistant`, blocks: [{ kind: "text", text: "Synthetic Harness response admitted through the verified Studio protocol." }], streaming: false, emittedAtMs: 1_775_995_220_001 },
              ];
              const updated = {
                ...current,
                cursor: { ...current.cursor, sequence },
                performance: { status: "unavailable", sessionId: current.sessionId, cursor: { ...current.cursor, sequence }, reason: "event_chronology_unavailable" },
                state: sessionKind === "abort" ? "idle" : "working",
                parentMessages: messages,
                usage: { ...current.usage, input: current.usage.input + input, output: current.usage.output + output, totalTokens: current.usage.totalTokens + input + output },
              };
              projectedHarnessSessions = projectedHarnessSessions.map((session, candidate) => candidate === index ? updated : session);
              return {
                operationId: request.operationId,
                status: sessionKind === "follow_up" ? "queued" : sessionKind === "abort" ? "cancelled" : "accepted",
                commandId: request.operationId,
                position: null,
                revision: null,
                reason: null,
                retryable: null,
                session: updated,
              };
            }
            if (request.action !== "harness.extension.respond") throw new Error("Harness Studio operation unavailable");
            const payload = JSON.parse(request.payloadJson ?? "null") as { requestId?: string } | null;
            if (!payload?.requestId || settledExtensionRequests.has(payload.requestId)) throw new Error("Extension request stale");
            settledExtensionRequests.add(payload.requestId);
            const updated = { ...current, cursor: { ...current.cursor, sequence: current.cursor.sequence + 1 } };
            projectedHarnessSessions = projectedHarnessSessions.map((session, candidate) => candidate === index ? updated : session);
            return { operationId: request.operationId, status: "updated", commandId: null, position: null, revision: String(updated.cursor.sequence), reason: null, retryable: null, session: updated };
          }
          case "harness_projection":
            return [];
          case "attention_load":
            return { revision: attentionRevision, records: [{ ...attentionRecord }] };
          case "attention_activity_evidence":
            return null;
          case "attention_mark_seen": {
            const request = args.request as { expectedRevision?: number; chatId?: string; channel?: "chat" | "activity"; evidence?: { runtimeGeneration?: string; marker?: string; occurredAtMs?: number } } | undefined;
            if (request?.expectedRevision !== attentionRevision || request.chatId !== attentionRecord.chatId || !request.evidence?.runtimeGeneration || !request.evidence.marker || !Number.isSafeInteger(request.evidence.occurredAtMs)) throw new Error("Attention evidence stale");
            const evidence = { runtimeGeneration: request.evidence.runtimeGeneration, marker: request.evidence.marker, occurredAtMs: request.evidence.occurredAtMs! };
            attentionRecord = request.channel === "activity" ? { ...attentionRecord, activitySeen: evidence } : request.channel === "chat" ? { ...attentionRecord, chatSeen: evidence } : (() => { throw new Error("Attention channel invalid"); })();
            attentionRevision += 1;
            return { revision: attentionRevision, records: [{ ...attentionRecord }] };
          }
          case "harness_inspector": {
            const request = args.request as { sessionId?: string; expectedCursor?: { runtimeGeneration?: string; sequence?: number } } | undefined;
            const current = projectedHarnessSessions.find((session) => session.sessionId === request?.sessionId) as { sessionId?: string; cursor?: { runtimeGeneration?: string; sequence?: number }; children?: Array<{ id: string; status: string; task: string; provider: string | null; model: string | null }> } | undefined;
            if (!current?.sessionId || !current.cursor?.runtimeGeneration || !Number.isSafeInteger(current.cursor.sequence)
              || request?.expectedCursor?.runtimeGeneration !== current.cursor.runtimeGeneration
              || request.expectedCursor.sequence !== current.cursor.sequence) throw new Error("Harness inspector unavailable");
            const children = Object.fromEntries((current.children ?? []).map((child) => [child.id, {
              binding: { parentSessionId: current.sessionId, childId: child.id, cursor: current.cursor },
              status: child.status === "unknown" ? null : child.status,
              elapsedMs: null,
              provider: child.provider,
              model: child.model,
              task: child.task,
              summary: "Verified child task details are unavailable.",
              context: null,
              tokenUsage: null,
              transcript: [], activity: [], files: [], error: null,
            }]));
            return JSON.stringify({
              binding: { parentSessionId: current.sessionId, cursor: current.cursor },
              observedAtMs: 1_775_995_220_000, startedAtMs: null, context: { usedTokens: 15_200, capacityTokens: 40_000 },
              extensionUi: { status: "available", requests: [
                ...(!settledExtensionRequests.has("editor-browser") ? [{ id: "editor-browser", method: "editor", title: "Extension instructions", prefill: "Private runtime prompt", cursor: current.cursor }] : []),
                ...(!settledExtensionRequests.has("input-browser") ? [{ id: "input-browser", method: "input", title: "Extension note", placeholder: "Private follow-up", cursor: current.cursor }] : []),
              ] },
              turnUsage: {
                totalTurns: 3, omittedTurns: 0,
                rows: [
                  { turn: 1, occurredAtMs: 1_775_995_200_000, input: 400, output: 120, cacheRead: 200, cacheWrite: 30, totalTokens: 750 },
                  { turn: 2, occurredAtMs: 1_775_995_210_000, input: 400, output: 140, cacheRead: 200, cacheWrite: 30, totalTokens: 770 },
                  { turn: 3, occurredAtMs: 1_775_995_219_000, input: 440, output: 170, cacheRead: 240, cacheWrite: 30, totalTokens: 880 },
                ],
              },
              contributions: [], notices: [{ id: "overload-browser", kind: "warning", title: "Runtime busy", detail: "server_is_overloaded", retryable: true, dismissible: true }],
              activity: [{ id: "activity-browser", occurredAtMs: 1_775_995_218_000, group: "Tools", kind: "tool", title: "Redacted shell command", detail: "Completed", tool: { command: "[escaped] curl [REDACTED_SECRET] [REDACTED_PROFILE_PATH] \\n \\u{202E}", redacted: true, status: "succeeded", durationMs: null, files: [{ candidateId: "candidate-browser-activity", label: "activity-report.md" }] } }],
              outputs: [{ id: "output-browser", label: "Harness report", candidateId: "candidate-browser-output", kind: "file" }],
              sources: [{ id: "source-browser", label: "Harness contract", detail: "Verified fixture source", candidateId: "candidate-browser-source", kind: "file" }],
              children,
            });
          }
          case "harness_composer_projection": {
            const request = args.request as { sessionId?: string } | undefined;
            if (!projectedHarnessSessions.some((session) => session.sessionId === request?.sessionId)) throw new Error("Harness composer projection unavailable");
            return JSON.stringify({
              models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", shortLabel: "Sol", enabled: true }],
              selectedModel: "gpt-5.6-sol",
              thinkingLevels: ["high"], selectedThinking: "high",
              supportedCommands: ["model", "effort", "compact", "fork", "export"],
            });
          }
          case "harness_child_data_page": {
            const request = args.request as { tab?: "chat" | "activity" | "files" } | undefined;
            if (!request?.tab) throw new Error("Child page request invalid");
            return JSON.stringify({ status: "unavailable", tab: request.tab, reason: "Deterministic fixtures do not supply authoritative child paging evidence." });
          }
          case "harness_artifact_open": {
            const request = args.request as { sessionId?: string; candidateId?: string } | undefined;
            if (request?.sessionId !== "session-e2e" || !["candidate-browser-output", "candidate-browser-source", "candidate-browser-activity"].includes(request?.candidateId ?? "")) {
              return { kind: "unsupported", reason: "The artifact candidate is forged, stale, or belongs to another Harness session." };
            }
            return { kind: "opened", document: {
              label: request.candidateId === "candidate-browser-output" ? "harness-report.md" : request.candidateId === "candidate-browser-activity" ? "activity-report.md" : "harness-contract.md",
              ref: { brokerId: "browser-broker", rootSessionId: "session-e2e", artifactId: request.candidateId, revision: artifactRevision },
              identity: artifactIdentity, content: artifactContent, writable: true, diff: [],
            } };
          }
          case "editor_artifact_save": {
            const request = args.request as { ref?: { revision?: number }; expectedRevision?: number; expectedIdentity?: string; content?: string } | undefined;
            if (!request || request.content === "external conflict" || request.ref?.revision !== artifactRevision || request.expectedRevision !== artifactRevision || request.expectedIdentity !== artifactIdentity) {
              return { kind: "conflict", message: "The file changed on disk. Reopen it before saving." };
            }
            artifactRevision += 1;
            artifactIdentity = `sha256:${"b".repeat(63)}${artifactRevision % 10}`;
            artifactContent = request.content;
            return { kind: "saved", revision: artifactRevision, identity: artifactIdentity };
          }
          case "editor_artifact_reload": {
            const request = args.request as { artifactRef?: { brokerId?: string; rootSessionId?: string; artifactId?: string } } | undefined;
            if (request?.artifactRef?.brokerId !== "browser-broker" || request.artifactRef.rootSessionId !== "session-e2e" || !["candidate-browser-output", "candidate-browser-source"].includes(request.artifactRef.artifactId ?? "")) {
              return { kind: "unsupported", reason: "The artifact reload identity is stale or unavailable." };
            }
            return { kind: "opened", document: {
              label: request.artifactRef.artifactId === "candidate-browser-output" ? "harness-report.md" : "harness-contract.md",
              ref: { brokerId: "browser-broker", rootSessionId: "session-e2e", artifactId: request.artifactRef.artifactId, revision: artifactRevision },
              identity: artifactIdentity, content: artifactContent, writable: true, diff: [],
            } };
          }
          case "editor_artifact_save_copy": {
            const request = args.request as { ref?: { brokerId?: string; rootSessionId?: string; artifactId?: string; revision?: number }; content?: string } | undefined;
            if (!request || request.ref?.brokerId !== "browser-broker" || request.ref.rootSessionId !== "session-e2e" || request.ref.revision !== artifactRevision || typeof request.content !== "string") {
              return { kind: "error", message: "The save-copy identity is stale or unavailable." };
            }
            return { kind: "saved_copy", label: "harness-report.prime-copy.md" };
          }
          case "get_layout_preferences":
            return { ...layoutPreferences };
          case "set_layout_preferences":
            layoutPreferences = { ...args?.preferences } as typeof layoutPreferences;
            return { ...layoutPreferences };
          case "project_catalog_load":
            return {
              revision: 0,
              state: {
                schemaVersion: 2,
                selectedProjectId: "project:personal",
                projects: [{
                  id: "project:personal",
                  kind: "personal",
                  name: "Personal",
                  root: { kind: "studio-managed-empty" },
                  pinned: false,
                  archived: false,
                  selectedChatId: "chat-e2e",
                  chats: [{
                    id: "chat-e2e",
                    projectId: "project:personal",
                    title: "Prime Harness architecture",
                    pinned: true,
                    archived: false,
                    binding: { kind: "prime-session", accountId: "account-e2e", sessionId: "session-e2e", sessionFile: "session-e2e.jsonl", agentId: null },
                  }, {
                    id: "chat-idle",
                    projectId: "project:personal",
                    title: "Inactive planning notes",
                    pinned: false,
                    archived: false,
                    binding: null,
                  }],
                }],
              },
            };
          case "chat_display_load":
            return { schemaVersion: 1, records: [...chatDisplayRecords.values()] };
          case "chat_display_apply": {
            const request = args.request as { chatId?: string; messageId?: string; expectedRevision?: number; sourceContent?: string; content?: string } | undefined;
            if (!request || request.chatId !== "chat-e2e" || typeof request.messageId !== "string" || typeof request.sourceContent !== "string" || typeof request.content !== "string" || !Number.isSafeInteger(request.expectedRevision)) {
              throw new Error("invalidInput");
            }
            const key = `${request.chatId}\u0000${request.messageId}`;
            const current = chatDisplayRecords.get(key);
            if ((current?.revision ?? 1) !== request.expectedRevision) throw new Error("revisionConflict");
            const record = { chatId: request.chatId, messageId: request.messageId, revision: request.expectedRevision + 1, sourceContent: request.sourceContent, content: request.content };
            chatDisplayRecords.set(key, record);
            return record;
          }
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
    }, harnessScenario);

    await page.goto("/");
    await expect(page.getByPlaceholder("Message Prime")).toBeVisible();
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

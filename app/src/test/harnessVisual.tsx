import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { RootSessionProjection } from "../entities/harness/types";
import type { HarnessInspectorAdapter, HarnessPanelDetails } from "../features/harness/adapter";
import { HarnessInspector } from "../features/harness/HarnessInspector";

const now = Date.now();
const session: RootSessionProjection = {
  sessionId: "visual-session", accountId: null, provider: "openai-codex", projectId: "prime-studio", chatId: "visual-chat",
  cursor: { runtimeGeneration: "visual", sequence: 24 }, state: "working", freshness: "live",
  parentMessages: [],
  children: [
    { id: "fidelity", status: "running", task: "Interface fidelity review", provider: "openai-codex", model: "gpt-5.6-sol", progress: .68 },
    { id: "architecture", status: "running", task: "Architecture integration", provider: "openai-codex", model: "gpt-5.6-sol", progress: .42 },
    { id: "usage", status: "done", task: "Usage model", provider: "openai-codex", model: "gpt-5.6-terra", progress: 1 },
  ],
  queue: [{ id: "queue-1", label: "Responsive behavior audit", state: "queued" }],
  tools: [
    { id: "workspace", label: "Workspace access", enabled: true, configurable: true },
    { id: "browser", label: "Browser", enabled: true, configurable: true },
  ],
  resources: [
    { id: "agents", label: "AGENTS.md", kind: "context file", availability: "available" },
    { id: "repo", label: "Repository", kind: "prime-studio (local)", availability: "available" },
  ],
  usage: { input: 28_900, output: 6_200, cacheRead: 5_900, cacheWrite: 1_800, totalTokens: 42_800, cost: null },
  workerRecovery: { status: "ready", closureReason: null, observationId: null, automaticRetryCount: 0, detail: null },
  performance: { status: "unavailable", sessionId: "visual-session", cursor: { runtimeGeneration: "visual", sequence: 24 }, reason: "event_chronology_unavailable" },
};

const details: HarnessPanelDetails = {
  extensionUi: { status: "available", requests: [] },
  observedAtMs: now, startedAtMs: now - 767_000,
  context: { usedTokens: 15_200, capacityTokens: 40_000, turns: 12, samples: [.19, .24, .31, .38] },
  contributions: [{ id: "main", label: "Main chat", tokens: 30_300 }, { id: "child", label: "Subagents", tokens: 8_600 }, { id: "tools", label: "Tools", tokens: 3_900 }],
  notices: [],
  outputs: [{ id: "output", label: "Harness integration plan", candidateId: "candidate-output", kind: "file" }],
  sources: [{ id: "source", label: "Prime Harness snapshot", detail: "Verified runtime projection", kind: "runtime" }],
  activity: [
    { id: "a1", occurredAtMs: now - 360_000, group: "Today", kind: "agent", title: "Interface fidelity review spawned", detail: "rlm() child", childId: "fidelity" },
    { id: "a2", occurredAtMs: now - 240_000, group: "Today", kind: "tool", title: "Workspace source scan", detail: "Completed", tool: { command: "rg --files app/src", status: "succeeded", durationMs: 840, files: [{ candidateId: "candidate-tool", label: "HarnessInspector.tsx" }] } },
    { id: "a3", occurredAtMs: now - 120_000, group: "Today", kind: "file", title: "Harness panel updated", detail: "HarnessInspector.tsx", artifactCandidateId: "candidate-activity" },
  ],
  children: {
    fidelity: { summary: "Compare the operational inspector against the approved Prime Studio handoff.", startedAtMs: now - 620_000, context: { usedTokens: 6_400, capacityTokens: 40_000 }, transcript: [{ id: "m1", actor: "Harness", occurredAtMs: now - 610_000, text: "Task accepted. Reading the handoff and current implementation." }, { id: "m2", actor: "Agent", occurredAtMs: now - 430_000, text: "The information hierarchy is mapped. Verifying keyboard and narrow-width behavior next." }], activity: [{ id: "ca1", occurredAtMs: now - 600_000, label: "Opened prototype handoff" }, { id: "ca2", occurredAtMs: now - 410_000, label: "Compared panel geometry" }], files: [{ id: "cf1", label: "HarnessInspector.tsx", candidateId: "candidate-child", change: "modified" }], error: null },
    architecture: { summary: "Wire runtime commands to typed operation outcomes.", startedAtMs: now - 520_000, context: { usedTokens: 4_100, capacityTokens: 40_000 }, transcript: [], activity: [], files: [], error: null },
    usage: { summary: "Verify chat-only token attribution.", startedAtMs: now - 980_000, context: { usedTokens: 3_200, capacityTokens: 40_000 }, transcript: [], activity: [], files: [], error: null },
  },
};

const adapter: HarnessInspectorAdapter = { availability: { status: "available" }, load: async () => details, execute: async () => ({ status: "accepted", commandId: crypto.randomUUID() }) };
createRoot(document.getElementById("root")!).render(<StrictMode><div className="fixture"><HarnessInspector chatId={session.chatId} session={session} compatibility={{ status: "ready", profile: "visual", capabilities: ["queue_management", "resource_snapshot", "delete_child"] }} adapter={adapter} /></div></StrictMode>);

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createProviderEventEvidence,
  createProviderOperation,
  createProviderEventStream,
  createUnavailableProviderOperation,
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  validateTargetResolution,
} from "./contract";
import type {
  AccountDescriptor,
  ApprovalRequest,
  AssistantContentBlock,
  FallbackDecision,
  ForkSessionRequest,
  InterruptSessionRequest,
  JsonSchema,
  ModelExecutionSettings,
  ModelDescriptor,
  ProviderAdapterCatalogV1,
  ProviderAdapterError,
  ProviderAdapterFailure,
  ProviderAdapterResult,
  ProviderAdapterUnavailableResult,
  ProviderAdapterV1,
  ProviderCapabilityOperation,
  ProviderEvent,
  ProviderEventStreamContext,
  ProviderTelemetrySnapshot,
  ProviderOperationName,
  RateLimitWindow,
  ResumeSessionRequest,
  SendMessageRequest,
  SendMessageResult,
  StartSessionRequest,
  StructuredOutputRequest,
  StructuredOutputOutcome,
  StructuredOutputResult,
  SubmittedToolResult,
  SubmitToolResultRequest,
  TargetResolution,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UsageRecord,
  UserInputPrompt,
  RespondToApprovalRequest,
  RespondToUserInputRequest,
} from "./contract";

type QuotaExtensions = {
  readonly refreshQuota: ProviderCapabilityOperation<
    "anthropic",
    "extension:refresh_quota",
    { readonly accountId: string },
    { readonly remaining: number; readonly resetsAt: number }
  >;
};

const SYNTHETIC_PROJECT_ROOT = "C:\\synthetic\\prime-studio-project";

function success<T>(value: T): ProviderAdapterResult<T> {
  return { kind: "success", value, fallbackDecisions: [] };
}

const testNormalization = {
  normalize: ({ context }: { context: { providerId: string; requestId?: string } }) => ({
    code: "internal" as const,
    providerId: context.providerId,
    requestId: context.requestId,
    message: "The provider adapter failed unexpectedly.",
    retryable: false,
    diagnosticId: "diagnostic-1",
  }),
};

const anthropicEventEvidence = createProviderEventEvidence({ providerId: "anthropic" });

function supported<TRequest, TResult, TOperation extends ProviderOperationName>(
  operation: TOperation,
  execute: (request: TRequest) => Promise<ProviderAdapterResult<TResult>>,
  resultValidator?: (value: unknown, request: TRequest) => value is TResult,
): ProviderCapabilityOperation<"anthropic", TOperation, TRequest, TResult> {
  return createProviderOperation({
    providerId: "anthropic",
    operation,
    eventEvidence: anthropicEventEvidence,
    errorNormalization: testNormalization,
    resultValidator,
    execute,
  });
}

const toolDefinition = {
  name: "shell",
  description: "Run an approved command.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      exitCode: { type: "number" },
      output: { type: "string" },
    },
    required: ["exitCode", "output"],
  },
  providerSpecific: {
    safetyClass: "terminal",
  },
} satisfies ToolDefinition;

const toolCall = {
  toolCallId: "tool-call-1",
  toolName: "shell",
  blockIndex: 3,
  arguments: {
    state: "complete",
    text: '{"command":"git status --short"}',
    value: { command: "git status --short" },
  },
} satisfies ToolCall;

const partialToolCall = {
  toolCallId: "tool-call-2",
  toolName: "shell",
  blockIndex: 4,
  arguments: { state: "partial", text: '{"command":"git stat' },
} satisfies ToolCall;

const toolResult = {
  toolCallId: "tool-call-1",
  toolName: "shell",
  blockIndex: 0,
  state: "success",
  output: { exitCode: 0, output: "" },
  startedAt: 10,
  completedAt: 11,
} satisfies ToolResult;

const assistantBlocks = [
  { type: "text", index: 0, text: "Working tree is clean." },
  {
    type: "thinking",
    index: 1,
    text: "I checked the repository status.",
    visibility: "collapsed",
    providerSpecific: { signature: "thinking-signature" },
  },
  { type: "refusal", index: 2, message: "I cannot delete that directory.", reasonCode: "unsafe_path" },
  { type: "tool_call", index: 3, call: toolCall },
] satisfies readonly AssistantContentBlock[];

const structuredOutputRequest = {
  schemaName: "repository_status",
  schemaHash: "sha256:repository-status-v1",
  description: "A structured repository status result.",
  schema: {
    type: "object",
    properties: {
      clean: { type: "boolean" },
      changedFiles: { type: "array", items: { type: "string" } },
    },
    required: ["clean", "changedFiles"],
    additionalProperties: false,
  },
  strict: true,
} satisfies StructuredOutputRequest;

const structuredOutputIdentity = {
  schemaName: structuredOutputRequest.schemaName,
  schemaHash: structuredOutputRequest.schemaHash,
  strict: structuredOutputRequest.strict,
};

const structuredOutputResult = {
  schemaName: "repository_status",
  value: { clean: true, changedFiles: [] },
  validation: { state: "valid" },
} satisfies StructuredOutputResult;

const structuredOutputOutcomes = [
  { state: "not_requested" },
  { state: "present", request: structuredOutputIdentity, result: structuredOutputResult },
  {
    state: "refused",
    request: structuredOutputIdentity,
    message: "The provider refused this structured response.",
  },
  {
    state: "unavailable",
    request: structuredOutputIdentity,
    availability: { state: "unavailable", reason: "not_available_for_model" },
  },
  {
    state: "invalid",
    request: structuredOutputIdentity,
    rawText: "not-json",
    issues: [{ path: [], message: "Expected JSON." }],
  },
  { state: "incomplete", request: structuredOutputIdentity, accumulatedJson: '{"clean":' },
] satisfies readonly StructuredOutputOutcome[];

const modelSettings = {
  effort: {
    optionId: "high",
    providerValue: { thinkingBudget: "high" },
  },
  reasoning: {
    mode: "extended",
    budgetTokens: 8_000,
    summary: "auto",
    providerSpecific: { interleaved: true },
  },
  providerSpecific: {
    serviceTier: "priority",
  },
} satisfies ModelExecutionSettings;

const startRequest = {
  requestId: "request-start-1",
  target: {
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
  },
  fallback: {
    mode: "allow",
    scopes: ["account", "model"],
    confirmation: "on-provider-change",
  },
  execution: {
    settings: modelSettings,
    tools: [toolDefinition],
    structuredOutput: structuredOutputRequest,
  },
  workingDirectory: SYNTHETIC_PROJECT_ROOT,
  initialMessage: [{ type: "text", text: "Inspect the repository." }],
} satisfies StartSessionRequest;

const sendRequest = {
  requestId: "request-send-1",
  sessionId: "session-1",
  threadId: "thread-1",
  turn: { kind: "new", parentTurnId: "turn-0" },
  target: startRequest.target,
  fallback: { mode: "forbid" },
  execution: {
    settings: modelSettings,
    tools: [toolDefinition],
    structuredOutput: structuredOutputRequest,
  },
  parts: [{ type: "text", text: "Return structured status." }],
  delivery: "queue",
} satisfies SendMessageRequest;

const resumeRequest = {
  sessionId: "session-1",
  threadId: "thread-1",
  target: startRequest.target,
  fallback: { mode: "forbid" },
  boundary: { kind: "after_event", eventId: "event-4" },
} satisfies ResumeSessionRequest;

const forkRequest = {
  sessionId: "session-1",
  threadId: "thread-1",
  target: startRequest.target,
  fallback: startRequest.fallback,
  boundary: { kind: "after_message", messageId: "message-1" },
} satisfies ForkSessionRequest;

const interruptRequest = {
  sessionId: "session-1",
  threadId: "thread-1",
  target: { kind: "tool_call", turnId: "turn-1", toolCallId: "tool-call-1" },
  reason: "user_requested",
} satisfies InterruptSessionRequest;

const submitToolResultRequest = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  toolCallId: "tool-call-1",
  assistantBlockIndex: 3,
  toolResultBlockIndex: 0,
  result: { state: "success", output: { exitCode: 0, output: "" } },
} satisfies SubmitToolResultRequest;

const submittedToolResults = [
  { state: "success", output: { exitCode: 0 } },
  {
    state: "error",
    error: {
      code: "tool_failure",
      providerId: "anthropic",
      message: "Tool execution failed.",
      retryable: false,
      toolCallId: "tool-call-1",
      toolName: "shell",
      failureKind: "execution",
    },
  },
  { state: "cancel", reason: "The user cancelled tool execution." },
] satisfies readonly SubmittedToolResult[];

const unavailableResume: ProviderAdapterUnavailableResult = {
  kind: "error",
  fallbackDecisions: [],
  error: {
    code: "operation_unavailable",
    providerId: "anthropic",
    message: "This provider cannot resume sessions.",
    retryable: false,
    operation: "resume",
    availability: {
      state: "unavailable",
      reason: "not_supported_by_provider",
    },
  },
};

const adapter = {
  contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
  provider: {
    providerId: "anthropic",
    displayName: "Anthropic",
  },
  capabilities: {
    cancellation: {
      availability: { state: "available" },
      modes: ["abort-signal", "session-interrupt"],
    },
    rateLimits: {
      availability: { state: "available" },
      delivery: "poll",
    },
    authenticationExpiry: {
      availability: { state: "available" },
      delivery: "poll",
    },
    contextLimits: {
      availability: { state: "available" },
      delivery: "poll",
    },
    providerSpecific: {
      refreshQuota: {
        availability: { state: "available" },
        displayName: "Refresh subscription quota",
      },
    },
  },
  errorNormalization: testNormalization,
  operations: {
    discovery: {
      accounts: supported("discover_accounts", async () =>
        success([
          {
            accountId: "acct-work",
            providerId: "anthropic",
            displayName: "Work",
            authentication: { state: "valid", method: "oauth", mode: "interactive" },
            capabilityReadiness: [
              { operation: "start", state: "ready" },
              { operation: "resume", state: "unavailable", reason: "not_supported_by_provider" },
            ],
          },
        ]),
      ),
      models: supported("discover_models", async () =>
        success([
          {
            modelId: "claude-sonnet",
            providerId: "anthropic",
            accountId: "acct-work",
            displayName: "Claude Sonnet",
            capabilities: {
              input: {
                text: { state: "available" },
                image: { state: "available" },
                file: { state: "unavailable", reason: "not_supported_by_provider" },
              },
              output: {
                text: { state: "available" },
                thinking: { state: "available" },
                refusal: { state: "available" },
                toolCalls: { state: "available" },
                structuredOutput: { state: "available" },
              },
              reasoning: {
                availability: { state: "available" },
                modes: [
                  {
                    modeId: "extended",
                    displayName: "Extended thinking",
                    providerValue: { thinking: "enabled" },
                  },
                ],
              },
              providerSpecific: {
                promptCaching: {
                  availability: { state: "available" },
                  displayName: "Prompt caching",
                },
              },
            },
            limits: {
              contextWindowTokens: 200_000,
              maxInputTokens: 180_000,
              maxOutputTokens: 20_000,
              maxReasoningTokens: 12_000,
              maxToolCallsPerTurn: 64,
              providerSpecific: { maxImages: 20 },
            },
            effort: {
              availability: { state: "available" },
              options: [
                {
                  optionId: "high",
                  displayName: "High",
                  providerValue: { thinkingBudget: "high" },
                },
              ],
            },
          },
        ]),
      ),
    },
    sessions: {
      start: supported("start", async () =>
        success({
          session: {
            sessionId: "session-1",
            threadId: "thread-1",
            providerId: "anthropic",
            accountId: "acct-work",
            modelId: "claude-sonnet",
            activeTurnId: "turn-1",
          },
          target: {
            kind: "exact",
            target: {
              providerId: "anthropic",
              accountId: "acct-work",
              modelId: "claude-sonnet",
            },
          },
        }),
      ),
      resume: createUnavailableProviderOperation({
        providerId: "anthropic",
        operation: "resume",
        availability: {
          state: "unavailable",
          reason: "not_supported_by_provider",
        },
        message: "This provider cannot resume sessions.",
      }),
      fork: supported("fork", async () =>
        success({
          session: {
            sessionId: "session-2",
            threadId: "thread-2",
            providerId: "anthropic",
            accountId: "acct-work",
            modelId: "claude-sonnet",
            activeTurnId: "turn-1",
          },
          target: {
            kind: "exact",
            target: {
              providerId: "anthropic",
              accountId: "acct-work",
              modelId: "claude-sonnet",
            },
          },
        }),
      ),
      send: supported("send", async () =>
        success({
          messageId: "message-1",
          turnId: "turn-1",
          target: {
            kind: "exact",
            target: startRequest.target,
          },
          structuredOutput: {
            state: "present",
            request: structuredOutputIdentity,
            result: structuredOutputResult,
          },
        }),
      ),
      submitToolResult: supported("submit_tool_result", async (request) =>
        success({
          accepted: true,
          toolCallId: request.toolCallId,
          state: request.result.state,
        }),
      ),
      interrupt: supported("interrupt", async () =>
        success({
          interrupted: true,
          turnId: "turn-1",
          target: interruptRequest.target,
        }),
      ),
      events: supported("events", async (request) =>
        success(
          createProviderEventStream({
            providerId: "anthropic",
            accountId: request.accountId,
            eventEvidence: anthropicEventEvidence,
            errorNormalization: testNormalization,
            context: {
              sessionId: request.sessionId,
              threadId: request.threadId,
              turnId: request.turnId,
            },
            close: async () => undefined,
            events: {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "usage",
                  eventId: "event-1",
                  sequence: 1,
                  occurredAt: 1,
                  session: {
                    sessionId: "session-1",
                    threadId: "thread-1",
                    providerId: "anthropic",
                    accountId: "acct-work",
                    modelId: "claude-sonnet",
                    activeTurnId: "turn-1",
                  },
                  turnId: "turn-1",
                  usage: {
                    scope: "message",
                    identity: {
                      sessionId: "session-1",
                      threadId: "thread-1",
                      turnId: "turn-1",
                      messageId: "message-1",
                    },
                    inputTokens: 10,
                    outputTokens: 5,
                    reasoningTokens: 3,
                    cachedInputTokens: 1,
                    cacheWriteTokens: 1,
                    totalTokens: 20,
                    provenance: {
                      kind: "provider-reported",
                      authoritative: true,
                      reportedAt: 1,
                    },
                  },
                } satisfies ProviderEvent;
              },
            },
          }),
        ),
      ),
    },
    interactions: {
      respondToApproval: createUnavailableProviderOperation({
        providerId: "anthropic",
        operation: "respond_to_approval",
        availability: { state: "unavailable", reason: "not_supported_by_provider" },
      }),
      respondToUserInput: createUnavailableProviderOperation({
        providerId: "anthropic",
        operation: "respond_to_user_input",
        availability: { state: "unavailable", reason: "not_supported_by_provider" },
      }),
    },
    telemetry: {
      poll: supported("poll_telemetry", async (request) =>
        success({
          providerId: "anthropic",
          accountId: request.accountId,
          sessionId: request.sessionId,
          threadId: request.threadId,
          capturedAt: 1_500,
          results: [
            {
              kind: "authentication",
              state: "value",
              value: { state: "valid", method: "oauth", mode: "interactive" },
            },
            {
              kind: "rate_limits",
              state: "value",
              value: { state: "within_limit", windows: [] },
            },
          ],
          response: {
            requestId: "provider-request-telemetry",
            statusCode: 200,
            receivedAt: 1_500,
          },
        }),
      ),
    },
  },
  extensions: {
    refreshQuota: supported(
      "extension:refresh_quota",
      async () => success({ remaining: 72, resetsAt: 2_000 }),
      (value: unknown): value is { readonly remaining: number; readonly resetsAt: number } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { remaining?: unknown }).remaining === "number" &&
        typeof (value as { resetsAt?: unknown }).resetsAt === "number",
    ),
  },
} satisfies ProviderAdapterV1<"anthropic", QuotaExtensions>;

const visibleFallback = {
  decisionId: "fallback-1",
  visibleEventId: "event-fallback-1",
  decidedAt: 1,
  reason: "rate_limited",
  policy: {
    mode: "allow",
    scopes: ["account"],
    confirmation: "never",
  },
  confirmation: { kind: "not_required", reason: "policy_never" },
  requested: {
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
  },
  resolved: {
    providerId: "anthropic",
    accountId: "acct-personal",
    modelId: "claude-sonnet",
  },
  notice: {
    visibility: "required",
    title: "Switched account",
    message: "Work is rate-limited, so this request uses your personal account.",
  },
} satisfies FallbackDecision;

const fallbackResolution = {
  kind: "fallback",
  requested: visibleFallback.requested,
  resolved: visibleFallback.resolved,
  decision: visibleFallback,
} satisfies TargetResolution;

const catalog = {
  contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
  errorNormalization: adapter.errorNormalization,
  operations: {
    discoverProviders: supported("discover_providers", async () => success([adapter.provider])),
    resolveAdapter: supported("resolve_adapter", async () => success(adapter)),
  },
} satisfies ProviderAdapterCatalogV1;

const fallbackEvent = {
  type: "fallback",
  eventId: "event-fallback-1",
  sequence: 2,
  occurredAt: 2,
  session: {
    sessionId: "session-1",
    threadId: "thread-1",
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
    activeTurnId: "turn-1",
  },
  turnId: "turn-1",
  decision: visibleFallback,
} satisfies ProviderEvent;

const assistantMessageEvent = {
  type: "message",
  eventId: "event-message-1",
  sequence: 3,
  occurredAt: 3,
  session: {
    sessionId: "session-1",
    threadId: "thread-1",
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
    activeTurnId: "turn-1",
  },
  turnId: "turn-1",
  message: {
    messageId: "message-2",
    turnId: "turn-1",
    role: "assistant",
    blocks: assistantBlocks,
    state: "completed",
    structuredOutput: {
      state: "present",
      request: structuredOutputIdentity,
      result: structuredOutputResult,
    },
  },
} satisfies ProviderEvent;

const toolEvent = {
  type: "tool",
  eventId: "event-tool-1",
  sequence: 4,
  occurredAt: 4,
  session: {
    sessionId: "session-1",
    threadId: "thread-1",
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
    activeTurnId: "turn-1",
  },
  turnId: "turn-1",
  definition: toolDefinition,
  call: toolCall,
  result: toolResult,
  state: "completed",
} satisfies ProviderEvent;

const approvalChoices = [
  {
    choiceId: "allow-once",
    label: "Allow once",
    action: "approve",
    scope: "once",
    options: [
      { optionId: "remember", label: "Remember", value: false, selectedByDefault: true },
    ],
  },
  { choiceId: "allow-session", label: "Allow for session", action: "approve", scope: "session" },
  { choiceId: "deny", label: "Deny", action: "deny", scope: "once" },
  { choiceId: "cancel", label: "Cancel", action: "cancel", scope: "once" },
  {
    choiceId: "amend",
    label: "Edit command",
    action: "amend",
    scope: "once",
    amendmentSchema: { type: "object" },
  },
] as const;

const approvalRequests = [
  {
    approvalId: "approval-command",
    title: "Run command?",
    message: "The agent wants to inspect the repository.",
    expiresAt: 30_000,
    subject: {
      kind: "command",
      command: {
        program: "git",
        arguments: ["status", "--short"],
        cwd: SYNTHETIC_PROJECT_ROOT,
      },
    },
    choices: approvalChoices,
  },
  {
    approvalId: "approval-diff",
    title: "Apply diff?",
    message: "The agent proposes a source change.",
    expiresAt: 30_000,
    subject: {
      kind: "diff",
      patch: "diff --git a/file b/file",
      files: ["file"],
    },
    choices: approvalChoices,
  },
  {
    approvalId: "approval-policy",
    title: "Change policy?",
    message: "The agent requests a scoped policy grant.",
    expiresAt: null,
    subject: {
      kind: "policy",
      policyId: "terminal-read",
      rule: "allow git status",
      scope: "session",
    },
    choices: approvalChoices,
  },
] satisfies readonly ApprovalRequest[];

const userInputPrompt = {
  inputId: "input-1",
  title: "Configure the change",
  message: "Choose a branch and edit the commit message.",
  expiresAt: 45_000,
  allowCancel: true,
  questions: [
    {
      questionId: "branch",
      kind: "select",
      label: "Branches",
      required: true,
      selection: "multiple",
      options: [
        { optionId: "main", value: "main", label: "main" },
        { optionId: "develop", value: "develop", label: "develop" },
      ],
    },
    {
      questionId: "message",
      kind: "editor",
      label: "Commit message",
      required: true,
      language: "git-commit",
      initialValue: "feat: ",
    },
  ],
} satisfies UserInputPrompt;

const approvalAmendment = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  approvalId: "approval-command",
  choiceId: "amend",
  action: "amend",
  selectedOptionIds: ["remember"],
  amendment: {
    kind: "command",
    program: "git",
    arguments: ["status", "--short"],
    cwd: SYNTHETIC_PROJECT_ROOT,
  },
} satisfies RespondToApprovalRequest;

const userInputResponse = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  inputId: "input-1",
  action: "submit",
  answers: [
    {
      questionId: "branch",
      kind: "select",
      selection: "multiple",
      optionIds: ["main", "develop"],
    },
    { questionId: "message", kind: "editor", value: "feat: provider contract" },
  ],
} satisfies RespondToUserInputRequest;

const cancelledUserInputResponse = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  inputId: "input-1",
  action: "cancel",
  reason: "User dismissed the prompt.",
} satisfies RespondToUserInputRequest;

const rateLimitWindow = {
  windowId: "tokens-5m",
  dimension: "tokens",
  window: {
    kind: "rolling",
    durationMs: 300_000,
    startedAt: 1_000,
    resetsAt: 301_000,
  },
  limit: 100_000,
  used: 75_000,
  remaining: 25_000,
  utilizationPercent: 75,
  plan: {
    planId: "team",
    displayName: "Team",
    tier: "paid",
  },
  provenance: {
    kind: "provider-response",
    authoritative: true,
    capturedAt: 1_500,
  },
  response: {
    requestId: "provider-request-1",
    statusCode: 200,
    receivedAt: 1_500,
    retryAfterMs: 0,
    providerRegion: "us-east",
  },
} satisfies RateLimitWindow;

const childUsage = {
  scope: "child",
  identity: {
    sessionId: "session-1",
    threadId: "thread-1",
    turnId: "turn-1",
    child: {
      sessionId: "session-child-1",
      threadId: "thread-child-1",
      turnId: "turn-child-1",
    },
  },
  inputTokens: 100,
  outputTokens: 40,
  reasoningTokens: 20,
  cachedInputTokens: 10,
  cacheWriteTokens: 5,
  totalTokens: 175,
  provenance: {
    kind: "provider-reported",
    authoritative: true,
    reportedAt: 5,
    providerRequestId: "provider-request-child",
  },
} satisfies UsageRecord;

const operationalErrors = [
  {
    code: "cancelled",
    providerId: "anthropic",
    message: "The caller cancelled the request.",
    retryable: false,
    cancellationScope: "request",
  },
  {
    code: "rate_limited",
    providerId: "anthropic",
    message: "Retry later.",
    retryable: true,
    retryAfterMs: 1_000,
  },
  {
    code: "authentication_expired",
    providerId: "anthropic",
    message: "Sign in again.",
    retryable: false,
    expiredAt: 1,
  },
  {
    code: "context_limit_exceeded",
    providerId: "anthropic",
    message: "The requested prompt exceeds the context window.",
    retryable: false,
    contextWindowTokens: 200_000,
  },
  {
    code: "deadline_exceeded",
    providerId: "anthropic",
    message: "The request deadline elapsed.",
    retryable: true,
    deadlineAt: 10_000,
  },
  {
    code: "tool_failure",
    providerId: "anthropic",
    message: "The shell tool failed.",
    retryable: false,
    toolCallId: "tool-call-1",
    toolName: "shell",
    failureKind: "execution",
  },
  {
    code: "approval_denied",
    providerId: "anthropic",
    message: "The command was denied.",
    retryable: false,
    approvalId: "approval-command",
    choiceId: "deny",
  },
  {
    code: "approval_expired",
    providerId: "anthropic",
    message: "The approval request expired.",
    retryable: false,
    approvalId: "approval-command",
    expiredAt: 30_000,
  },
  {
    code: "input_expired",
    providerId: "anthropic",
    message: "The input request expired.",
    retryable: false,
    inputId: "input-1",
    expiredAt: 45_000,
  },
] satisfies readonly ProviderAdapterError[];

const silentFallback = {
  kind: "fallback" as const,
  requested: visibleFallback.requested,
  resolved: visibleFallback.resolved,
};
// @ts-expect-error A changed target requires a recorded, visible fallback decision.
const invalidSilentFallback: TargetResolution = silentFallback;

const startWithoutFallback = {
  target: startRequest.target,
  execution: startRequest.execution,
};
// @ts-expect-error Start requests must explicitly allow or forbid fallback.
const invalidStartWithoutFallback: StartSessionRequest = startWithoutFallback;

const inputWithoutExpiry = {
  inputId: "input-without-expiry",
  title: "Missing expiry",
  allowCancel: true,
  questions: [
    { questionId: "confirm", kind: "confirm" as const, label: "Continue?", required: true },
  ] as const,
};
// @ts-expect-error User-input requests must state an expiry or explicit no-expiry value.
const invalidInputWithoutExpiry: UserInputPrompt = inputWithoutExpiry;

const incompleteToolCallBlock = {
  type: "tool_call" as const,
  index: 0,
  call: { toolCallId: "tool-call-missing-arguments", toolName: "shell", blockIndex: 0 },
};
// @ts-expect-error Tool-call blocks require a typed argument payload.
const invalidToolCallBlock: AssistantContentBlock = incompleteToolCallBlock;

const successToolResultWithoutOutput = {
  toolCallId: "tool-call-no-output",
  toolName: "shell",
  state: "success" as const,
  blockIndex: 0,
  startedAt: 10,
  completedAt: 11,
};
// @ts-expect-error Successful tool results must carry their typed output payload.
const invalidSuccessToolResult: ToolResult = successToolResultWithoutOutput;

const rawExceptionFailure = {
  kind: "error" as const,
  error: new Error("provider secret"),
  fallbackDecisions: [],
};
// @ts-expect-error Adapter failures expose normalized errors, never raw exceptions.
const invalidRawExceptionFailure: ProviderAdapterFailure = rawExceptionFailure;

const directUnwrappedOperation = {
  capability: {
    operation: "send" as const,
    availability: { state: "available" as const },
  },
  execute: async () => success({ messageId: "message", turnId: "turn" }),
};
// @ts-expect-error Supported operations must be created through the enforced Result boundary.
const invalidDirectOperation: ProviderCapabilityOperation<
  "anthropic",
  "send",
  SendMessageRequest,
  unknown
> = directUnwrappedOperation;

const resumeWithoutResolutionPolicy = {
  sessionId: "session-1",
  threadId: "thread-1",
  boundary: { kind: "latest" as const },
};
// @ts-expect-error Resume must declare both its requested target and fallback policy.
const invalidResumeWithoutResolutionPolicy: ResumeSessionRequest = resumeWithoutResolutionPolicy;

const forkWithoutResolutionPolicy = {
  sessionId: "session-1",
  threadId: "thread-1",
  boundary: { kind: "after_turn" as const, turnId: "turn-1" },
};
// @ts-expect-error Fork must declare both its requested target and fallback policy.
const invalidForkWithoutResolutionPolicy: ForkSessionRequest = forkWithoutResolutionPolicy;

const accountWithoutAuthMode = {
  accountId: "acct-work",
  providerId: "anthropic",
  displayName: "Work",
  authentication: { state: "valid" as const },
};
// @ts-expect-error Accounts declare authentication method/mode and capability readiness.
const invalidAccountWithoutAuthMode: AccountDescriptor = accountWithoutAuthMode;

const modelWithoutAccount = {
  modelId: "claude-sonnet",
  providerId: "anthropic",
  displayName: "Claude Sonnet",
  capabilities: {} as ModelDescriptor["capabilities"],
  limits: {} as ModelDescriptor["limits"],
  effort: {} as ModelDescriptor["effort"],
};
// @ts-expect-error Every discovered model is bound to its provider account.
const invalidModelWithoutAccount: ModelDescriptor = modelWithoutAccount;

const incompleteToolSubmission = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  toolCallId: "tool-call-1",
  assistantBlockIndex: 3,
  toolResultBlockIndex: 0,
  result: { state: "success" as const },
};
// @ts-expect-error A successful tool submission requires its output value.
const invalidToolSubmission: SubmitToolResultRequest = incompleteToolSubmission;

const amendmentWithoutPayload = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  approvalId: "approval-command",
  choiceId: "amend",
  action: "amend" as const,
};
// @ts-expect-error An amend response must include the requested amendment.
const invalidAmendment: RespondToApprovalRequest = amendmentWithoutPayload;

const submittedInputWithoutAnswers = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  inputId: "input-1",
  action: "submit" as const,
};
// @ts-expect-error Submitting a multi-question prompt requires typed answers.
const invalidSubmittedInput: RespondToUserInputRequest = submittedInputWithoutAnswers;

const completeToolArgumentsWithoutValue = {
  toolCallId: "tool-call-incomplete-json",
  toolName: "shell",
  blockIndex: 0,
  arguments: { state: "complete" as const, text: "{}" },
};
// @ts-expect-error Complete streamed JSON must carry the parsed object value.
const invalidCompleteToolArguments: ToolCall = completeToolArgumentsWithoutValue;

const emptyQuestionPrompt = {
  inputId: "input-empty",
  title: "No questions",
  expiresAt: null,
  allowCancel: true,
  questions: [],
};
// @ts-expect-error A multi-question prompt must contain at least one question.
const invalidEmptyQuestionPrompt: UserInputPrompt = emptyQuestionPrompt;

const ambiguousSingleSelection = {
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  inputId: "input-1",
  action: "submit" as const,
  answers: [
    {
      questionId: "branch",
      kind: "select" as const,
      selection: "single" as const,
      optionIds: ["main"],
    },
  ],
};
// @ts-expect-error Single selection answers use one optionId, not an optionIds list.
const invalidSingleSelection: RespondToUserInputRequest = ambiguousSingleSelection;

const exhaustiveSchemas = [
  true,
  {
    $ref: "#/$defs/payload",
    $defs: {
      payload: {
        type: ["object", "null"],
        properties: { value: { type: ["string", "number"] } },
      },
    },
    "x-provider-keyword": { mode: "strict" },
  },
] satisfies readonly JsonSchema[];

const sendResultWithoutStructuredOutcome = {
  messageId: "message-with-silent-structured-output",
  turnId: "turn-1",
  target: { kind: "exact" as const, target: startRequest.target },
};
// @ts-expect-error Every send result must explicitly report the structured-output outcome.
const invalidSilentStructuredOutput: SendMessageResult = sendResultWithoutStructuredOutcome;

const invalidResultDisguisedAsPresent = {
  state: "present" as const,
  request: structuredOutputIdentity,
  result: {
    schemaName: "repository_status",
    value: { clean: true },
    validation: { state: "invalid" as const, issues: [{ path: [], message: "Missing field." }] },
  },
};
// @ts-expect-error Schema-invalid output uses the explicit invalid outcome, never present.
const invalidPresentStructuredOutput: StructuredOutputOutcome = invalidResultDisguisedAsPresent;

const structuredRefusalWithoutRequestIdentity = {
  state: "refused" as const,
  message: "No request identity supplied.",
};
// @ts-expect-error Every requested structured-output outcome is bound to its exact request identity.
const invalidUnboundStructuredOutcome: StructuredOutputOutcome = structuredRefusalWithoutRequestIdentity;

const approvalExpiredError = {
  code: "approval_expired",
  providerId: "anthropic",
  message: "The approval request expired.",
  retryable: false,
  approvalId: "approval-command",
  expiredAt: 30_000,
} satisfies ProviderAdapterError;

const telemetrySnapshot = {
  providerId: "anthropic",
  accountId: "acct-work",
  sessionId: null,
  threadId: null,
  capturedAt: 1_500,
  results: [
    { kind: "rate_limits", state: "value", value: { state: "within_limit", windows: [] } },
    {
      kind: "context_limits",
      state: "unavailable",
      availability: { state: "unavailable", reason: "not_supported_by_provider" },
    },
    {
      kind: "authentication",
      state: "error",
      error: {
        code: "authentication_expired",
        providerId: "anthropic",
        message: "Authentication expired.",
        retryable: false,
        accountId: "acct-work",
      },
    },
  ],
  response: { requestId: "telemetry-response", statusCode: 200, receivedAt: 1_500 },
} satisfies ProviderTelemetrySnapshot;

void invalidSilentFallback;
void invalidStartWithoutFallback;
void invalidInputWithoutExpiry;
void invalidToolCallBlock;
void invalidSuccessToolResult;
void invalidRawExceptionFailure;
void invalidDirectOperation;
void invalidResumeWithoutResolutionPolicy;
void invalidForkWithoutResolutionPolicy;
void invalidAccountWithoutAuthMode;
void invalidModelWithoutAccount;
void invalidToolSubmission;
void invalidAmendment;
void invalidSubmittedInput;
void invalidCompleteToolArguments;
void invalidEmptyQuestionPrompt;
void invalidSingleSelection;
void exhaustiveSchemas;
void invalidSilentStructuredOutput;
void invalidPresentStructuredOutput;
void invalidUnboundStructuredOutcome;
void approvalExpiredError;
void telemetrySnapshot;

if (false) {
  const differentProviderEvidence = createProviderEventEvidence({ providerId: "different-provider" });
  const differentProviderStart = createProviderOperation({
    providerId: "different-provider",
    operation: "start",
    eventEvidence: differentProviderEvidence,
    errorNormalization: testNormalization,
    execute: async () => success(null),
  });
  // @ts-expect-error Core slots bind the adapter provider identity.
  const invalidStartSlot: ProviderCapabilityOperation<
    "anthropic",
    "start",
    StartSessionRequest,
    unknown
  > = differentProviderStart;
  const anthropicSend = createProviderOperation({
    providerId: "anthropic",
    operation: "send",
    eventEvidence: anthropicEventEvidence,
    errorNormalization: testNormalization,
    execute: async () => success(null),
  });
  // @ts-expect-error A send operation cannot occupy the same-provider start slot.
  const invalidOperationSlot: ProviderCapabilityOperation<
    "anthropic",
    "start",
    StartSessionRequest,
    unknown
  > = anthropicSend;
  void invalidStartSlot;
  void invalidOperationSlot;
}

describe("provider operation boundary", () => {
  const hostileEventEvidence = createProviderEventEvidence({ providerId: "hostile" });
  const normalization = {
    normalize: ({ context }: { context: { providerId: string; requestId?: string } }) => ({
      code: "provider_failure" as const,
      providerId: context.providerId,
      requestId: context.requestId,
      message: "Provider execution failed.",
      retryable: false,
    }),
  };

  it("fulfills with a normalized Result for synchronous throws and rejected promises", async () => {
    const syncThrow = createProviderOperation<"hostile", "send", { requestId: string }, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      context: (request) => ({ requestId: request.requestId }),
      execute: () => {
        throw new Error("secret sync failure");
      },
    });
    const rejected = createProviderOperation<"hostile", "send", undefined, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => Promise.reject(new Error("secret async failure")),
    });

    await expect(syncThrow.execute({ requestId: "request-hostile" })).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "provider_failure",
        providerId: "hostile",
        requestId: "request-hostile",
      },
    });
    await expect(rejected.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it("contains failures from a hostile normalizer or invalid provider Result", async () => {
    const brokenNormalizer = createProviderOperation<"hostile", "send", undefined, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: {
        normalize: () => {
          throw new Error("normalizer failed");
        },
      },
      execute: () => {
        throw new Error("provider failed");
      },
    });
    const malformedResult = createProviderOperation<"hostile", "send", undefined, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({ leaked: true }) as unknown as ProviderAdapterResult<never>,
    });
    const malformedStableError = createProviderOperation<"hostile", "send", undefined, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () =>
        ({
          kind: "error",
          fallbackDecisions: [],
          error: {
            code: "deadline_exceeded",
            providerId: "hostile",
            message: "Missing required deadline metadata.",
            retryable: true,
          },
        }) as unknown as ProviderAdapterResult<never>,
    });

    await expect(brokenNormalizer.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal", providerId: "hostile", retryable: false },
    });
    await expect(malformedResult.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
    await expect(malformedStableError.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it("fulfills when hostile event-evidence identity access throws", async () => {
    const eventEvidence = Object.defineProperty({}, "providerId", {
      enumerable: true,
      get() {
        throw new Error("hostile evidence getter");
      },
    }) as unknown as typeof hostileEventEvidence;
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence,
      errorNormalization: normalization,
      execute: async () => success({ interrupted: true, turnId: "turn-1", target: interruptRequest.target }),
    });

    await expect(operation.execute(interruptRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it.each([
    {
      name: "omitted request id",
      error: {
        code: "provider_failure" as const,
        providerId: "hostile",
        message: "Unbound failure.",
        retryable: false,
      },
    },
    {
      name: "different request id",
      error: {
        code: "provider_failure" as const,
        providerId: "hostile",
        requestId: "request-other",
        message: "Misbinding failure.",
        retryable: false,
      },
    },
    {
      name: "different deadline",
      error: {
        code: "deadline_exceeded" as const,
        providerId: "hostile",
        requestId: "request-bound",
        message: "Misbinding deadline.",
        retryable: true,
        deadlineAt: 2_001,
      },
    },
  ])("rejects a provider error with a $name binding", async ({ error }) => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({ kind: "error" as const, error, fallbackDecisions: [] }),
    } as Parameters<typeof createProviderOperation>[0]);

    await expect(
      operation.execute({ ...interruptRequest, requestId: "request-bound", deadlineAt: 2_000 }),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", requestId: "request-bound" },
    });
  });

  it("replaces a normalized error whose identity differs from the immutable request", async () => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: {
        normalize: () => ({
          code: "deadline_exceeded" as const,
          providerId: "hostile",
          requestId: "request-other",
          message: "Wrong request and deadline.",
          retryable: true as const,
          deadlineAt: 2_001,
        }),
      },
      execute: async () => Promise.reject(new Error("provider rejected")),
    });

    await expect(
      operation.execute({ ...interruptRequest, requestId: "request-bound", deadlineAt: 2_000 }),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal", requestId: "request-bound" },
    });
  });

  it("accepts a provider error bound exactly to immutable derived context", async () => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      context: () => ({ requestId: "request-derived", deadlineAt: 2_000 }),
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code: "deadline_exceeded" as const,
          providerId: "hostile",
          requestId: "request-derived",
          message: "Derived context deadline.",
          retryable: true as const,
          deadlineAt: 2_000,
        },
      }),
    });

    await expect(operation.execute(interruptRequest)).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "deadline_exceeded",
        requestId: "request-derived",
        deadlineAt: 2_000,
        message: "Derived context deadline.",
      },
    });
  });

  it.each([
    { operation: "discover_providers", request: {}, value: "not providers" },
    { operation: "resolve_adapter", request: { providerId: "hostile" }, value: null },
    { operation: "discover_accounts", request: {}, value: "not accounts" },
    { operation: "discover_models", request: {}, value: null },
    { operation: "submit_tool_result", request: submitToolResultRequest, value: null },
    { operation: "interrupt", request: interruptRequest, value: null },
    {
      operation: "respond_to_approval",
      request: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        choiceId: "choice-1",
        action: "approve",
      },
      value: null,
    },
    {
      operation: "respond_to_user_input",
      request: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        inputId: "input-1",
        action: "cancel",
      },
      value: null,
    },
  ] as const)("fails closed for malformed $operation success", async ({ operation, request, value }) => {
    const providerOperation = createProviderOperation({
      providerId: "hostile",
      operation,
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => success(value),
    });

    await expect(providerOperation.execute(request)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it("requires an extension result validator before accepting an extension success", async () => {
    const withoutValidator = createProviderOperation({
      providerId: "hostile",
      operation: "extension:quota",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => success({ remaining: 4 }),
    });
    const withValidator = createProviderOperation({
      providerId: "hostile",
      operation: "extension:quota",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      resultValidator: (value: unknown): value is { readonly remaining: number } =>
        typeof value === "object" &&
        value !== null &&
        Reflect.ownKeys(value).length === 1 &&
        typeof (value as { remaining?: unknown }).remaining === "number",
      execute: async () => success({ remaining: 4 }),
    });

    await expect(withoutValidator.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
    await expect(withValidator.execute(undefined)).resolves.toMatchObject({
      kind: "success",
      value: { remaining: 4 },
    });
  });

  it("rejects extra nested authority fields in a core success", async () => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "start",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          session: {
            sessionId: "session-1",
            threadId: "thread-1",
            providerId: "anthropic",
            accountId: "acct-work",
          },
          target: {
            kind: "exact" as const,
            target: { ...startRequest.target, hiddenProviderOverride: "hostile" },
          },
        }),
    });

    await expect(operation.execute(startRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("rejects extra fields on a target resolution", async () => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "start",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          session: {
            sessionId: "session-1",
            threadId: "thread-1",
            providerId: "anthropic",
            accountId: "acct-work",
            modelId: "claude-sonnet",
          },
          target: {
            kind: "exact" as const,
            target: startRequest.target,
            hiddenDecision: "provider-owned",
          },
        }),
    });

    await expect(operation.execute(startRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("binds an existing-turn send result to the requested turn", async () => {
    const request = { ...sendRequest, turn: { kind: "existing" as const, turnId: "turn-requested" } };
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "send",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          messageId: "message-1",
          turnId: "turn-other",
          target: { kind: "exact" as const, target: request.target },
          structuredOutput: {
            state: "present" as const,
            request: structuredOutputIdentity,
            result: structuredOutputResult,
          },
        }),
    });

    await expect(operation.execute(request)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("binds a resumed session result to the requested session and thread", async () => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "resume",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          session: {
            sessionId: "session-other",
            threadId: "thread-other",
            providerId: "anthropic",
            accountId: "acct-work",
            modelId: "claude-sonnet",
          },
          target: { kind: "exact" as const, target: resumeRequest.target },
        }),
    });

    await expect(operation.execute(resumeRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("returns a detached frozen discovery result", async () => {
    const account = {
      accountId: "acct-1",
      providerId: "hostile",
      displayName: "Original",
      authentication: { state: "valid", method: "oauth", mode: "interactive" },
      capabilityReadiness: [{ operation: "send", state: "ready" }],
    } satisfies AccountDescriptor;
    const raw = { kind: "success" as const, value: [account], fallbackDecisions: [] };
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "discover_accounts",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => raw,
    });

    const result = await operation.execute({});
    account.displayName = "Mutated";
    (account.capabilityReadiness[0] as { operation: ProviderOperationName }).operation = "interrupt";

    expect(result).not.toBe(raw);
    expect(result).toMatchObject({
      kind: "success",
      value: [{ displayName: "Original", capabilityReadiness: [{ operation: "send" }] }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === "success") {
      expect(result.value).not.toBe(raw.value);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value[0])).toBe(true);
    }
  });

  it("returns a detached frozen normalized error", async () => {
    const normalizedError = {
      code: "provider_failure" as const,
      providerId: "hostile",
      message: "Original failure",
      retryable: false,
    };
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: { normalize: () => normalizedError },
      execute: () => {
        throw new Error("provider failed");
      },
    });

    const result = await operation.execute(interruptRequest);
    normalizedError.message = "Mutated failure";

    expect(result).toMatchObject({
      kind: "error",
      error: { message: "Original failure" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === "error") expect(Object.isFrozen(result.error)).toBe(true);
  });

  it("detaches a validated fallback decision while retaining its visible-event proof", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const decision = {
      ...visibleFallback,
      policy: { ...visibleFallback.policy, scopes: [...visibleFallback.policy.scopes] },
      confirmation: { ...visibleFallback.confirmation },
      requested: { ...visibleFallback.requested },
      resolved: { ...visibleFallback.resolved },
      notice: { ...visibleFallback.notice },
    } satisfies FallbackDecision;
    const resolution = {
      kind: "fallback" as const,
      requested: decision.requested,
      resolved: decision.resolved,
      decision,
    };
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { ...fallbackEvent, decision };
        },
      },
      close: async () => undefined,
    });
    await stream[Symbol.asyncIterator]().next();
    const raw = {
      kind: "success" as const,
      value: {
        session: {
          sessionId: "session-2",
          threadId: "thread-2",
          providerId: "anthropic",
          accountId: "acct-personal",
          modelId: "claude-sonnet",
        },
        target: resolution,
      },
      fallbackDecisions: [decision],
    };
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "start",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => raw,
    });

    const result = await operation.execute({
      target: decision.requested,
      fallback: decision.policy,
      execution: { tools: [] },
    });
    (decision.notice as { title: string }).title = "Mutated";

    expect(result).not.toBe(raw);
    expect(result).toMatchObject({
      kind: "success",
      fallbackDecisions: [{ notice: { title: "Switched account" } }],
    });
    if (result.kind === "success") {
      expect(result.fallbackDecisions[0]).toBe(result.value.target.decision);
      expect(Object.isFrozen(result.fallbackDecisions[0]?.notice)).toBe(true);
    }
  });

  it("rejects a normalized unavailable error for a different operation", async () => {
    const operation = createProviderOperation<"hostile", "send", undefined, never>({
      providerId: "hostile",
      operation: "send",
      eventEvidence: hostileEventEvidence,
      errorNormalization: {
        normalize: () => ({
          code: "operation_unavailable" as const,
          providerId: "hostile",
          message: "Resume is unavailable.",
          retryable: false as const,
          operation: "resume" as const,
          availability: { state: "unavailable" as const, reason: "not_supported_by_provider" as const },
        }),
      },
      execute: () => {
        throw new Error("send failed");
      },
    });

    await expect(operation.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal", providerId: "hostile" },
    });
  });

  it("snapshots every authority-bearing supported-operation option before getters drift", async () => {
    const providerPEvidence = createProviderEventEvidence({ providerId: "p" });
    const providerQEvidence = createProviderEventEvidence({ providerId: "q" });
    const reads = new Map<PropertyKey, number>();
    let construction = true;
    const options = new Proxy(
      {
        providerId: "p",
        operation: "send" as const,
        availability: { state: "available" as const, limitations: ["p-limit"] },
        eventEvidence: providerPEvidence,
        errorNormalization: normalization,
        context: () => ({ requestId: "request-p" }),
        execute: async () => {
          throw new Error("provider p failed");
        },
      },
      {
        get(target, property, receiver) {
          reads.set(property, (reads.get(property) ?? 0) + 1);
          if (construction) return Reflect.get(target, property, receiver);
          if (property === "providerId") return "q";
          if (property === "operation") return "interrupt";
          if (property === "availability") {
            return { state: "available", limitations: ["q-limit"] };
          }
          if (property === "eventEvidence") return providerQEvidence;
          if (property === "errorNormalization") return testNormalization;
          if (property === "context") return () => ({ requestId: "request-q" });
          if (property === "execute") {
            return async () => {
              throw new Error("provider q failed");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const operation = createProviderOperation(options);
    construction = false;

    await expect(operation.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "provider_failure",
        providerId: "p",
        requestId: "request-p",
      },
    });
    expect(operation).toMatchObject({
      providerId: "p",
      capability: {
        operation: "send",
        availability: { state: "available", limitations: ["p-limit"] },
      },
    });
    expect(
      [
        "providerId",
        "operation",
        "availability",
        "eventEvidence",
        "errorNormalization",
        "context",
        "execute",
      ].map((key) => reads.get(key)),
    ).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("validates and exposes the same detached limitations snapshot", () => {
    let firstItemReads = 0;
    const limitations = new Proxy(["stable"], {
      get(target, property, receiver) {
        if (property === "0") {
          firstItemReads += 1;
          return firstItemReads === 1 ? "stable" : { invalid: true };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as string[];
    const operation = createProviderOperation({
      providerId: "p",
      operation: "send",
      availability: { state: "available", limitations },
      eventEvidence: createProviderEventEvidence({ providerId: "p" }),
      errorNormalization: normalization,
      execute: async () => success(undefined),
    });

    expect(operation.capability.availability.limitations).toEqual(["stable"]);
    expect(firstItemReads).toBe(1);
  });

  it("accepts 64 limitations and rejects 65 before reading any item", () => {
    const proxiedLimitations = (count: number) => {
      let itemReads = 0;
      const values = new Proxy([], {
        get(target, property, receiver) {
          if (property === "length") return count;
          if (typeof property === "string" && /^\d+$/.test(property)) {
            itemReads += 1;
            return `limit-${property}`;
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as string[];
      return { values, itemReads: () => itemReads };
    };
    const build = (limitations: string[]) =>
      createProviderOperation({
        providerId: "p",
        operation: "send",
        availability: { state: "available", limitations },
        eventEvidence: createProviderEventEvidence({ providerId: "p" }),
        errorNormalization: normalization,
        execute: async () => success(undefined),
      });
    const atCap = proxiedLimitations(64);
    const operation = build(atCap.values);
    const overCap = proxiedLimitations(65);
    let overCapRejected = false;
    try {
      build(overCap.values);
    } catch (cause) {
      overCapRejected = cause instanceof TypeError;
    }

    expect(operation.capability.availability.limitations).toHaveLength(64);
    expect(atCap.itemReads()).toBe(64);
    expect({ rejected: overCapRejected, itemReads: overCap.itemReads() }).toEqual({
      rejected: true,
      itemReads: 0,
    });
  });

  it.each([
    { name: "512 UTF-16 units", limitation: "x".repeat(512), accepted: true },
    { name: "ordinary Unicode", limitation: "résumé ready", accepted: true },
    { name: "emoji", limitation: "supports images 🖼️", accepted: true },
    { name: "513 UTF-16 units", limitation: "x".repeat(513), accepted: false },
    { name: "empty", limitation: "", accepted: false },
    { name: "control characters", limitation: "unsafe\nlabel", accepted: false },
    { name: "zero-width space", limitation: "\u200b", accepted: false },
    { name: "embedded bidi override", limitation: "safe\u202eevil", accepted: false },
    { name: "line separator", limitation: "first\u2028second", accepted: false },
    { name: "paragraph separator", limitation: "first\u2029second", accepted: false },
    { name: "bidi embedding control", limitation: "safe\u202aunsafe", accepted: false },
    { name: "bidi isolate control", limitation: "safe\u2066unsafe", accepted: false },
  ])("enforces the display-safe limitation bound for $name", ({ limitation, accepted }) => {
    const build = () =>
      createProviderOperation({
        providerId: "p",
        operation: "send",
        availability: { state: "available", limitations: [limitation] },
        eventEvidence: createProviderEventEvidence({ providerId: "p" }),
        errorNormalization: normalization,
        execute: async () => success(undefined),
      });

    if (accepted) {
      expect(build().capability.availability.limitations).toEqual([limitation]);
    } else {
      expect(build).toThrow(TypeError);
    }
  });

  it("snapshots every unavailable-operation option before getters drift", async () => {
    const reads = new Map<PropertyKey, number>();
    let construction = true;
    const options = new Proxy(
      {
        providerId: "p",
        operation: "send" as const,
        availability: {
          state: "unavailable" as const,
          reason: "not_available_for_model" as const,
          message: "p availability",
        },
        message: "p unavailable",
      },
      {
        get(target, property, receiver) {
          reads.set(property, (reads.get(property) ?? 0) + 1);
          if (construction) return Reflect.get(target, property, receiver);
          if (property === "providerId") return "q";
          if (property === "operation") return "interrupt";
          if (property === "availability") {
            return { state: "unavailable", reason: "disabled_by_policy", message: "q availability" };
          }
          if (property === "message") return "q unavailable";
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const operation = createUnavailableProviderOperation(options);
    construction = false;

    await expect(operation.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "operation_unavailable",
        providerId: "p",
        operation: "send",
        message: "p unavailable",
        availability: {
          state: "unavailable",
          reason: "not_available_for_model",
          message: "p availability",
        },
      },
    });
    expect(
      ["providerId", "operation", "availability", "message"].map((key) => reads.get(key)),
    ).toEqual([1, 1, 1, 1]);
  });

  it.each([{ method: "assignment" as const }, { method: "defineProperty" as const }])(
    "freezes a supported operation against $method mutation",
    async ({ method }) => {
      const eventEvidence = createProviderEventEvidence({ providerId: "p" });
      const operation = createProviderOperation({
        providerId: "p",
        operation: "send",
        availability: { state: "available", limitations: ["original"] },
        eventEvidence,
        errorNormalization: normalization,
        execute: async () => {
          throw new Error("original provider failed");
        },
      });
      const mutable = operation as unknown as {
        providerId: string;
        capability: { operation: string; availability: unknown };
      };
      const mutations = [
        () => {
          if (method === "assignment") mutable.providerId = "q";
          else Object.defineProperty(mutable, "providerId", { value: "q" });
        },
        () => {
          if (method === "assignment") mutable.capability.operation = "interrupt";
          else Object.defineProperty(mutable.capability, "operation", { value: "interrupt" });
        },
        () => {
          const replacement = { state: "available", limitations: ["mutated"] };
          if (method === "assignment") mutable.capability.availability = replacement;
          else Object.defineProperty(mutable.capability, "availability", { value: replacement });
        },
      ];

      expect(
        mutations.map((mutate) => {
          try {
            mutate();
            return false;
          } catch (cause) {
            return cause instanceof TypeError;
          }
        }),
      ).toEqual([true, true, true]);
      expect(operation).toMatchObject({
        providerId: "p",
        capability: { operation: "send", availability: { limitations: ["original"] } },
      });
      await expect(operation.execute(undefined)).resolves.toMatchObject({
        kind: "error",
        error: { providerId: "p", code: "provider_failure" },
      });
    },
  );

  it.each([{ method: "assignment" as const }, { method: "defineProperty" as const }])(
    "freezes an unavailable operation against $method mutation",
    async ({ method }) => {
      const operation = createUnavailableProviderOperation({
        providerId: "p",
        operation: "send",
        availability: { state: "unavailable", reason: "not_available_for_model" },
        message: "original unavailable",
      });
      const mutable = operation as unknown as {
        providerId: string;
        capability: { operation: string; availability: unknown };
      };
      const mutations = [
        () => {
          if (method === "assignment") mutable.providerId = "q";
          else Object.defineProperty(mutable, "providerId", { value: "q" });
        },
        () => {
          if (method === "assignment") mutable.capability.operation = "interrupt";
          else Object.defineProperty(mutable.capability, "operation", { value: "interrupt" });
        },
        () => {
          const replacement = { state: "unavailable", reason: "disabled_by_policy" };
          if (method === "assignment") mutable.capability.availability = replacement;
          else Object.defineProperty(mutable.capability, "availability", { value: replacement });
        },
      ];

      expect(
        mutations.map((mutate) => {
          try {
            mutate();
            return false;
          } catch (cause) {
            return cause instanceof TypeError;
          }
        }),
      ).toEqual([true, true, true]);
      await expect(operation.execute(undefined)).resolves.toMatchObject({
        kind: "error",
        error: {
          providerId: "p",
          operation: "send",
          message: "original unavailable",
          availability: { reason: "not_available_for_model" },
        },
      });
    },
  );

  it("contains event iteration and stream-close failures behind the same Result boundary", async () => {
    const stream = createProviderEventStream({
      providerId: "hostile",
      accountId: "account-1",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session",
            eventId: "hostile-session-event",
            sequence: 0,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "hostile",
              accountId: "account-1",
            },
            phase: "ready",
          } satisfies ProviderEvent;
          throw new Error("stream transport leaked");
        },
      },
      close: async () => Promise.reject(new Error("close leaked")),
    });
    const observed: ProviderAdapterResult<ProviderEvent>[] = [];

    for await (const event of stream) observed.push(event);

    expect(observed.map((event) => event.kind)).toEqual(["success", "error"]);
    expect(observed[1]).toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
    await expect(stream.close()).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it("keeps stream normalization context immutable across iteration and close", async () => {
    const observedContexts: Array<{ readonly frozen: boolean; readonly operation: string }> = [];
    const mutatingNormalization = {
      normalize: ({ context }: { context: { providerId: string; operation: string } }) => {
        observedContexts.push({
          frozen: Object.isFrozen(context),
          operation: context.operation,
        });
        Reflect.set(context, "operation", "send");
        return {
          code: "provider_failure" as const,
          providerId: context.providerId,
          message: "The stream boundary failed.",
          retryable: false,
        };
      },
    };
    const stream = createProviderEventStream({
      providerId: "hostile",
      accountId: "account-1",
      eventEvidence: hostileEventEvidence,
      errorNormalization: mutatingNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          throw new Error("iteration failed");
        },
      },
      close: async () => Promise.reject(new Error("close failed")),
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "provider_failure" } },
    });
    await expect(stream.close()).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
    expect(observedContexts).toEqual([
      { frozen: true, operation: "events" },
      { frozen: true, operation: "events" },
    ]);
  });

  it("accepts fallback success only after the same decision was emitted with confirmation evidence", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const decision = {
      ...visibleFallback,
      policy: { ...visibleFallback.policy, confirmation: "always" as const },
      confirmation: {
        kind: "user_confirmed" as const,
        confirmationId: "fallback-confirmation-1",
        confirmedAt: 1,
        confirmedBy: "user" as const,
      },
    };
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            ...fallbackEvent,
            decision,
          } satisfies ProviderEvent;
        },
      },
      close: async () => undefined,
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "start",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => ({
        kind: "success",
        value: {
          session: {
            sessionId: "session-fallback",
            threadId: "thread-fallback",
            providerId: "anthropic",
            accountId: "acct-personal",
            modelId: "claude-sonnet",
          },
          target: {
            kind: "fallback",
            requested: decision.requested,
            resolved: decision.resolved,
            decision,
          },
        },
        fallbackDecisions: [decision],
      }),
    });
    const fallbackStartRequest = {
      ...startRequest,
      target: decision.requested,
      fallback: decision.policy,
    };

    await expect(operation.execute(fallbackStartRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
    await stream[Symbol.asyncIterator]().next();
    await expect(operation.execute(fallbackStartRequest)).resolves.toMatchObject({
      kind: "success",
      fallbackDecisions: [{ decisionId: "fallback-1" }],
    });

    const inconsistentTarget = createProviderOperation({
      providerId: "anthropic",
      operation: "start",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => ({
        kind: "success",
        value: {
          session: {
            sessionId: "session-fallback",
            threadId: "thread-fallback",
            providerId: "anthropic",
            accountId: "acct-personal",
          },
          target: {
            kind: "fallback",
            requested: decision.requested,
            resolved: { ...decision.resolved, accountId: "acct-not-recorded" },
            decision,
          },
        },
        fallbackDecisions: [decision],
      }),
    });
    await expect(inconsistentTarget.execute(fallbackStartRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("rejects closed-algebra errors with unknown operation or unavailable reason", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "hostile" });
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "send",
      eventEvidence,
      errorNormalization: normalization,
      execute: async () =>
        ({
          kind: "error",
          fallbackDecisions: [],
          error: {
            code: "operation_unavailable",
            providerId: "hostile",
            message: "Unknown operation and reason.",
            retryable: false,
            operation: "unknown_operation",
            availability: { state: "unavailable", reason: "unknown_reason" },
          },
        }) as unknown as ProviderAdapterResult<never>,
    });

    await expect(operation.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", providerId: "hostile" },
    });
  });

  it("rejects malformed event payloads instead of yielding them", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            ...fallbackEvent,
            eventId: "different-from-visible-id",
          } as ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it.each([
    { name: "provider", session: { providerId: "openai" } },
    { name: "session", session: { sessionId: "session-other" } },
    { name: "thread", session: { threadId: "thread-other" } },
    { name: "turn", turnId: "turn-other" },
  ])("rejects an event whose $name identity differs from its stream context", async (change) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session",
            eventId: `wrong-${change.name}`,
            sequence: 0,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
              ...change.session,
            },
            turnId: change.turnId ?? "turn-1",
            phase: "ready",
          } as ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it("binds the resume cursor and rejects its exact event replay", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        afterEventId: "event-1",
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session",
            eventId: "event-1",
            sequence: 7,
            occurredAt: 7,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
            },
            turnId: "turn-1",
            phase: "running",
          } satisfies ProviderEvent;
        },
      },
      close: async () => undefined,
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(stream),
    });

    await expect(
      operation.execute({
        accountId: "acct-work",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        afterEventId: "different-cursor",
      }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it.each([
    { name: "event id", secondEventId: "event-1", secondSequence: 8 },
    { name: "sequence", secondEventId: "event-2", secondSequence: 7 },
  ])("rejects a non-monotonic repeated $name", async ({ secondEventId, secondSequence }) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const baseEvent = {
      type: "session" as const,
      eventId: "event-1",
      sequence: 7,
      occurredAt: 7,
      session: {
        sessionId: "session-1",
        threadId: "thread-1",
        providerId: "anthropic",
        accountId: "acct-work",
      },
      turnId: "turn-1",
      phase: "running" as const,
    };
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield baseEvent;
          yield { ...baseEvent, eventId: secondEventId, sequence: secondSequence };
        },
      },
      close: async () => undefined,
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "success", value: { eventId: "event-1", sequence: 7 } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it("rejects replay when the same stream is iterated again", async () => {
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: createProviderEventEvidence({ providerId: "anthropic" }),
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session",
            eventId: "event-1",
            sequence: 7,
            occurredAt: 7,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
            },
            phase: "running",
          } satisfies ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "success", value: { eventId: "event-1" } },
    });
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it.each([
    { name: "missing", context: {} },
    {
      name: "wrong session",
      context: { sessionId: "session-other", threadId: "thread-1", turnId: "turn-1" },
    },
    {
      name: "wrong thread",
      context: { sessionId: "session-1", threadId: "thread-other", turnId: "turn-1" },
    },
    {
      name: "wrong turn",
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-other" },
    },
  ])("rejects an events operation stream with $name subscription identity", async ({ context }) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success(
          createProviderEventStream({
            providerId: "anthropic",
            accountId: "acct-work",
            eventEvidence,
            errorNormalization: testNormalization,
            context: context as unknown as ProviderEventStreamContext,
            events: {
              async *[Symbol.asyncIterator]() {
                // Empty streams still have to prove which subscription they represent.
              },
            },
            close: async () => undefined,
          }),
        ),
    });

    await expect(
      operation.execute({ accountId: "acct-work", sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it.each([{ method: "assignment" as const }, { method: "defineProperty" as const }])(
    "prevents stream context divergence through $method",
    async ({ method }) => {
      const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
      const stream = createProviderEventStream({
        providerId: "anthropic",
        accountId: "acct-work",
        eventEvidence,
        errorNormalization: testNormalization,
        context: { sessionId: "session-wrong", threadId: "thread-wrong", turnId: null },
        events: {
          async *[Symbol.asyncIterator]() {
            // The operation boundary must reject before this wrong-context stream is consumed.
          },
        },
        close: async () => undefined,
      });
      const requestedContext = {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: null,
      } satisfies ProviderEventStreamContext;
      let mutationFailed = false;
      try {
        if (method === "assignment") {
          (stream as { context: ProviderEventStreamContext }).context = requestedContext;
        } else {
          Object.defineProperty(stream, "context", { value: requestedContext });
        }
      } catch (cause) {
        mutationFailed = cause instanceof TypeError;
      }
      const operation = createProviderOperation({
        providerId: "anthropic",
        operation: "events",
        eventEvidence,
        errorNormalization: testNormalization,
        execute: async () => success(stream),
      });

      const result = await operation.execute({
        accountId: "acct-work",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: null,
      });

      expect(mutationFailed).toBe(true);
      expect(result).toMatchObject({ kind: "error", error: { code: "internal" } });
    },
  );

  it("rejects a proxy that projects a different stream context", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-wrong", threadId: "thread-wrong", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          // Empty: the escape is whether the proxy passes operation validation.
        },
      },
      close: async () => undefined,
    });
    const projected = new Proxy(stream, {
      get(target, property, receiver) {
        if (property === "context") {
          return { sessionId: "session-1", threadId: "thread-1", turnId: null };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(projected),
    });

    await expect(
      operation.execute({ accountId: "acct-work", sessionId: "session-1", threadId: "thread-1", turnId: null }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it("rejects a facade proxy that synthesizes the stream brand and request identity", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const wrongStream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-wrong", threadId: "thread-wrong", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          // The facade delegates iteration to this genuine but wrong-context stream.
        },
      },
      close: async () => undefined,
    });
    const facade = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "providerId") return "anthropic";
          if (property === "context") {
            return { sessionId: "session-1", threadId: "thread-1", turnId: null };
          }
          if (property === "close") return wrongStream.close;
          if (property === Symbol.asyncIterator) {
            return wrongStream[Symbol.asyncIterator].bind(wrongStream);
          }
          if (typeof property === "symbol") return true;
          return undefined;
        },
      },
    ) as unknown as typeof wrongStream;
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(facade),
    });

    await expect(
      operation.execute({ accountId: "acct-work", sessionId: "session-1", threadId: "thread-1", turnId: null }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it("snapshots the stream provider before a hostile options getter can drift", async () => {
    const providerPEvidence = createProviderEventEvidence({ providerId: "p" });
    let providerReads = 0;
    let currentProvider = "p";
    const options = new Proxy(
      {
        providerId: "p",
        accountId: "acct-q",
        eventEvidence: providerPEvidence,
        errorNormalization: testNormalization,
        context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "session",
              eventId: "event-provider-q",
              sequence: 0,
              occurredAt: 1,
              session: {
                sessionId: "session-1",
                threadId: "thread-1",
                providerId: "q",
                accountId: "acct-q",
              },
              phase: "ready",
            } satisfies ProviderEvent;
          },
        },
        close: async () => undefined,
      },
      {
        get(target, property, receiver) {
          if (property === "providerId") {
            providerReads += 1;
            return currentProvider;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const stream = createProviderEventStream(options);
    currentProvider = "q";
    const operation = createProviderOperation({
      providerId: "p",
      operation: "events",
      eventEvidence: providerPEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(stream),
    });

    await expect(
      operation.execute({ accountId: "acct-q", sessionId: "session-1", threadId: "thread-1", turnId: null }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { providerId: "p" } },
    });
    expect(providerReads).toBe(1);
  });

  it.each([
    {
      name: "result schema name",
      outcome: {
        state: "present" as const,
        request: structuredOutputIdentity,
        result: { ...structuredOutputResult, schemaName: "different_schema" },
      },
    },
    {
      name: "schema hash",
      outcome: {
        state: "present" as const,
        request: { ...structuredOutputIdentity, schemaHash: "sha256:different-schema" },
        result: structuredOutputResult,
      },
    },
    {
      name: "strict configuration",
      outcome: {
        state: "present" as const,
        request: { ...structuredOutputIdentity, strict: false },
        result: structuredOutputResult,
      },
    },
  ])("rejects a structured result with mismatched $name", async ({ outcome }) => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "send",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          messageId: "message-wrong-schema",
          turnId: "turn-1",
          target: { kind: "exact", target: sendRequest.target },
          structuredOutput: outcome,
        }),
    });

    await expect(operation.execute(sendRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each([
    {
      name: "session phase",
      event: { type: "session", phase: "unknown_phase" },
    },
    {
      name: "assistant message outcome",
      event: {
        type: "message",
        message: {
          messageId: "message-invalid",
          turnId: "turn-1",
          role: "assistant",
          blocks: [],
          state: "completed",
        },
      },
    },
    {
      name: "approval subject",
      event: {
        type: "approval_request",
        approval: {
          approvalId: "approval-invalid",
          title: "Invalid",
          message: "Missing command payload.",
          expiresAt: null,
          subject: { kind: "command" },
          choices: approvalChoices,
        },
      },
    },
    {
      name: "tool identity",
      event: {
        type: "tool",
        state: "started",
        definition: toolDefinition,
        call: { ...toolCall, toolName: "different-tool" },
      },
    },
    {
      name: "user input questions",
      event: {
        type: "user_input_request",
        input: { inputId: "input-invalid", title: "Invalid", expiresAt: null, allowCancel: true, questions: [] },
      },
    },
    {
      name: "usage provenance",
      event: {
        type: "usage",
        usage: {
          scope: "session",
          identity: { sessionId: "session-1", threadId: "thread-1" },
          totalTokens: 1,
          provenance: { kind: "provider-reported", authoritative: false, reportedAt: 1 },
        },
      },
    },
    {
      name: "authentication method",
      event: {
        type: "authentication",
        authentication: { state: "valid", method: "invented", mode: "interactive" },
      },
    },
    {
      name: "rate-limit provenance",
      event: {
        type: "rate_limit",
        rateLimit: {
          state: "within_limit",
          windows: [
            {
              windowId: "invalid-window",
              dimension: "invented",
              window: { kind: "rolling" },
              provenance: { kind: "provider-response", authoritative: false, capturedAt: 1 },
            },
          ],
        },
      },
    },
    {
      name: "context counters",
      event: {
        type: "context_limit",
        context: { state: "within_limit", usedTokens: "many" },
      },
    },
    {
      name: "cancellation scope",
      event: { type: "cancelled", cancellationScope: "workspace" },
    },
    {
      name: "error algebra",
      event: {
        type: "error",
        error: {
          code: "operation_unavailable",
          providerId: "anthropic",
          message: "Invalid reason.",
          retryable: false,
          operation: "not-an-operation",
          availability: { state: "unavailable", reason: "not-a-reason" },
        },
      },
    },
  ])("rejects malformed $name event payload", async ({ event }) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            eventId: `invalid-${event.type}`,
            sequence: 1,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
            },
            turnId: "turn-1",
            ...event,
          } as unknown as ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it("rejects telemetry success that omits a requested kind", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "poll_telemetry",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          providerId: "anthropic",
          accountId: null,
          sessionId: null,
          threadId: null,
          capturedAt: 1,
          results: [],
          response: { receivedAt: 1 },
        } as unknown as ProviderTelemetrySnapshot),
    });

    await expect(
      operation.execute({ accountId: null, sessionId: null, threadId: null, kinds: ["rate_limits"] }),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("rejects an unavailable telemetry result without matching availability state", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "poll_telemetry",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          providerId: "anthropic",
          accountId: null,
          sessionId: null,
          threadId: null,
          capturedAt: 1,
          results: [
            {
              kind: "rate_limits",
              state: "unavailable",
              availability: { reason: "not_supported_by_provider" },
              value: { state: "within_limit", windows: [] },
            },
          ],
          response: { receivedAt: 1 },
        } as unknown as ProviderTelemetrySnapshot),
    });

    await expect(
      operation.execute({ accountId: null, sessionId: null, threadId: null, kinds: ["rate_limits"] }),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each([
    {
      name: "account",
      request: { accountId: "acct-requested", sessionId: "session-1", threadId: "thread-1" },
      snapshot: { accountId: "acct-other", sessionId: "session-1", threadId: "thread-1" },
    },
    {
      name: "session",
      request: { accountId: "acct-work", sessionId: "session-requested", threadId: "thread-1" },
      snapshot: { accountId: "acct-work", sessionId: "session-other", threadId: "thread-1" },
    },
    {
      name: "explicit null",
      request: { accountId: null, sessionId: null, threadId: null },
      snapshot: {},
    },
  ])("rejects telemetry whose $name identity differs from its request", async ({ request, snapshot }) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "poll_telemetry",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          providerId: "anthropic",
          ...snapshot,
          capturedAt: 1,
          results: [
            { kind: "rate_limits", state: "value", value: { state: "within_limit", windows: [] } },
          ],
          response: { receivedAt: 1 },
        } as unknown as ProviderTelemetrySnapshot),
    });

    await expect(operation.execute({ ...request, kinds: ["rate_limits"] })).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each(["interrupt", "send", "resume"] as const)(
    "validates %s success against an immutable pre-execution request snapshot",
    async (operationName) => {
      let adapterSawFrozenRequest = false;
      let adapterSawFrozenIdentity = false;
      const request =
        operationName === "interrupt"
          ? {
              sessionId: "session-1",
              threadId: "thread-1",
              target: { kind: "turn" as const, turnId: "turn-original" },
            }
          : operationName === "send"
            ? {
                ...sendRequest,
                turn: { kind: "existing" as const, turnId: "turn-original" },
              }
            : {
                ...resumeRequest,
                sessionId: "session-original",
                threadId: "thread-original",
              };
      const operation = createProviderOperation({
        providerId: "anthropic",
        operation: operationName,
        eventEvidence: anthropicEventEvidence,
        errorNormalization: testNormalization,
        execute: async (adapterRequest: unknown) => {
          adapterSawFrozenRequest = Object.isFrozen(adapterRequest);
          if (operationName === "interrupt") {
            const interruptAdapterRequest = adapterRequest as {
              readonly target: { readonly kind: "turn"; readonly turnId: string };
            };
            adapterSawFrozenIdentity = Object.isFrozen(interruptAdapterRequest.target);
            try {
              (interruptAdapterRequest.target as { turnId: string }).turnId = "turn-mutated";
            } catch {
              // The adapter must not be able to rewrite validation evidence.
            }
            return success({
              interrupted: true,
              turnId: "turn-mutated",
              target: { kind: "turn" as const, turnId: "turn-mutated" },
            });
          }
          if (operationName === "send") {
            const sendAdapterRequest = adapterRequest as typeof sendRequest & {
              readonly turn: { readonly kind: "existing"; readonly turnId: string };
            };
            adapterSawFrozenIdentity = Object.isFrozen(sendAdapterRequest.turn);
            try {
              (sendAdapterRequest.turn as { turnId: string }).turnId = "turn-mutated";
            } catch {
              // The adapter must not be able to rewrite validation evidence.
            }
            return success({
              messageId: "message-mutated",
              turnId: "turn-mutated",
              target: { kind: "exact" as const, target: sendAdapterRequest.target },
              structuredOutput: {
                state: "present" as const,
                request: structuredOutputIdentity,
                result: structuredOutputResult,
              },
            });
          }
          const resumeAdapterRequest = adapterRequest as typeof resumeRequest;
          adapterSawFrozenIdentity = Object.isFrozen(adapterRequest);
          try {
            (adapterRequest as { sessionId: string }).sessionId = "session-mutated";
            (adapterRequest as { threadId: string }).threadId = "thread-mutated";
          } catch {
            // The adapter must not be able to rewrite validation evidence.
          }
          return success({
            session: {
              sessionId: "session-mutated",
              threadId: "thread-mutated",
              providerId: "anthropic",
              accountId: "acct-work",
              modelId: "claude-sonnet",
            },
            target: { kind: "exact" as const, target: resumeAdapterRequest.target },
          });
        },
      } as Parameters<typeof createProviderOperation>[0]);

      const result = await operation.execute(request as never);

      expect(result).toMatchObject({ kind: "error", error: { code: "internal" } });
      expect({ adapterSawFrozenRequest, adapterSawFrozenIdentity }).toEqual({
        adapterSawFrozenRequest: true,
        adapterSawFrozenIdentity: true,
      });
      if (operationName === "interrupt") {
        expect((request as { target: { turnId: string } }).target.turnId).toBe("turn-original");
      }
      if (operationName === "send") {
        expect((request as { turn: { turnId: string } }).turn.turnId).toBe("turn-original");
      }
      if (operationName === "resume") {
        expect(request).toMatchObject({
          sessionId: "session-original",
          threadId: "thread-original",
        });
      }
    },
  );

  it("returns an explicit successful Result when an event stream closes", async () => {
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: null,
        requestId: "request-close-1",
        deadlineAt: 50,
      },
      events: { async *[Symbol.asyncIterator]() {} },
      close: async () => undefined,
    });

    const result = await stream.close();

    expect(result).toEqual({ kind: "success", value: undefined, fallbackDecisions: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.fallbackDecisions)).toBe(true);
  });

  it("normalizes stream-close failure with the stream provider and request identity", async () => {
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "request-close-identity",
        deadlineAt: 50,
      },
      events: { async *[Symbol.asyncIterator]() {} },
      close: async () => Promise.reject(new Error("private close failure")),
    });

    await expect(stream.close()).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "internal",
        providerId: "anthropic",
        requestId: "request-close-identity",
      },
    });
  });

  it.each([
    { name: "request id", requestId: "request-other", deadlineAt: 50 },
    { name: "deadline", requestId: "request-events", deadlineAt: 51 },
  ])("rejects an event stream with a mismatched $name", async ({ requestId, deadlineAt }) => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "request-events",
        deadlineAt: 50,
      },
      events: { async *[Symbol.asyncIterator]() {} },
      close: async () => undefined,
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(stream),
    });

    await expect(
      operation.execute({
        accountId: "acct-work",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        requestId,
        deadlineAt,
      }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it("binds a returned event stream to the requested account", async () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-other",
      eventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: { async *[Symbol.asyncIterator]() {} },
      close: async () => undefined,
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(stream),
    });

    await expect(
      operation.execute({
        accountId: "acct-work",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: null,
      }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it("rejects a stream from a different same-provider event-evidence authority before iteration", async () => {
    const streamEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    const operationEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    let iterations = 0;
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: streamEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          iterations += 1;
        },
      },
      close: async () => undefined,
    });
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "events",
      eventEvidence: operationEvidence,
      errorNormalization: testNormalization,
      execute: async () => success(stream),
    });

    await expect(
      operation.execute({
        accountId: "acct-work",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: null,
      }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
    expect(iterations).toBe(0);
  });

  it.each([
    {
      name: "request id",
      error: {
        code: "provider_failure" as const,
        providerId: "anthropic",
        requestId: "request-other",
        message: "Wrong request.",
        retryable: false as const,
      },
    },
    {
      name: "deadline",
      error: {
        code: "deadline_exceeded" as const,
        providerId: "anthropic",
        requestId: "request-events",
        message: "Wrong deadline.",
        retryable: true as const,
        deadlineAt: 51,
      },
    },
  ])("rejects an error event with a mismatched $name binding", async ({ error }) => {
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "request-events",
        deadlineAt: 50,
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "error",
            eventId: `error-${error.code}`,
            sequence: 1,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
            },
            turnId: "turn-1",
            error,
          } satisfies ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal", requestId: "request-events" } },
    });
  });

  it.each([
    {
      name: "private account",
      eventSession: { accountId: "acct-other" },
      usageIdentity: {},
    },
    {
      name: "usage session",
      eventSession: {},
      usageIdentity: { sessionId: "session-other" },
    },
    {
      name: "usage thread",
      eventSession: {},
      usageIdentity: { threadId: "thread-other" },
    },
    {
      name: "usage turn",
      eventSession: {},
      usageIdentity: { turnId: "turn-other" },
    },
  ])("rejects a usage event with a mismatched $name identity", async ({ eventSession, usageIdentity }) => {
    const options = {
      providerId: "anthropic" as const,
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "usage",
            eventId: `usage-${eventSession.accountId ?? usageIdentity.sessionId ?? usageIdentity.threadId ?? usageIdentity.turnId}`,
            sequence: 1,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
              ...eventSession,
            },
            turnId: "turn-1",
            usage: {
              scope: "turn",
              identity: {
                sessionId: "session-1",
                threadId: "thread-1",
                turnId: "turn-1",
                ...usageIdentity,
              },
              totalTokens: 1,
              provenance: { kind: "provider-reported", authoritative: true, reportedAt: 1 },
            },
          } as ProviderEvent;
        },
      },
      close: async () => undefined,
    };
    const stream = createProviderEventStream(options);

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it.each([
    {
      name: "function value",
      value: { remaining: 4, hidden: () => "secret" },
    },
    {
      name: "accessor value",
      value: Object.defineProperty({ remaining: 4 }, "hidden", {
        enumerable: true,
        get: () => "secret",
      }),
    },
    {
      name: "symbol-keyed value",
      value: { remaining: 4, [Symbol("hidden")]: "secret" },
    },
    {
      name: "non-enumerable value",
      value: Object.defineProperty({ remaining: 4 }, "hidden", {
        enumerable: false,
        value: "secret",
      }),
    },
  ])("rejects extension success containing a $name", async ({ value }) => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "extension:closed_data",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      resultValidator: (candidate: unknown): candidate is { readonly remaining: number } =>
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as { remaining?: unknown }).remaining === "number",
      execute: async () => success(value),
    });

    await expect(operation.execute(undefined)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
  });

  it("rejects closed-algebra errors and fallback decisions with unknown own fields", async () => {
    const errorOperation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code: "provider_failure" as const,
          providerId: "hostile",
          message: "raw error",
          retryable: false,
          hiddenExtra: "secret",
        },
      }),
    });
    const result = await errorOperation.execute(interruptRequest);
    expect(result).toMatchObject({ kind: "error", error: { message: "Provider execution failed." } });
    if (result.kind !== "error") throw new Error("expected malformed error to be rejected");
    expect("hiddenExtra" in result.error).toBe(false);

    const decision = { ...visibleFallback, hiddenExtra: "secret" };
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { ...fallbackEvent, decision } as ProviderEvent;
        },
      },
      close: async () => undefined,
    });
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it.each([
    { code: "conflict" as const, details: { resource: "session" as const } },
    { code: "transport_failure" as const, details: { transport: "network" as const } },
  ])("rejects a $code error with an unknown own field", async ({ code, details }) => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code,
          providerId: "hostile",
          message: "raw error",
          retryable: false,
          ...details,
          hiddenExtra: "secret",
        },
      }),
    } as Parameters<typeof createProviderOperation>[0]);

    await expect(operation.execute(interruptRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure", message: "Provider execution failed." },
    });
  });

  it.each([
    {
      code: "approval_expired" as const,
      identity: { approvalId: "approval-command" },
      expiredAt: Number.NaN,
    },
    {
      code: "approval_expired" as const,
      identity: { approvalId: "approval-command" },
      expiredAt: Number.POSITIVE_INFINITY,
    },
    {
      code: "input_expired" as const,
      identity: { inputId: "input-1" },
      expiredAt: Number.NaN,
    },
    {
      code: "input_expired" as const,
      identity: { inputId: "input-1" },
      expiredAt: Number.NEGATIVE_INFINITY,
    },
  ])("rejects a $code error whose expiredAt is not finite", async ({ code, identity, expiredAt }) => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code,
          providerId: "hostile",
          message: "The interaction expired.",
          retryable: false as const,
          ...identity,
          expiredAt,
        },
      }),
    } as Parameters<typeof createProviderOperation>[0]);

    await expect(operation.execute(interruptRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
  });

  it.each([
    { operation: "discover_providers", count: 257, request: {} },
    { operation: "discover_accounts", count: 513, request: {} },
    { operation: "discover_models", count: 2_049, request: {} },
  ] as const)(
    "rejects an over-cap $operation result before array allocation or index reads",
    async ({ operation: operationName, count, request }) => {
      let itemReads = 0;
      const value = new Proxy([], {
        get(target, property, receiver) {
          if (property === "length") return count;
          if (typeof property === "string" && /^\d+$/.test(property)) itemReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const operation = createProviderOperation({
        providerId: "hostile",
        operation: operationName,
        eventEvidence: hostileEventEvidence,
        errorNormalization: normalization,
        execute: async () => success(value),
      });

      await expect(operation.execute(request)).resolves.toMatchObject({
        kind: "error",
        error: { code: "provider_failure" },
      });
      expect(itemReads).toBe(0);
    },
  );

  it.each([
    { operation: "discover_providers", field: "providerId", value: "unsafe\nprovider" },
    { operation: "discover_providers", field: "displayName", value: "unsafe\u200blabel" },
    { operation: "discover_providers", field: "adapterVersion", value: "unsafe\u2028version" },
    { operation: "discover_accounts", field: "accountId", value: "unsafe\u202eaccount" },
    { operation: "discover_accounts", field: "displayName", value: "unsafe\u0085label" },
    { operation: "discover_models", field: "modelId", value: "unsafe\u2066model" },
    { operation: "discover_models", field: "displayName", value: "unsafe\u2029label" },
  ] as const)("rejects unsafe $operation $field text", async ({ operation: operationName, field, value }) => {
    const accounts = await adapter.operations.discovery.accounts.execute({});
    const models = await adapter.operations.discovery.models.execute({});
    if (accounts.kind !== "success" || models.kind !== "success") throw new Error("fixture failed");
    const descriptor =
      operationName === "discover_providers"
        ? { providerId: "anthropic", displayName: "Anthropic", adapterVersion: "1.0.0", [field]: value }
        : operationName === "discover_accounts"
          ? { ...accounts.value[0], [field]: value }
          : { ...models.value[0], [field]: value };
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: operationName,
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success([descriptor]),
    });

    await expect(operation.execute({})).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each([
    { operation: "discover_providers", field: "providerId", value: "x".repeat(129) },
    { operation: "discover_providers", field: "providerId", value: "界".repeat(86) },
    { operation: "discover_providers", field: "displayName", value: "x".repeat(257) },
    { operation: "discover_providers", field: "displayName", value: "界".repeat(171) },
    { operation: "discover_accounts", field: "accountId", value: "x".repeat(129) },
    { operation: "discover_accounts", field: "displayName", value: "x".repeat(257) },
    { operation: "discover_models", field: "modelId", value: "x".repeat(129) },
    { operation: "discover_models", field: "displayName", value: "x".repeat(257) },
  ] as const)("rejects over-bound $operation $field text", async ({ operation: operationName, field, value }) => {
    const accounts = await adapter.operations.discovery.accounts.execute({});
    const models = await adapter.operations.discovery.models.execute({});
    if (accounts.kind !== "success" || models.kind !== "success") throw new Error("fixture failed");
    const descriptor =
      operationName === "discover_providers"
        ? { providerId: "anthropic", displayName: "Anthropic", [field]: value }
        : operationName === "discover_accounts"
          ? { ...accounts.value[0], [field]: value }
          : { ...models.value[0], [field]: value };
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: operationName,
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () => success([descriptor]),
    });

    await expect(operation.execute({})).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each([
    { name: "C0 control", text: "unsafe\ntext" },
    { name: "C1 control", text: "unsafe\u0085text" },
    { name: "format control", text: "unsafe\u200btext" },
    { name: "line separator", text: "unsafe\u2028text" },
    { name: "paragraph separator", text: "unsafe\u2029text" },
    { name: "UTF-16 overflow", text: "x".repeat(513) },
    { name: "UTF-8 overflow", text: "界".repeat(342) },
  ])("rejects $name in every user-visible capability text channel", async ({ text }) => {
    expect(() =>
      createUnavailableProviderOperation({
        providerId: "hostile",
        operation: "resume",
        availability: {
          state: "unavailable",
          reason: "not_supported_by_provider",
          message: text,
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createUnavailableProviderOperation({
        providerId: "hostile",
        operation: "resume",
        availability: { state: "unavailable", reason: "not_supported_by_provider" },
        message: text,
      }),
    ).toThrow(TypeError);

    const accounts = await adapter.operations.discovery.accounts.execute({});
    const models = await adapter.operations.discovery.models.execute({ accountId: "acct-work" });
    if (accounts.kind !== "success" || models.kind !== "success") throw new Error("fixture failed");
    const accountOperation = createProviderOperation({
      providerId: "anthropic",
      operation: "discover_accounts",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success([
          {
            ...accounts.value[0],
            capabilityReadiness: [{ operation: "send" as const, state: "unknown" as const, message: text }],
          },
        ]),
    });
    const modelOperation = createProviderOperation({
      providerId: "anthropic",
      operation: "discover_models",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success([
          {
            ...models.value[0],
            capabilities: {
              ...models.value[0].capabilities,
              input: {
                ...models.value[0].capabilities.input,
                text: { state: "available" as const, limitations: [text] },
              },
            },
          },
        ]),
    });
    const unavailableErrorOperation = createProviderOperation({
      providerId: "hostile",
      operation: "resume",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code: "operation_unavailable" as const,
          providerId: "hostile",
          message: text,
          retryable: false as const,
          operation: "resume" as const,
          availability: { state: "unavailable" as const, reason: "not_supported_by_provider" as const },
        },
      }),
    });

    await expect(accountOperation.execute({})).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
    await expect(modelOperation.execute({ accountId: "acct-work" })).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
    await expect(unavailableErrorOperation.execute(resumeRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
  });

  it("preserves bounded ordinary Unicode in every user-visible capability text channel", async () => {
    const message = "Résumé ready 🧠";
    const unavailable = createUnavailableProviderOperation({
      providerId: "hostile",
      operation: "resume",
      availability: {
        state: "unavailable",
        reason: "not_supported_by_provider",
        message,
      },
      message,
    });
    const accounts = await adapter.operations.discovery.accounts.execute({});
    if (accounts.kind !== "success") throw new Error("fixture failed");
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "discover_accounts",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success([
          {
            ...accounts.value[0],
            capabilityReadiness: [{ operation: "send" as const, state: "unknown" as const, message }],
          },
        ]),
    });

    expect(unavailable.capability.availability).toMatchObject({ message });
    await expect(operation.execute({})).resolves.toMatchObject({
      kind: "success",
      value: [{ capabilityReadiness: [{ message }] }],
    });
  });

  it("rejects an extra field in a nested discovery success algebra", async () => {
    const accounts = await adapter.operations.discovery.accounts.execute({});
    if (accounts.kind !== "success") throw new Error("fixture failed");
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "discover_accounts",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success([
          {
            ...accounts.value[0],
            authentication: { ...accounts.value[0].authentication, hiddenExtra: "secret" },
          },
        ]),
    });

    await expect(operation.execute({})).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it("rejects an extra field in a nested error algebra", async () => {
    const operation = createProviderOperation({
      providerId: "hostile",
      operation: "interrupt",
      eventEvidence: hostileEventEvidence,
      errorNormalization: normalization,
      execute: async () => ({
        kind: "error" as const,
        fallbackDecisions: [],
        error: {
          code: "rate_limited" as const,
          providerId: "hostile",
          message: "Slow down.",
          retryable: true as const,
          rateLimit: { state: "limited" as const, hiddenExtra: "secret" },
        },
      }),
    });

    await expect(operation.execute(interruptRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "provider_failure" },
    });
  });

  it("rejects extra fields at event and nested event-algebra boundaries", async () => {
    const stream = createProviderEventStream({
      providerId: "anthropic",
      accountId: "acct-work",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      context: { sessionId: "session-1", threadId: "thread-1", turnId: null },
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session",
            eventId: "event-extra",
            sequence: 1,
            occurredAt: 1,
            session: {
              sessionId: "session-1",
              threadId: "thread-1",
              providerId: "anthropic",
              accountId: "acct-work",
            },
            phase: "ready",
            hiddenExtra: "secret",
          } as unknown as ProviderEvent;
        },
      },
      close: async () => undefined,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { kind: "error", error: { code: "internal" } },
    });
  });

  it("rejects an extra field in a structured-output algebra", async () => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "send",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          messageId: "message-extra",
          turnId: "turn-1",
          target: { kind: "exact" as const, target: sendRequest.target },
          structuredOutput: {
            state: "present" as const,
            request: { ...structuredOutputIdentity, hiddenExtra: "secret" },
            result: structuredOutputResult,
          },
        }),
    });

    await expect(operation.execute(sendRequest)).resolves.toMatchObject({
      kind: "error",
      error: { code: "internal" },
    });
  });

  it.each([
    { name: "snapshot", snapshotExtra: { hiddenExtra: "secret" }, resultExtra: {}, valueExtra: {}, responseExtra: {} },
    { name: "result", snapshotExtra: {}, resultExtra: { hiddenExtra: "secret" }, valueExtra: {}, responseExtra: {} },
    { name: "value", snapshotExtra: {}, resultExtra: {}, valueExtra: { hiddenExtra: "secret" }, responseExtra: {} },
    { name: "response", snapshotExtra: {}, resultExtra: {}, valueExtra: {}, responseExtra: { hiddenExtra: "secret" } },
  ])("rejects an extra field in a telemetry $name algebra", async (extras) => {
    const operation = createProviderOperation({
      providerId: "anthropic",
      operation: "poll_telemetry",
      eventEvidence: anthropicEventEvidence,
      errorNormalization: testNormalization,
      execute: async () =>
        success({
          providerId: "anthropic",
          accountId: null,
          sessionId: null,
          threadId: null,
          capturedAt: 1,
          results: [
            {
              kind: "rate_limits" as const,
              state: "value" as const,
              value: { state: "within_limit" as const, windows: [], ...extras.valueExtra },
              ...extras.resultExtra,
            },
          ],
          response: { receivedAt: 1, ...extras.responseExtra },
          ...extras.snapshotExtra,
        }),
    });

    await expect(
      operation.execute({ accountId: null, sessionId: null, threadId: null, kinds: ["rate_limits"] }),
    ).resolves.toMatchObject({ kind: "error", error: { code: "internal" } });
  });

  it("accepts bounded ordinary Unicode and emoji descriptor text", async () => {
    const operation = createProviderOperation({
      providerId: "provider-🧠",
      operation: "discover_providers",
      eventEvidence: createProviderEventEvidence({ providerId: "provider-🧠" }),
      errorNormalization: testNormalization,
      execute: async () =>
        success([
          {
            providerId: "provider-🧠",
            displayName: "Résumé assistant 🧠",
            adapterVersion: "版本-1.0-🚀",
          },
        ]),
    });

    await expect(operation.execute({})).resolves.toMatchObject({
      kind: "success",
      value: [{ displayName: "Résumé assistant 🧠" }],
    });
  });
  it("resolves a valid closed adapter while preserving its registered callable operations", async () => {
    const result = await catalog.operations.resolveAdapter.execute({ providerId: "anthropic" });

    expect(result).toMatchObject({
      kind: "success",
      value: { contractVersion: 1, provider: { providerId: "anthropic" } },
    });
    if (result.kind !== "success") throw new Error("expected adapter resolution to succeed");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.operations)).toBe(true);
    await expect(result.value.operations.discovery.accounts.execute({})).resolves.toMatchObject({
      kind: "success",
      value: [{ accountId: "acct-work" }],
    });
  });

  it("resolves an adapter with detached frozen callable wrappers", async () => {
    const result = await catalog.operations.resolveAdapter.execute({ providerId: "anthropic" });
    if (result.kind !== "success") throw new Error("expected adapter resolution to succeed");

    const originalCallables = [
      adapter.errorNormalization.normalize,
      adapter.operations.discovery.accounts.execute,
      adapter.operations.discovery.models.execute,
      adapter.operations.sessions.start.execute,
      adapter.operations.sessions.resume.execute,
      adapter.operations.sessions.fork.execute,
      adapter.operations.sessions.send.execute,
      adapter.operations.sessions.submitToolResult.execute,
      adapter.operations.sessions.interrupt.execute,
      adapter.operations.sessions.events.execute,
      adapter.operations.interactions.respondToApproval.execute,
      adapter.operations.interactions.respondToUserInput.execute,
      adapter.operations.telemetry.poll.execute,
      adapter.extensions.refreshQuota.execute,
    ];
    const resolvedCallables = [
      result.value.errorNormalization.normalize,
      result.value.operations.discovery.accounts.execute,
      result.value.operations.discovery.models.execute,
      result.value.operations.sessions.start.execute,
      result.value.operations.sessions.resume.execute,
      result.value.operations.sessions.fork.execute,
      result.value.operations.sessions.send.execute,
      result.value.operations.sessions.submitToolResult.execute,
      result.value.operations.sessions.interrupt.execute,
      result.value.operations.sessions.events.execute,
      result.value.operations.interactions.respondToApproval.execute,
      result.value.operations.interactions.respondToUserInput.execute,
      result.value.operations.telemetry.poll.execute,
      result.value.extensions.refreshQuota.execute,
    ];

    expect(resolvedCallables).toHaveLength(originalCallables.length);
    resolvedCallables.forEach((callable, index) => {
      expect(callable).not.toBe(originalCallables[index]);
      expect(Object.isFrozen(callable)).toBe(true);
      expect(Reflect.set(callable, "sharedMutation", true)).toBe(false);
    });
    await expect(result.value.operations.discovery.accounts.execute({})).resolves.toMatchObject({
      kind: "success",
      value: [{ accountId: "acct-work" }],
    });
  });
});

describe("fallback resolution validation", () => {
  const requested = {
    providerId: "anthropic",
    accountId: "acct-work",
    modelId: "claude-sonnet",
  };

  async function recordFallback(event: ProviderEvent, providerId = "anthropic") {
    const eventEvidence = createProviderEventEvidence({ providerId });
    const stream = createProviderEventStream({
      providerId,
      accountId: event.session.accountId,
      eventEvidence,
      errorNormalization: testNormalization,
      context: {
        sessionId: event.session.sessionId,
        threadId: event.session.threadId,
        turnId: event.turnId ?? null,
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield event;
        },
      },
      close: async () => undefined,
    });
    const emitted = await stream[Symbol.asyncIterator]().next();
    return { eventEvidence, emitted };
  }

  it("rejects a caller-fabricated fallback event projection", () => {
    const eventEvidence = createProviderEventEvidence({ providerId: "anthropic" });
    expect(
      validateTargetResolution(
        {
          adapterProviderId: "anthropic",
          requestedTarget: requested,
          policy: visibleFallback.policy,
          resolution: fallbackResolution,
          eventEvidence,
          event: {
            type: "fallback",
            eventId: fallbackEvent.eventId,
            providerId: "anthropic",
            decision: { ...visibleFallback },
          },
        } as unknown as Parameters<typeof validateTargetResolution>[0],
      ),
    ).toMatchObject({
      kind: "error",
      error: { code: "invalid_request", field: "targetResolution" },
    });
  });

  it("accepts only a policy-scoped fallback recorded by the matching visible event", async () => {
    const { eventEvidence, emitted } = await recordFallback(fallbackEvent);
    expect(emitted.value).toMatchObject({ kind: "success" });
    expect(
      validateTargetResolution({
        adapterProviderId: "anthropic",
        requestedTarget: requested,
        policy: visibleFallback.policy,
        resolution: fallbackResolution,
        eventEvidence,
      }),
    ).toMatchObject({ kind: "success", fallbackDecisions: [visibleFallback] });
  });

  it("rejects mismatched event identity, event provider, and adapter provider", async () => {
    const wrongId = await recordFallback({ ...fallbackEvent, eventId: "wrong-event" });
    const wrongProvider = await recordFallback({
      ...fallbackEvent,
      session: { ...fallbackEvent.session, providerId: "openai" },
    });
    const valid = await recordFallback(fallbackEvent);

    for (const [adapterProviderId, eventEvidence] of [
      ["anthropic", wrongId.eventEvidence],
      ["anthropic", wrongProvider.eventEvidence],
      ["openai", valid.eventEvidence],
    ] as const) {
      expect(
        validateTargetResolution({
          adapterProviderId,
          requestedTarget: requested,
          policy: visibleFallback.policy,
          resolution: fallbackResolution,
          eventEvidence,
        }),
      ).toMatchObject({
        kind: "error",
        error: { code: "invalid_request", field: "targetResolution" },
      });
    }
  });

  it("returns a stable validation error for hostile target objects", () => {
    const hostileTarget = new Proxy(requested, {
      get: () => {
        throw new Error("hostile target getter");
      },
    });

    expect(
      validateTargetResolution({
        adapterProviderId: "anthropic",
        requestedTarget: hostileTarget,
        policy: { mode: "forbid" },
        resolution: { kind: "exact", target: requested },
        eventEvidence: createProviderEventEvidence({ providerId: "anthropic" }),
      }),
    ).toMatchObject({
      kind: "error",
      error: { code: "invalid_request", field: "targetResolution" },
    });
  });

  it("rejects internally consistent records when the changed dimension is outside policy scope", async () => {
    const policy = { mode: "allow", scopes: ["model"], confirmation: "never" } as const;
    const decision = { ...visibleFallback, policy };
    const resolution = {
      kind: "fallback",
      requested,
      resolved: visibleFallback.resolved,
      decision,
    } as const;
    const event = { ...fallbackEvent, decision } satisfies ProviderEvent;
    const { eventEvidence } = await recordFallback(event);

    expect(
      validateTargetResolution({
        adapterProviderId: "anthropic",
        requestedTarget: requested,
        policy,
        resolution,
        eventEvidence,
      }),
    ).toMatchObject({
      kind: "error",
      error: { code: "invalid_request", field: "targetResolution" },
    });
  });
});

describe("ProviderAdapterV1", () => {
  it("keeps unavailable operations callable through the stable Result boundary", async () => {
    expect(PROVIDER_ADAPTER_CONTRACT_VERSION).toBe(1);
    expect(adapter.extensions.refreshQuota.capability.availability.state).toBe("available");
    expect(catalog.operations.discoverProviders.capability.operation).toBe("discover_providers");
    await expect(adapter.operations.sessions.resume.execute(resumeRequest)).resolves.toEqual(
      unavailableResume,
    );
    expectTypeOf(adapter.operations.sessions.resume.execute).returns.toEqualTypeOf<
      Promise<ProviderAdapterUnavailableResult>
    >();
  });

  it("preserves assistant, tool, structured-output, and provider-native model semantics", () => {
    expect(assistantMessageEvent.message.blocks.map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "refusal",
      "tool_call",
    ]);
    expect(toolEvent.result.output).toEqual({ exitCode: 0, output: "" });
    expect(submittedToolResults.map((result) => result.state)).toEqual([
      "success",
      "error",
      "cancel",
    ]);
    expect(partialToolCall.arguments).toEqual({
      state: "partial",
      text: '{"command":"git stat',
    });
    expect(startRequest.execution.settings.reasoning?.budgetTokens).toBe(8_000);
    expect(modelSettings.effort?.providerValue).toEqual({ thinkingBudget: "high" });
    expect(structuredOutputOutcomes.map((outcome) => outcome.state)).toEqual([
      "not_requested",
      "present",
      "refused",
      "unavailable",
      "invalid",
      "incomplete",
    ]);
    expect(exhaustiveSchemas[0]).toBe(true);
    expect(exhaustiveSchemas[1]).toMatchObject({ $ref: "#/$defs/payload" });
  });

  it("requires explicit fallback and precise thread or turn boundaries", () => {
    expect(fallbackEvent.decision.notice.visibility).toBe("required");
    expect(fallbackResolution.decision.visibleEventId).toBe(fallbackEvent.eventId);
    expect(sendRequest.fallback.mode).toBe("forbid");
    expect(forkRequest.boundary.kind).toBe("after_message");
    expect(interruptRequest.target.kind).toBe("tool_call");
  });

  it("carries approval, expiry, rate-limit, and child-usage provenance", () => {
    expect(approvalRequests.map((request) => request.subject.kind)).toEqual([
      "command",
      "diff",
      "policy",
    ]);
    expect(approvalChoices.map((choice) => choice.action)).toEqual([
      "approve",
      "approve",
      "deny",
      "cancel",
      "amend",
    ]);
    expect(userInputPrompt.expiresAt).toBe(45_000);
    expect(userInputPrompt.questions.map((question) => question.kind)).toEqual(["select", "editor"]);
    expect(approvalAmendment.action).toBe("amend");
    expect(userInputResponse.answers).toHaveLength(2);
    expect(cancelledUserInputResponse.action).toBe("cancel");
    expect(rateLimitWindow.utilizationPercent).toBe(75);
    expect(telemetrySnapshot.results.map((result) => result.state)).toEqual([
      "value",
      "unavailable",
      "error",
    ]);
    expect(childUsage.identity.child.turnId).toBe("turn-child-1");
  });

  it("exposes tool-result submission and typed telemetry polling as core operations", async () => {
    await expect(
      adapter.operations.sessions.submitToolResult.execute(submitToolResultRequest),
    ).resolves.toMatchObject({
      kind: "success",
      value: { accepted: true, toolCallId: "tool-call-1", state: "success" },
    });
    await expect(
      adapter.operations.telemetry.poll.execute({
        accountId: "acct-work",
        sessionId: null,
        threadId: null,
        kinds: ["authentication", "rate_limits"],
      }),
    ).resolves.toMatchObject({
      kind: "success",
      value: {
        providerId: "anthropic",
        response: { requestId: "provider-request-telemetry", statusCode: 200 },
      },
    });
  });

  it("binds model discovery to an authenticated, capability-ready account", async () => {
    const accounts = await adapter.operations.discovery.accounts.execute({});
    const models = await adapter.operations.discovery.models.execute({ accountId: "acct-work" });

    expect(accounts).toMatchObject({
      kind: "success",
      value: [
        {
          accountId: "acct-work",
          authentication: { method: "oauth", mode: "interactive" },
          capabilityReadiness: [
            { operation: "start", state: "ready" },
            {
              operation: "resume",
              state: "unavailable",
              reason: "not_supported_by_provider",
            },
          ],
        },
      ],
    });
    expect(models).toMatchObject({
      kind: "success",
      value: [{ providerId: "anthropic", accountId: "acct-work", modelId: "claude-sonnet" }],
    });
  });

  it("enumerates stable operational errors", () => {
    expect(operationalErrors.map((error) => error.code)).toEqual([
      "cancelled",
      "rate_limited",
      "authentication_expired",
      "context_limit_exceeded",
      "deadline_exceeded",
      "tool_failure",
      "approval_denied",
      "approval_expired",
      "input_expired",
    ]);
  });
});

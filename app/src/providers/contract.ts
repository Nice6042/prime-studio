/**
 * A pure, versioned boundary for provider integrations. This module intentionally
 * contains no provider implementation, transport, process, or UI code.
 */
export const PROVIDER_ADAPTER_CONTRACT_VERSION = 1 as const;

export type ProviderAdapterContractVersion = typeof PROVIDER_ADAPTER_CONTRACT_VERSION;
export type ProviderId = string;
export type AccountId = string;
export type ModelId = string;
export type SessionId = string;
export type ThreadId = string;
export type TurnId = string;
export type MessageId = string;
export type EventId = string;
export type RequestId = string;
export type ToolCallId = string;
export type TimestampMs = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonSchemaType =
  | "null"
  | "boolean"
  | "object"
  | "array"
  | "number"
  | "integer"
  | "string";

/**
 * A lossless JSON Schema document. Known keywords remain discoverable while the
 * JSON object index preserves provider/dialect extensions verbatim.
 */
export type JsonSchema = boolean | JsonSchemaObject;

export type JsonSchemaValue = JsonPrimitive | JsonSchemaObject | readonly JsonSchemaValue[];

export interface JsonSchemaObject {
  readonly [keyword: string]: JsonSchemaValue | undefined;
  readonly $id?: string;
  readonly $schema?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly format?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export type CoreProviderOperationName =
  | "discover_providers"
  | "resolve_adapter"
  | "discover_accounts"
  | "discover_models"
  | "start"
  | "resume"
  | "fork"
  | "send"
  | "submit_tool_result"
  | "interrupt"
  | "events"
  | "poll_telemetry"
  | "respond_to_approval"
  | "respond_to_user_input";

/**
 * Integrations may name provider-specific operations in the `extension:`
 * namespace while the named core operations stay stable.
 */
export type ProviderOperationName = CoreProviderOperationName | `extension:${string}`;

export type CapabilityUnavailableReason =
  | "not_supported_by_provider"
  | "not_available_for_account"
  | "not_available_for_model"
  | "disabled_by_policy"
  | "not_implemented"
  | "temporarily_unavailable";

export interface AvailableCapability {
  readonly state: "available";
  readonly limitations?: readonly string[];
}

export interface UnavailableCapability {
  readonly state: "unavailable";
  readonly reason: CapabilityUnavailableReason;
  readonly message?: string;
}

export type CapabilityAvailability = AvailableCapability | UnavailableCapability;

export interface OperationCapability {
  readonly operation: ProviderOperationName;
  readonly availability: CapabilityAvailability;
}

export interface ProviderAdapterSuccess<T> {
  readonly kind: "success";
  readonly value: T;
  /** Every automatic target substitution is made available to the caller. */
  readonly fallbackDecisions: readonly FallbackDecision[];
}

export interface ProviderAdapterFailure<TError extends ProviderAdapterError = ProviderAdapterError> {
  readonly kind: "error";
  readonly error: TError;
  /** A failed attempt can still have made a user-visible fallback decision. */
  readonly fallbackDecisions: readonly FallbackDecision[];
}

export type ProviderAdapterResult<T> = ProviderAdapterSuccess<T> | ProviderAdapterFailure;

/**
 * Adapter executions must fulfill with this Result and must never reject. An
 * implementation catches every thrown/rejected value and routes it through its
 * required `errorNormalization` boundary before fulfilling.
 */
export type ProviderAdapterPromise<T> = Promise<ProviderAdapterResult<T>>;

/** The required result of invoking a deliberately unavailable operation. */
export type ProviderAdapterUnavailableResult = ProviderAdapterFailure<OperationUnavailableError>;

const providerOperationBoundary: unique symbol = Symbol("provider-operation-boundary");

/** Structural brands are forgeable through proxies; constructor provenance is not. */
const providerOperationRegistrations = new WeakSet<object>();

interface EnforcedProviderOperationBoundary {
  /** Opaque brand: supported operations can only be produced by the safe factory. */
  readonly [providerOperationBoundary]: true;
}

export interface SupportedCapabilityOperation<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
  TResult,
>
  extends EnforcedProviderOperationBoundary {
  readonly providerId: TProviderId;
  readonly capability: {
    readonly operation: TOperation;
    readonly availability: AvailableCapability;
  };
  readonly execute: (request: TRequest) => ProviderAdapterPromise<TResult>;
}

/**
 * Optional operations are never absent at the caller boundary. Their `execute`
 * method returns this explicit stable error when the capability is unavailable.
 */
export interface UnavailableCapabilityOperation<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
> extends EnforcedProviderOperationBoundary {
  readonly providerId: TProviderId;
  readonly capability: {
    readonly operation: TOperation;
    readonly availability: UnavailableCapability;
  };
  readonly execute: (request: TRequest) => Promise<ProviderAdapterUnavailableResult>;
}

export type ProviderCapabilityOperation<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
  TResult,
> =
  | SupportedCapabilityOperation<TProviderId, TOperation, TRequest, TResult>
  | UnavailableCapabilityOperation<TProviderId, TOperation, TRequest>;

export interface ProviderDescriptor<TProviderId extends ProviderId = ProviderId> {
  readonly providerId: TProviderId;
  readonly displayName: string;
  readonly adapterVersion?: string;
}

export interface AuthenticationStatus {
  readonly state: "valid" | "expiring" | "expired" | "required" | "unknown";
  readonly method:
    | "api_key"
    | "oauth"
    | "subscription"
    | "service_account"
    | "unknown"
    | `provider:${string}`;
  readonly mode:
    | "interactive"
    | "headless"
    | "external"
    | "managed"
    | "unknown"
    | `provider:${string}`;
  readonly expiresAt?: TimestampMs;
}

interface AccountCapabilityReadinessBase {
  readonly operation: ProviderOperationName;
}

export type AccountCapabilityReadiness = AccountCapabilityReadinessBase &
  (
    | { readonly state: "ready" }
    | { readonly state: "requires_authentication"; readonly message?: string }
    | {
        readonly state: "unavailable";
        readonly reason: CapabilityUnavailableReason;
        readonly message?: string;
      }
    | { readonly state: "unknown"; readonly message?: string }
  );

export interface AccountDescriptor {
  readonly accountId: AccountId;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly authentication: AuthenticationStatus;
  readonly capabilityReadiness: readonly AccountCapabilityReadiness[];
}

export interface ModelReasoningMode {
  readonly modeId: string;
  readonly displayName: string;
  /** The provider-native value; adapters must not collapse distinct semantics. */
  readonly providerValue: JsonValue;
}

export interface ModelReasoningCapability {
  readonly availability: CapabilityAvailability;
  readonly modes: readonly ModelReasoningMode[];
}

export interface ModelCapabilities {
  readonly input: {
    readonly text: CapabilityAvailability;
    readonly image: CapabilityAvailability;
    readonly file: CapabilityAvailability;
  };
  readonly output: {
    readonly text: CapabilityAvailability;
    readonly thinking: CapabilityAvailability;
    readonly refusal: CapabilityAvailability;
    readonly toolCalls: CapabilityAvailability;
    readonly structuredOutput: CapabilityAvailability;
  };
  readonly reasoning: ModelReasoningCapability;
  readonly providerSpecific: Readonly<Record<string, ProviderSpecificCapability>>;
}

export interface ModelLimits {
  readonly contextWindowTokens?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxReasoningTokens?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly providerSpecific: JsonObject;
}

export interface ModelEffortOption {
  readonly optionId: string;
  readonly displayName: string;
  /** Exact provider-native representation of this option. */
  readonly providerValue: JsonValue;
}

export interface ModelEffortCapability {
  readonly availability: CapabilityAvailability;
  readonly options: readonly ModelEffortOption[];
  readonly defaultOptionId?: string;
}

export interface ModelDescriptor {
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  readonly accountId: AccountId;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly limits: ModelLimits;
  readonly effort: ModelEffortCapability;
}

export interface EffortSelection {
  readonly optionId: string;
  readonly providerValue: JsonValue;
}

export interface ReasoningSettings {
  readonly mode: string;
  readonly budgetTokens?: number;
  readonly summary?: "none" | "auto" | "detailed";
  readonly providerSpecific: JsonObject;
}

export interface ModelExecutionSettings {
  readonly effort?: EffortSelection;
  readonly reasoning?: ReasoningSettings;
  readonly providerSpecific: JsonObject;
}

export interface SessionReference {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly providerId: ProviderId;
  readonly accountId: AccountId;
  readonly modelId?: ModelId;
  readonly activeTurnId?: TurnId;
}

export interface ExecutionTarget {
  readonly providerId: ProviderId;
  readonly accountId?: AccountId;
  readonly modelId?: ModelId;
}

export interface UserVisibleFallbackNotice {
  /** Consumers must render this decision; it may not be silently applied. */
  readonly visibility: "required";
  readonly title: string;
  readonly message: string;
}

export type FallbackScope = "provider" | "account" | "model";

export type FallbackReason =
  | "account_unavailable"
  | "model_unavailable"
  | "rate_limited"
  | "authentication_expired"
  | "context_limit"
  | "provider_unavailable"
  | "policy"
  | "user_selected";

export interface ForbidFallbackPolicy {
  readonly mode: "forbid";
}

export interface AllowFallbackPolicy {
  readonly mode: "allow";
  readonly scopes: readonly FallbackScope[];
  readonly confirmation: "always" | "on-provider-change" | "never";
  readonly allowedTargets?: readonly ExecutionTarget[];
}

/** Start, resume, fork, and send requests must explicitly select one of these policies. */
export type FallbackPolicy = ForbidFallbackPolicy | AllowFallbackPolicy;

export type FallbackConfirmationEvidence =
  | {
      readonly kind: "not_required";
      readonly reason: "policy_never" | "provider_unchanged";
    }
  | {
      readonly kind: "user_confirmed";
      readonly confirmationId: string;
      readonly confirmedAt: TimestampMs;
      readonly confirmedBy: "user";
    };

export interface FallbackDecision {
  readonly decisionId: string;
  /** The event stream must emit the matching `fallback` event with this id. */
  readonly visibleEventId: EventId;
  readonly decidedAt: TimestampMs;
  readonly reason: FallbackReason;
  readonly policy: AllowFallbackPolicy;
  readonly confirmation: FallbackConfirmationEvidence;
  readonly requested: ExecutionTarget;
  readonly resolved: ExecutionTarget;
  readonly notice: UserVisibleFallbackNotice;
}

/**
 * Exact resolutions carry one target. Any requested/resolved difference can
 * only be represented by the fallback branch, which requires a visible record.
 */
export type TargetResolution =
  | { readonly kind: "exact"; readonly target: ExecutionTarget }
  | {
      readonly kind: "fallback";
      readonly requested: ExecutionTarget;
      readonly resolved: ExecutionTarget;
      readonly decision: FallbackDecision;
    };

export interface RequestControl {
  readonly requestId?: RequestId;
  /** A local caller may cancel cooperative work through the standard DOM signal. */
  readonly signal?: AbortSignal;
  readonly deadlineAt?: TimestampMs;
}

export interface DiscoverProvidersRequest extends RequestControl {
  readonly refresh?: boolean;
}

export interface ResolveProviderAdapterRequest extends RequestControl {
  readonly providerId: ProviderId;
}

export interface DiscoverAccountsRequest extends RequestControl {
  readonly refresh?: boolean;
}

export interface DiscoverModelsRequest extends RequestControl {
  readonly accountId?: AccountId;
  readonly refresh?: boolean;
}

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export type UserMessagePart =
  | TextContentBlock
  | { readonly type: "image"; readonly uri: string; readonly mediaType?: string }
  | { readonly type: "file"; readonly uri: string; readonly name?: string; readonly mediaType?: string };

export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly providerSpecific: JsonObject;
}

/**
 * Tool arguments may arrive as syntactically incomplete JSON while streaming.
 * Only the complete branch is safe to dispatch to a tool implementation.
 */
export type StreamingJsonObject =
  | {
      readonly state: "partial";
      readonly text: string;
      readonly parsed?: JsonValue;
    }
  | {
      readonly state: "complete";
      readonly text: string;
      readonly value: JsonObject;
    }
  | {
      readonly state: "invalid";
      readonly text: string;
      readonly message: string;
    };

export interface ToolCall {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Index of the tool-call block in its assistant message. */
  readonly blockIndex: number;
  readonly arguments: StreamingJsonObject;
}

export interface ToolResultBase {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Index of this result block in the tool message. */
  readonly blockIndex: number;
  readonly startedAt: TimestampMs;
  readonly completedAt: TimestampMs;
}

export type ToolResult =
  | (ToolResultBase & {
      readonly state: "success";
      readonly output: JsonValue;
      readonly error?: never;
    })
  | (ToolResultBase & {
      readonly state: "error";
      readonly output?: JsonValue;
      readonly error: ProviderAdapterError;
    })
  | (ToolResultBase & {
      readonly state: "cancel";
      readonly output?: never;
      readonly error?: CancelledError;
    });

export type AssistantContentBlock =
  | (TextContentBlock & { readonly index: number })
  | {
      readonly type: "thinking";
      readonly index: number;
      readonly text: string;
      readonly visibility: "collapsed" | "expanded" | "hidden";
      readonly providerSpecific: JsonObject;
    }
  | {
      readonly type: "refusal";
      readonly index: number;
      readonly message: string;
      readonly reasonCode?: string;
    }
  | { readonly type: "tool_call"; readonly index: number; readonly call: ToolCall };

export interface StructuredOutputRequestIdentity {
  readonly schemaName: string;
  /** Caller-computed digest of the canonical schema used to bind every outcome to this request. */
  readonly schemaHash: string;
  readonly strict: boolean;
}

export interface StructuredOutputRequest extends StructuredOutputRequestIdentity {
  readonly description?: string;
  readonly schema: JsonSchema;
}

export type StructuredOutputValidation =
  | { readonly state: "valid" }
  | {
      readonly state: "invalid";
      readonly issues: readonly {
        readonly path: readonly (string | number)[];
        readonly message: string;
      }[];
    };

export interface StructuredOutputResult {
  readonly schemaName: string;
  readonly value: JsonValue;
  readonly validation: StructuredOutputValidation;
}

export type ValidStructuredOutputResult = Omit<StructuredOutputResult, "validation"> & {
  readonly validation: { readonly state: "valid" };
};

export type StructuredOutputOutcome =
  | { readonly state: "not_requested" }
  | {
      readonly state: "present";
      readonly request: StructuredOutputRequestIdentity;
      readonly result: ValidStructuredOutputResult;
    }
  | {
      readonly state: "refused";
      readonly request: StructuredOutputRequestIdentity;
      readonly message: string;
      readonly reasonCode?: string;
    }
  | {
      readonly state: "unavailable";
      readonly request: StructuredOutputRequestIdentity;
      readonly availability: UnavailableCapability;
    }
  | {
      readonly state: "invalid";
      readonly request: StructuredOutputRequestIdentity;
      readonly rawText: string;
      readonly issues: readonly {
        readonly path: readonly (string | number)[];
        readonly message: string;
      }[];
    }
  | {
      readonly state: "incomplete";
      readonly request: StructuredOutputRequestIdentity;
      readonly accumulatedJson: string;
    };

export interface ModelExecutionOptions {
  readonly settings?: ModelExecutionSettings;
  readonly tools: readonly ToolDefinition[];
  readonly structuredOutput?: StructuredOutputRequest;
}

export interface StartSessionRequest extends RequestControl {
  readonly target: ExecutionTarget;
  readonly fallback: FallbackPolicy;
  readonly execution: ModelExecutionOptions;
  readonly workingDirectory?: string;
  readonly initialMessage?: readonly UserMessagePart[];
}

export interface SessionOpened {
  readonly session: SessionReference;
  readonly target: TargetResolution;
}

export interface ResumeSessionRequest extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly target: ExecutionTarget;
  readonly fallback: FallbackPolicy;
  readonly boundary: ResumeBoundary;
}

export type ResumeBoundary =
  | { readonly kind: "latest" }
  | { readonly kind: "after_event"; readonly eventId: EventId }
  | { readonly kind: "after_turn"; readonly turnId: TurnId };

export interface ForkSessionRequest extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly target: ExecutionTarget;
  readonly fallback: FallbackPolicy;
  readonly boundary: ForkBoundary;
}

export type ForkBoundary =
  | { readonly kind: "after_event"; readonly eventId: EventId }
  | { readonly kind: "after_turn"; readonly turnId: TurnId }
  | { readonly kind: "after_message"; readonly messageId: MessageId };

export type SendTurnTarget =
  | { readonly kind: "new"; readonly parentTurnId?: TurnId }
  | { readonly kind: "existing"; readonly turnId: TurnId };

export interface SendMessageRequest extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly turn: SendTurnTarget;
  readonly target: ExecutionTarget;
  readonly fallback: FallbackPolicy;
  readonly execution: ModelExecutionOptions;
  readonly parts: readonly UserMessagePart[];
  readonly delivery?: "interrupt" | "queue";
}

export interface SendMessageResult {
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly target: TargetResolution;
  readonly structuredOutput: StructuredOutputOutcome;
}

export type SubmittedToolResult =
  | {
      readonly state: "success";
      readonly output: JsonValue;
      readonly error?: never;
    }
  | {
      readonly state: "error";
      readonly output?: JsonValue;
      readonly error: ProviderAdapterError;
    }
  | {
      readonly state: "cancel";
      readonly output?: never;
      readonly error?: CancelledError;
      readonly reason?: string;
    };

export interface SubmitToolResultRequest extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly assistantBlockIndex: number;
  readonly toolResultBlockIndex: number;
  readonly result: SubmittedToolResult;
}

export interface SubmitToolResultResponse {
  readonly accepted: boolean;
  readonly toolCallId: ToolCallId;
  readonly state: SubmittedToolResult["state"];
}

export interface InterruptSessionRequest extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly target: InterruptTarget;
  readonly reason?: "user_requested" | "cancellation" | "shutdown";
}

export type InterruptTarget =
  | { readonly kind: "turn"; readonly turnId: TurnId }
  | { readonly kind: "request"; readonly turnId: TurnId; readonly requestId: RequestId }
  | { readonly kind: "tool_call"; readonly turnId: TurnId; readonly toolCallId: ToolCallId };

export interface InterruptSessionResult {
  readonly interrupted: boolean;
  readonly turnId: TurnId;
  readonly target: InterruptTarget;
}

export interface SubscribeSessionEventsRequest extends RequestControl {
  /** The authoritative account dimension for the subscribed session. */
  readonly accountId: AccountId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  /** Null subscribes to every turn in the session; a turn id scopes the stream exactly. */
  readonly turnId: TurnId | null;
  readonly afterEventId?: EventId;
}

export interface ProviderEventStreamContext {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  /** The opaque event cursor this stream resumes after. */
  readonly afterEventId?: EventId;
  readonly requestId?: RequestId;
  readonly deadlineAt?: TimestampMs;
}

const providerEventStreamBoundary: unique symbol = Symbol("provider-event-stream-boundary");

export interface ProviderEventStream<TProviderId extends ProviderId = ProviderId>
  extends AsyncIterable<ProviderAdapterResult<ProviderEvent>> {
  readonly providerId: TProviderId;
  readonly context: ProviderEventStreamContext;
  readonly [providerEventStreamBoundary]: true;
  readonly close: () => ProviderAdapterPromise<void>;
}

interface ProviderEventStreamRegistration {
  readonly providerId: ProviderId;
  readonly accountId: AccountId;
  readonly eventEvidenceRegistration: ProviderEventEvidenceRegistration | undefined;
  readonly context: ProviderEventStreamContext;
  readonly iterator: ProviderEventStream[typeof Symbol.asyncIterator];
}

/** Structural brands are forgeable through proxies; exact constructor provenance is not. */
const providerEventStreamRegistrations = new WeakMap<object, ProviderEventStreamRegistration>();

export type ApprovalSubject =
  | {
      readonly kind: "command";
      readonly command: {
        readonly program: string;
        readonly arguments: readonly string[];
        readonly cwd: string;
        readonly environmentKeys?: readonly string[];
      };
    }
  | {
      readonly kind: "diff";
      readonly patch: string;
      readonly files: readonly string[];
    }
  | {
      readonly kind: "policy";
      readonly policyId: string;
      readonly rule: string;
      readonly scope: "request" | "turn" | "session" | "workspace";
    }
  | {
      readonly kind: "tool";
      readonly definition: ToolDefinition;
      readonly call: ToolCall;
    };

export interface ApprovalOption {
  readonly optionId: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly selectedByDefault?: boolean;
}

interface ApprovalChoiceBase {
  readonly choiceId: string;
  readonly label: string;
  readonly scope: "once" | "turn" | "session" | "policy";
  readonly options?: readonly ApprovalOption[];
  readonly policyPatch?: JsonObject;
}

export type ApprovalChoice =
  | (ApprovalChoiceBase & {
      readonly action: "approve" | "deny" | "cancel";
      readonly amendmentSchema?: never;
    })
  | (ApprovalChoiceBase & {
      readonly action: "amend";
      readonly amendmentSchema: JsonSchema;
    });

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly title: string;
  readonly message: string;
  /** `null` explicitly means the provider supplied no expiry. */
  readonly expiresAt: TimestampMs | null;
  readonly subject: ApprovalSubject;
  readonly choices: readonly [ApprovalChoice, ...ApprovalChoice[]];
}

export type ApprovalAmendment =
  | {
      readonly kind: "command";
      readonly program: string;
      readonly arguments: readonly string[];
      readonly cwd: string;
    }
  | { readonly kind: "diff"; readonly patch: string; readonly files: readonly string[] }
  | { readonly kind: "policy"; readonly policyPatch: JsonObject }
  | { readonly kind: "tool"; readonly arguments: JsonObject };

interface ApprovalResponseBase extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly approvalId: string;
  readonly choiceId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly note?: string;
}

export type RespondToApprovalRequest =
  | (ApprovalResponseBase & {
      readonly action: "approve" | "deny" | "cancel";
      readonly amendment?: never;
    })
  | (ApprovalResponseBase & {
      readonly action: "amend";
      readonly amendment: ApprovalAmendment;
    });

export interface ApprovalResponseResult {
  readonly approvalId: string;
  readonly choiceId: string;
  readonly action: "approve" | "deny" | "cancel" | "amend";
  readonly selectedOptionIds?: readonly string[];
  readonly amendment?: ApprovalAmendment;
  readonly appliedPolicyId?: string;
}

export interface UserInputOption {
  readonly optionId: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly description?: string;
}

export type UserInputQuestion =
  | {
      readonly questionId: string;
      readonly kind: "text";
      readonly label: string;
      readonly required: boolean;
      readonly placeholder?: string;
      readonly initialValue?: string;
    }
  | {
      readonly questionId: string;
      readonly kind: "editor";
      readonly label: string;
      readonly required: boolean;
      readonly language?: string;
      readonly initialValue?: string;
    }
  | {
      readonly questionId: string;
      readonly kind: "confirm";
      readonly label: string;
      readonly required: boolean;
      readonly initialValue?: boolean;
    }
  | {
      readonly questionId: string;
      readonly kind: "select";
      readonly label: string;
      readonly required: boolean;
      readonly selection: "single" | "multiple";
      readonly options: readonly UserInputOption[];
    };

export interface UserInputPrompt {
  readonly inputId: string;
  readonly title: string;
  readonly message?: string;
  /** `null` explicitly represents a non-expiring provider request. */
  readonly expiresAt: TimestampMs | null;
  readonly allowCancel: boolean;
  readonly questions: readonly [UserInputQuestion, ...UserInputQuestion[]];
}

export type UserInputAnswer =
  | { readonly questionId: string; readonly kind: "text" | "editor"; readonly value: string }
  | { readonly questionId: string; readonly kind: "confirm"; readonly value: boolean }
  | {
      readonly questionId: string;
      readonly kind: "select";
      readonly selection: "single";
      readonly optionId: string;
      readonly optionIds?: never;
    }
  | {
      readonly questionId: string;
      readonly kind: "select";
      readonly selection: "multiple";
      readonly optionIds: readonly string[];
      readonly optionId?: never;
    };

interface UserInputResponseBase extends RequestControl {
  readonly sessionId: SessionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly inputId: string;
}

export type RespondToUserInputRequest =
  | (UserInputResponseBase & {
      readonly action: "submit";
      readonly answers: readonly UserInputAnswer[];
      readonly reason?: never;
    })
  | (UserInputResponseBase & {
      readonly action: "cancel";
      readonly answers?: never;
      readonly reason?: string;
    });

export interface UserInputResponseResult {
  readonly inputId: string;
  readonly accepted: boolean;
  readonly action: "submitted" | "cancelled";
}

export interface CancellationCapability {
  readonly availability: CapabilityAvailability;
  readonly modes: readonly ("abort-signal" | "session-interrupt")[];
}

export type TelemetryCapability =
  | {
      readonly availability: AvailableCapability;
      readonly delivery: "event-stream" | "poll" | "response";
    }
  | {
      readonly availability: UnavailableCapability;
      readonly delivery?: never;
    };

export interface ProviderSpecificCapability {
  readonly availability: CapabilityAvailability;
  readonly displayName: string;
  readonly description?: string;
}

/**
 * Operation-level availability is carried by each `ProviderCapabilityOperation`.
 * This object represents cross-cutting capability and telemetry support.
 */
export interface ProviderAdapterCapabilities {
  readonly cancellation: CancellationCapability;
  readonly rateLimits: TelemetryCapability;
  readonly authenticationExpiry: TelemetryCapability;
  readonly contextLimits: TelemetryCapability;
  readonly providerSpecific: Readonly<Record<string, ProviderSpecificCapability>>;
}

export type TelemetryProvenance =
  | {
      readonly kind: "provider-response";
      readonly authoritative: true;
      readonly capturedAt: TimestampMs;
    }
  | {
      readonly kind: "adapter-derived";
      readonly authoritative: false;
      readonly capturedAt: TimestampMs;
      readonly derivation: string;
    };

export interface ProviderResponseMetadata {
  readonly requestId?: string;
  readonly statusCode?: number;
  readonly receivedAt: TimestampMs;
  readonly retryAfterMs?: number;
  readonly providerRegion?: string;
}

export interface RateLimitPlan {
  readonly planId?: string;
  readonly displayName?: string;
  readonly tier?: "free" | "paid" | "enterprise" | "unknown";
}

export interface RateLimitWindow {
  readonly windowId: string;
  readonly dimension:
    | "requests"
    | "tokens"
    | "input_tokens"
    | "output_tokens"
    | "cost"
    | "concurrency"
    | `provider:${string}`;
  readonly window: {
    readonly kind: "fixed" | "rolling" | "concurrent" | "provider-specific";
    readonly durationMs?: number;
    readonly startedAt?: TimestampMs;
    readonly resetsAt?: TimestampMs;
  };
  readonly limit?: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly utilizationPercent?: number;
  readonly plan?: RateLimitPlan;
  readonly provenance: TelemetryProvenance;
  readonly response?: ProviderResponseMetadata;
}

export interface RateLimitStatus {
  readonly state: "within_limit" | "approaching_limit" | "limited" | "unknown";
  readonly windows?: readonly RateLimitWindow[];
}

export interface ContextWindowStatus {
  readonly state: "within_limit" | "approaching_limit" | "exceeded" | "unknown";
  readonly contextWindowTokens?: number;
  readonly usedTokens?: number;
}

export type ProviderTelemetryKind = "rate_limits" | "authentication" | "context_limits";

export interface PollTelemetryRequest extends RequestControl {
  readonly accountId: AccountId | null;
  readonly sessionId: SessionId | null;
  readonly threadId: ThreadId | null;
  readonly kinds: readonly [ProviderTelemetryKind, ...ProviderTelemetryKind[]];
}

type TelemetryUnavailableOrError =
  | { readonly state: "unavailable"; readonly availability: UnavailableCapability }
  | { readonly state: "error"; readonly error: ProviderAdapterError };

export type ProviderTelemetryResult =
  | ({ readonly kind: "rate_limits" } &
      (
        | { readonly state: "value"; readonly value: RateLimitStatus }
        | TelemetryUnavailableOrError
      ))
  | ({ readonly kind: "authentication" } &
      (
        | { readonly state: "value"; readonly value: AuthenticationStatus }
        | TelemetryUnavailableOrError
      ))
  | ({ readonly kind: "context_limits" } &
      (
        | { readonly state: "value"; readonly value: ContextWindowStatus }
        | TelemetryUnavailableOrError
      ));

export interface ProviderTelemetrySnapshot {
  readonly providerId: ProviderId;
  readonly accountId: AccountId | null;
  readonly sessionId: SessionId | null;
  readonly threadId: ThreadId | null;
  readonly capturedAt: TimestampMs;
  /** Exactly one entry is required for every requested kind. */
  readonly results: readonly [ProviderTelemetryResult, ...ProviderTelemetryResult[]];
  /** Metadata for the provider response that produced this snapshot. */
  readonly response: ProviderResponseMetadata;
}

export type UsageProvenance =
  | {
      readonly kind: "provider-reported";
      readonly authoritative: true;
      readonly reportedAt: TimestampMs;
      readonly providerRequestId?: string;
    }
  | {
      readonly kind: "adapter-estimated";
      readonly authoritative: false;
      readonly reportedAt: TimestampMs;
      readonly estimationMethod: string;
    }
  | {
      readonly kind: "aggregated";
      readonly authoritative: false;
      readonly reportedAt: TimestampMs;
      readonly sourceSessionIds: readonly SessionId[];
    };

export interface UsageTotals {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
}

export type UsageRecord = UsageTotals & {
  readonly provenance: UsageProvenance;
} &
  (
    | {
        readonly scope: "message";
        readonly identity: {
          readonly sessionId: SessionId;
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
          readonly messageId: MessageId;
        };
      }
    | {
        readonly scope: "turn";
        readonly identity: {
          readonly sessionId: SessionId;
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
        };
      }
    | {
        readonly scope: "session";
        readonly identity: {
          readonly sessionId: SessionId;
          readonly threadId: ThreadId;
        };
      }
    | {
        readonly scope: "child";
        readonly identity: {
          readonly sessionId: SessionId;
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
          readonly child: {
            readonly sessionId: SessionId;
            readonly threadId: ThreadId;
            readonly turnId: TurnId;
          };
        };
      }
    | {
        readonly scope: "aggregate";
        readonly identity: {
          readonly sessionId: SessionId;
          readonly threadId: ThreadId;
          readonly sourceSessionIds: readonly SessionId[];
        };
      }
  );

export type ProviderMessage =
  | {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly role: "user";
      readonly blocks: readonly UserMessagePart[];
      readonly state: "started" | "delta" | "completed";
    }
  | {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly role: "assistant";
      readonly blocks: readonly AssistantContentBlock[];
      readonly state: "started" | "delta" | "completed";
      readonly structuredOutput: StructuredOutputOutcome;
    }
  | {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly role: "system";
      readonly blocks: readonly TextContentBlock[];
      readonly state: "started" | "delta" | "completed";
    };

export type ProviderToolEventPayload =
  | {
      readonly state: "started" | "updated";
      readonly definition: ToolDefinition;
      readonly call: ToolCall;
      readonly result?: never;
    }
  | {
      readonly state: "completed" | "blocked" | "failed";
      readonly definition: ToolDefinition;
      readonly call: ToolCall;
      readonly result: ToolResult;
    };

export interface ProviderEventBase {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly occurredAt: TimestampMs;
  readonly session: SessionReference;
  readonly turnId?: TurnId;
}

export type ProviderEvent =
  | (ProviderEventBase & {
      readonly type: "session";
      readonly phase: "starting" | "ready" | "running" | "completed" | "interrupted" | "cancelled";
    })
  | (ProviderEventBase & {
      readonly type: "message";
      readonly message: ProviderMessage;
    })
  | (ProviderEventBase & { readonly type: "tool" } & ProviderToolEventPayload)
  | (ProviderEventBase & { readonly type: "approval_request"; readonly approval: ApprovalRequest })
  | (ProviderEventBase & { readonly type: "user_input_request"; readonly input: UserInputPrompt })
  | (ProviderEventBase & { readonly type: "usage"; readonly usage: UsageRecord })
  | (ProviderEventBase & {
      readonly type: "fallback";
      /** Must equal this event's `eventId`. */
      readonly decision: FallbackDecision;
    })
  | (ProviderEventBase & { readonly type: "rate_limit"; readonly rateLimit: RateLimitStatus })
  | (ProviderEventBase & { readonly type: "authentication"; readonly authentication: AuthenticationStatus })
  | (ProviderEventBase & { readonly type: "context_limit"; readonly context: ContextWindowStatus })
  | (ProviderEventBase & { readonly type: "cancelled"; readonly cancellationScope: "request" | "session" })
  | (ProviderEventBase & { readonly type: "error"; readonly error: ProviderAdapterError });

export type ProviderAdapterErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "operation_unavailable"
  | "cancelled"
  | "interrupted"
  | "authentication_required"
  | "authentication_expired"
  | "authorization_denied"
  | "rate_limited"
  | "context_limit_exceeded"
  | "deadline_exceeded"
  | "tool_failure"
  | "approval_denied"
  | "approval_expired"
  | "input_expired"
  | "transport_failure"
  | "provider_failure"
  | "internal";

export interface ProviderAdapterErrorBase<TCode extends ProviderAdapterErrorCode> {
  readonly code: TCode;
  readonly providerId: ProviderId;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId?: RequestId;
}

export interface InvalidRequestError extends ProviderAdapterErrorBase<"invalid_request"> {
  readonly field?: string;
}

export interface NotFoundError extends ProviderAdapterErrorBase<"not_found"> {
  readonly resource: "provider" | "account" | "model" | "session" | "message" | "approval" | "input";
  readonly resourceId?: string;
}

export interface ConflictError extends ProviderAdapterErrorBase<"conflict"> {
  readonly resource?: "session" | "approval" | "input";
}

export interface OperationUnavailableError extends ProviderAdapterErrorBase<"operation_unavailable"> {
  readonly retryable: false;
  readonly operation: ProviderOperationName;
  readonly availability: UnavailableCapability;
}

export interface CancelledError extends ProviderAdapterErrorBase<"cancelled"> {
  readonly retryable: false;
  readonly cancellationScope: "request" | "session";
}

export interface InterruptedError extends ProviderAdapterErrorBase<"interrupted"> {
  readonly retryable: false;
  readonly sessionId?: SessionId;
}

export interface AuthenticationRequiredError extends ProviderAdapterErrorBase<"authentication_required"> {
  readonly retryable: false;
  readonly accountId?: AccountId;
}

export interface AuthenticationExpiredError extends ProviderAdapterErrorBase<"authentication_expired"> {
  readonly retryable: false;
  readonly accountId?: AccountId;
  readonly expiredAt?: TimestampMs;
}

export interface AuthorizationDeniedError extends ProviderAdapterErrorBase<"authorization_denied"> {
  readonly retryable: false;
  readonly accountId?: AccountId;
}

export interface RateLimitedError extends ProviderAdapterErrorBase<"rate_limited"> {
  readonly retryable: true;
  readonly retryAfterMs?: number;
  readonly rateLimit?: RateLimitStatus;
}

export interface ContextLimitExceededError extends ProviderAdapterErrorBase<"context_limit_exceeded"> {
  readonly retryable: false;
  readonly sessionId?: SessionId;
  readonly contextWindowTokens?: number;
  readonly usedTokens?: number;
}

export interface DeadlineExceededError extends ProviderAdapterErrorBase<"deadline_exceeded"> {
  readonly retryable: true;
  readonly deadlineAt: TimestampMs;
}

export interface ToolFailureError extends ProviderAdapterErrorBase<"tool_failure"> {
  readonly retryable: false;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly failureKind: "validation" | "execution" | "provider" | "timeout" | "cancelled";
}

export interface ApprovalDeniedError extends ProviderAdapterErrorBase<"approval_denied"> {
  readonly retryable: false;
  readonly approvalId: string;
  readonly choiceId: string;
}

export interface ApprovalExpiredError extends ProviderAdapterErrorBase<"approval_expired"> {
  readonly retryable: false;
  readonly approvalId: string;
  readonly expiredAt: TimestampMs;
}

export interface InputExpiredError extends ProviderAdapterErrorBase<"input_expired"> {
  readonly retryable: false;
  readonly inputId: string;
  readonly expiredAt: TimestampMs;
}

export interface TransportFailureError extends ProviderAdapterErrorBase<"transport_failure"> {
  readonly transport?: "network" | "process" | "stream" | "ipc";
}

export interface ProviderFailureError extends ProviderAdapterErrorBase<"provider_failure"> {
  readonly providerCode?: string;
  readonly statusCode?: number;
}

export interface InternalProviderAdapterError extends ProviderAdapterErrorBase<"internal"> {
  readonly diagnosticId?: string;
}

/** A stable, exhaustive error algebra for callers and adapters. */
export type ProviderAdapterError =
  | InvalidRequestError
  | NotFoundError
  | ConflictError
  | OperationUnavailableError
  | CancelledError
  | InterruptedError
  | AuthenticationRequiredError
  | AuthenticationExpiredError
  | AuthorizationDeniedError
  | RateLimitedError
  | ContextLimitExceededError
  | DeadlineExceededError
  | ToolFailureError
  | ApprovalDeniedError
  | ApprovalExpiredError
  | InputExpiredError
  | TransportFailureError
  | ProviderFailureError
  | InternalProviderAdapterError;

export interface ProviderErrorNormalizationContext {
  readonly providerId: ProviderId;
  readonly operation: ProviderOperationName;
  readonly requestId?: RequestId;
  readonly deadlineAt?: TimestampMs;
  readonly sessionId?: SessionId;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
}

interface ProviderErrorIdentityBinding {
  readonly requestId?: RequestId;
  readonly deadlineAt?: TimestampMs;
}

export interface ProviderErrorNormalizationInput {
  readonly cause: unknown;
  readonly context: ProviderErrorNormalizationContext;
}

/** Converts every thrown/rejected value into the stable public error algebra. */
export interface ProviderErrorNormalization {
  readonly normalize: (input: ProviderErrorNormalizationInput) => ProviderAdapterError;
}

const providerEventEvidenceBoundary: unique symbol = Symbol("provider-event-evidence-boundary");
const recordedFallbackEvents: unique symbol = Symbol("recorded-fallback-events");

interface ProviderEventEvidenceRegistration {
  readonly providerId: ProviderId;
  readonly fallbackEvents: WeakMap<object, FallbackVisibilityEvent>;
}

const providerEventEvidenceRegistrations = new WeakMap<object, ProviderEventEvidenceRegistration>();

export interface ProviderEventEvidence<TProviderId extends ProviderId> {
  readonly providerId: TProviderId;
  readonly [providerEventEvidenceBoundary]: true;
  readonly [recordedFallbackEvents]: WeakMap<object, FallbackVisibilityEvent>;
}

export function createProviderEventEvidence<TProviderId extends ProviderId>(options: {
  readonly providerId: TProviderId;
}): ProviderEventEvidence<TProviderId> {
  const providerId = options.providerId;
  if (!isBoundedIdentifier(providerId)) {
    throw new TypeError("Provider event evidence requires a bounded display-safe provider id.");
  }
  const fallbackEvents = new WeakMap<object, FallbackVisibilityEvent>();
  const evidence = Object.freeze({
    providerId,
    [providerEventEvidenceBoundary]: true as const,
    [recordedFallbackEvents]: fallbackEvents,
  });
  providerEventEvidenceRegistrations.set(
    evidence,
    Object.freeze({ providerId, fallbackEvents }),
  );
  return evidence;
}

function providerEventEvidenceRegistration(
  value: unknown,
): ProviderEventEvidenceRegistration | undefined {
  return typeof value === "object" && value !== null
    ? providerEventEvidenceRegistrations.get(value)
    : undefined;
}

export interface CreateProviderOperationOptions<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
  TResult,
> {
  readonly providerId: TProviderId;
  readonly operation: TOperation;
  readonly eventEvidence: ProviderEventEvidence<TProviderId>;
  readonly availability?: AvailableCapability;
  readonly errorNormalization: ProviderErrorNormalization;
  readonly context?: (
    request: TRequest,
  ) => Omit<ProviderErrorNormalizationContext, "providerId" | "operation">;
  /** Required at runtime for provider-specific extension success values. */
  readonly resultValidator?: (value: unknown, request: TRequest) => value is TResult;
  readonly execute: (
    request: TRequest,
  ) => ProviderAdapterResult<TResult> | PromiseLike<ProviderAdapterResult<TResult>>;
}

const stableErrorCodes: ReadonlySet<ProviderAdapterErrorCode> = new Set([
  "invalid_request",
  "not_found",
  "conflict",
  "operation_unavailable",
  "cancelled",
  "interrupted",
  "authentication_required",
  "authentication_expired",
  "authorization_denied",
  "rate_limited",
  "context_limit_exceeded",
  "deadline_exceeded",
  "tool_failure",
  "approval_denied",
  "approval_expired",
  "input_expired",
  "transport_failure",
  "provider_failure",
  "internal",
]);

const coreProviderOperations: ReadonlySet<CoreProviderOperationName> = new Set([
  "discover_providers",
  "resolve_adapter",
  "discover_accounts",
  "discover_models",
  "start",
  "resume",
  "fork",
  "send",
  "submit_tool_result",
  "interrupt",
  "events",
  "poll_telemetry",
  "respond_to_approval",
  "respond_to_user_input",
]);

const unavailableReasons: ReadonlySet<CapabilityUnavailableReason> = new Set([
  "not_supported_by_provider",
  "not_available_for_account",
  "not_available_for_model",
  "disabled_by_policy",
  "not_implemented",
  "temporarily_unavailable",
]);

function isProviderOperationName(value: unknown): value is ProviderOperationName {
  return (
    (typeof value === "string" && coreProviderOperations.has(value as CoreProviderOperationName)) ||
    (typeof value === "string" && /^extension:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function providerErrorIdentityBinding(value: unknown): ProviderErrorIdentityBinding {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze({
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    ...(isFiniteNumber(value.deadlineAt) ? { deadlineAt: value.deadlineAt } : {}),
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (isFiniteNumber(value)) return true;
  if (depth > 64 || typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen, depth + 1))
    : Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || (isRecord(value) && isJsonValue(value));
}

function isExecutionTarget(value: unknown): value is ExecutionTarget {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["providerId", "accountId", "modelId"], ["providerId"]) &&
    typeof value.providerId === "string" &&
    optionalString(value.accountId) &&
    optionalString(value.modelId)
  );
}

function isUnavailableCapability(value: unknown): value is UnavailableCapability {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["state", "reason", "message"], ["state", "reason"]) &&
    value.state === "unavailable" &&
    unavailableReasons.has(value.reason as CapabilityUnavailableReason) &&
    (value.message === undefined || isUserVisibleCapabilityText(value.message))
  );
}

function isFallbackPolicy(value: unknown): value is FallbackPolicy {
  if (!isRecord(value)) return false;
  if (value.mode === "forbid") return hasExactOwnKeys(value, ["mode"]);
  if (
    value.mode !== "allow" ||
    !hasExactOwnKeys(value, ["mode", "scopes", "confirmation", "allowedTargets"], [
      "mode",
      "scopes",
      "confirmation",
    ]) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => ["provider", "account", "model"].includes(scope as string)) ||
    !["always", "on-provider-change", "never"].includes(value.confirmation as string)
  ) {
    return false;
  }
  return (
    value.allowedTargets === undefined ||
    (Array.isArray(value.allowedTargets) && value.allowedTargets.every(isExecutionTarget))
  );
}

function isFallbackDecision(value: unknown): value is FallbackDecision {
  if (!isRecord(value) || !isRecord(value.notice) || !isFallbackPolicy(value.policy)) return false;
  return (
    hasExactOwnKeys(value, [
      "decisionId",
      "visibleEventId",
      "decidedAt",
      "reason",
      "policy",
      "confirmation",
      "requested",
      "resolved",
      "notice",
    ]) &&
    value.policy.mode === "allow" &&
    typeof value.decisionId === "string" &&
    typeof value.visibleEventId === "string" &&
    isFiniteNumber(value.decidedAt) &&
    [
      "account_unavailable",
      "model_unavailable",
      "rate_limited",
      "authentication_expired",
      "context_limit",
      "provider_unavailable",
      "policy",
      "user_selected",
    ].includes(value.reason as string) &&
    isExecutionTarget(value.requested) &&
    isExecutionTarget(value.resolved) &&
    hasExactOwnKeys(value.notice, ["visibility", "title", "message"]) &&
    value.notice.visibility === "required" &&
    typeof value.notice.title === "string" &&
    typeof value.notice.message === "string" &&
    isRecord(value.confirmation) &&
    hasValidFallbackConfirmation(value as unknown as FallbackDecision)
  );
}

function isTargetResolution(value: unknown): value is TargetResolution {
  if (!isRecord(value)) return false;
  if (value.kind === "exact") {
    return hasExactOwnKeys(value, ["kind", "target"]) && isExecutionTarget(value.target);
  }
  return (
    value.kind === "fallback" &&
    hasExactOwnKeys(value, ["kind", "requested", "resolved", "decision"]) &&
    isExecutionTarget(value.requested) &&
    isExecutionTarget(value.resolved) &&
    isFallbackDecision(value.decision)
  );
}

function isAuthenticationStatus(value: unknown): value is AuthenticationStatus {
  const method = isRecord(value) ? value.method : undefined;
  const mode = isRecord(value) ? value.mode : undefined;
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["state", "method", "mode", "expiresAt"], ["state", "method", "mode"]) &&
    ["valid", "expiring", "expired", "required", "unknown"].includes(value.state as string) &&
    ((typeof method === "string" &&
      ["api_key", "oauth", "subscription", "service_account", "unknown"].includes(method)) ||
      (typeof method === "string" && /^provider:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(method))) &&
    ((typeof mode === "string" &&
      ["interactive", "headless", "external", "managed", "unknown"].includes(mode)) ||
      (typeof mode === "string" && /^provider:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(mode))) &&
    optionalNumber(value.expiresAt)
  );
}

function isProviderResponseMetadata(value: unknown): value is ProviderResponseMetadata {
  return (
    isRecord(value) &&
    hasExactOwnKeys(
      value,
      ["requestId", "statusCode", "receivedAt", "retryAfterMs", "providerRegion"],
      ["receivedAt"],
    ) &&
    optionalString(value.requestId) &&
    optionalNumber(value.statusCode) &&
    isFiniteNumber(value.receivedAt) &&
    optionalNumber(value.retryAfterMs) &&
    optionalString(value.providerRegion)
  );
}

function isRateLimitStatus(value: unknown): value is RateLimitStatus {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["state", "windows"], ["state"]) ||
    !["within_limit", "approaching_limit", "limited", "unknown"].includes(value.state as string)
  ) {
    return false;
  }
  if (value.windows === undefined) return true;
  return (
    Array.isArray(value.windows) &&
    value.windows.every(
      (window) => {
        if (
          !isRecord(window) ||
          !hasExactOwnKeys(
            window,
            [
              "windowId",
              "dimension",
              "window",
              "limit",
              "used",
              "remaining",
              "utilizationPercent",
              "plan",
              "provenance",
              "response",
            ],
            ["windowId", "dimension", "window", "provenance"],
          ) ||
          !isRecord(window.window) ||
          !hasExactOwnKeys(
            window.window,
            ["kind", "durationMs", "startedAt", "resetsAt"],
            ["kind"],
          ) ||
          !isRecord(window.provenance)
        ) return false;
        const dimension = window.dimension;
        const validDimension =
          (typeof dimension === "string" &&
            ["requests", "tokens", "input_tokens", "output_tokens", "cost", "concurrency"].includes(
              dimension,
            )) ||
          (typeof dimension === "string" && /^provider:[a-zA-Z0-9]/.test(dimension));
        const provenanceValid =
          (window.provenance.kind === "provider-response" &&
            hasExactOwnKeys(window.provenance, ["kind", "authoritative", "capturedAt"]) &&
            window.provenance.authoritative === true &&
            isFiniteNumber(window.provenance.capturedAt)) ||
          (window.provenance.kind === "adapter-derived" &&
            hasExactOwnKeys(window.provenance, ["kind", "authoritative", "capturedAt", "derivation"]) &&
            window.provenance.authoritative === false &&
            isFiniteNumber(window.provenance.capturedAt) &&
            typeof window.provenance.derivation === "string");
        return (
          typeof window.windowId === "string" &&
          validDimension &&
          ["fixed", "rolling", "concurrent", "provider-specific"].includes(
            window.window.kind as string,
          ) &&
          optionalNumber(window.window.durationMs) &&
          optionalNumber(window.window.startedAt) &&
          optionalNumber(window.window.resetsAt) &&
          optionalNumber(window.limit) &&
          optionalNumber(window.used) &&
          optionalNumber(window.remaining) &&
          optionalNumber(window.utilizationPercent) &&
          (window.plan === undefined ||
            (isRecord(window.plan) &&
              hasExactOwnKeys(
                window.plan,
                ["planId", "displayName", "tier"],
                [],
              ) &&
              optionalString(window.plan.planId) &&
              optionalString(window.plan.displayName) &&
              (window.plan.tier === undefined ||
                ["free", "paid", "enterprise", "unknown"].includes(window.plan.tier as string)))) &&
          provenanceValid &&
          (window.response === undefined || isProviderResponseMetadata(window.response))
        );
      },
    )
  );
}

function isContextWindowStatus(value: unknown): value is ContextWindowStatus {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["state", "contextWindowTokens", "usedTokens"], ["state"]) &&
    ["within_limit", "approaching_limit", "exceeded", "unknown"].includes(value.state as string) &&
    optionalNumber(value.contextWindowTokens) &&
    optionalNumber(value.usedTokens)
  );
}

function isProviderTelemetryKind(value: unknown): value is ProviderTelemetryKind {
  return ["rate_limits", "authentication", "context_limits"].includes(value as string);
}

function isStructuredOutputResult(value: unknown): value is StructuredOutputResult {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["schemaName", "value", "validation"]) ||
    typeof value.schemaName !== "string" ||
    !isJsonValue(value.value)
  ) return false;
  if (!isRecord(value.validation)) return false;
  return (
    (value.validation.state === "valid" && hasExactOwnKeys(value.validation, ["state"])) ||
    (value.validation.state === "invalid" &&
      hasExactOwnKeys(value.validation, ["state", "issues"]) &&
      Array.isArray(value.validation.issues) &&
      value.validation.issues.every(
        (issue) =>
          isRecord(issue) &&
          hasExactOwnKeys(issue, ["path", "message"]) &&
          Array.isArray(issue.path) &&
          issue.path.every((part) => typeof part === "string" || isNonnegativeInteger(part)) &&
          typeof issue.message === "string",
      ))
  );
}

function isSessionReference(value: unknown): value is SessionReference {
  return (
    isRecord(value) &&
    hasExactOwnKeys(
      value,
      ["sessionId", "threadId", "providerId", "accountId", "modelId", "activeTurnId"],
      ["sessionId", "threadId", "providerId", "accountId"],
    ) &&
    typeof value.sessionId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.providerId === "string" &&
    typeof value.accountId === "string" &&
    optionalString(value.modelId) &&
    optionalString(value.activeTurnId)
  );
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    isRecord(value) &&
    hasExactOwnKeys(
      value,
      ["name", "description", "inputSchema", "outputSchema", "providerSpecific"],
      ["name", "inputSchema", "providerSpecific"],
    ) &&
    typeof value.name === "string" &&
    optionalString(value.description) &&
    isJsonSchema(value.inputSchema) &&
    (value.outputSchema === undefined || isJsonSchema(value.outputSchema)) &&
    isRecord(value.providerSpecific) &&
    isJsonValue(value.providerSpecific)
  );
}

function isToolCall(value: unknown): value is ToolCall {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["toolCallId", "toolName", "blockIndex", "arguments"]) ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !isNonnegativeInteger(value.blockIndex) ||
    !isRecord(value.arguments) ||
    typeof value.arguments.text !== "string"
  ) {
    return false;
  }
  if (value.arguments.state === "partial") {
    return (
      hasExactOwnKeys(value.arguments, ["state", "text", "parsed"], ["state", "text"]) &&
      (value.arguments.parsed === undefined || isJsonValue(value.arguments.parsed))
    );
  }
  if (value.arguments.state === "complete") {
    return (
      hasExactOwnKeys(value.arguments, ["state", "text", "value"]) &&
      isRecord(value.arguments.value) &&
      isJsonValue(value.arguments.value)
    );
  }
  return (
    value.arguments.state === "invalid" &&
    hasExactOwnKeys(value.arguments, ["state", "text", "message"]) &&
    typeof value.arguments.message === "string"
  );
}

function isToolResult(
  value: unknown,
  providerId: ProviderId,
  binding: ProviderErrorIdentityBinding,
): value is ToolResult {
  if (
    !isRecord(value) ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !isNonnegativeInteger(value.blockIndex) ||
    !isFiniteNumber(value.startedAt) ||
    !isFiniteNumber(value.completedAt)
  ) {
    return false;
  }
  const baseFields = ["toolCallId", "toolName", "blockIndex", "startedAt", "completedAt", "state"];
  if (value.state === "success") {
    return hasExactOwnKeys(value, [...baseFields, "output"]) && isJsonValue(value.output);
  }
  if (value.state === "error") {
    return (
      hasExactOwnKeys(value, [...baseFields, "output", "error"], [...baseFields, "error"]) &&
      (value.output === undefined || isJsonValue(value.output)) &&
      isStableProviderErrorWithBinding(value.error, providerId, binding)
    );
  }
  return (
    value.state === "cancel" &&
    hasExactOwnKeys(value, [...baseFields, "error"], baseFields) &&
    (value.error === undefined ||
      (isStableProviderErrorWithBinding(value.error, providerId, binding) &&
        value.error.code === "cancelled"))
  );
}

function isAssistantContentBlock(value: unknown): value is AssistantContentBlock {
  if (!isRecord(value) || !isNonnegativeInteger(value.index)) return false;
  if (value.type === "text") {
    return hasExactOwnKeys(value, ["type", "text", "index"]) && typeof value.text === "string";
  }
  if (value.type === "thinking") {
    return (
      hasExactOwnKeys(value, ["type", "index", "text", "visibility", "providerSpecific"]) &&
      typeof value.text === "string" &&
      ["collapsed", "expanded", "hidden"].includes(value.visibility as string) &&
      isRecord(value.providerSpecific) &&
      isJsonValue(value.providerSpecific)
    );
  }
  if (value.type === "refusal") {
    return (
      hasExactOwnKeys(value, ["type", "index", "message", "reasonCode"], ["type", "index", "message"]) &&
      typeof value.message === "string" &&
      optionalString(value.reasonCode)
    );
  }
  return (
    value.type === "tool_call" &&
    hasExactOwnKeys(value, ["type", "index", "call"]) &&
    isToolCall(value.call) &&
    value.call.blockIndex === value.index
  );
}

function isUserMessagePart(value: unknown): value is UserMessagePart {
  if (!isRecord(value)) return false;
  if (value.type === "text") {
    return hasExactOwnKeys(value, ["type", "text"]) && typeof value.text === "string";
  }
  if (value.type === "image") {
    return (
      hasExactOwnKeys(value, ["type", "uri", "mediaType"], ["type", "uri"]) &&
      typeof value.uri === "string" &&
      optionalString(value.mediaType)
    );
  }
  return (
    value.type === "file" &&
    hasExactOwnKeys(value, ["type", "uri", "name", "mediaType"], ["type", "uri"]) &&
    typeof value.uri === "string" &&
    optionalString(value.name) &&
    optionalString(value.mediaType)
  );
}

function isProviderMessage(value: unknown): value is ProviderMessage {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.turnId !== "string" ||
    !["started", "delta", "completed"].includes(value.state as string) ||
    !Array.isArray(value.blocks)
  ) {
    return false;
  }
  if (value.role === "assistant") {
    return (
      hasExactOwnKeys(value, ["messageId", "turnId", "role", "blocks", "state", "structuredOutput"]) &&
      value.blocks.every(
        (block, index) => isAssistantContentBlock(block) && block.index === index,
      ) && isStructuredOutputOutcome(value.structuredOutput)
    );
  }
  if (value.role === "user") {
    return (
      hasExactOwnKeys(value, ["messageId", "turnId", "role", "blocks", "state"]) &&
      value.blocks.every(isUserMessagePart)
    );
  }
  return (
    value.role === "system" &&
    hasExactOwnKeys(value, ["messageId", "turnId", "role", "blocks", "state"]) &&
    value.blocks.every(
      (block) =>
        isRecord(block) &&
        hasExactOwnKeys(block, ["type", "text"]) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
  );
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  if (!isRecord(value) || !isRecord(value.subject)) return false;
  const subject = value.subject;
  const subjectValid =
    (subject.kind === "command" &&
      hasExactOwnKeys(subject, ["kind", "command"]) &&
      isRecord(subject.command) &&
      hasExactOwnKeys(
        subject.command,
        ["program", "arguments", "cwd", "environmentKeys"],
        ["program", "arguments", "cwd"],
      ) &&
      typeof subject.command.program === "string" &&
      Array.isArray(subject.command.arguments) &&
      subject.command.arguments.every((argument) => typeof argument === "string") &&
      typeof subject.command.cwd === "string" &&
      (subject.command.environmentKeys === undefined ||
        (Array.isArray(subject.command.environmentKeys) &&
          subject.command.environmentKeys.every((key) => typeof key === "string")))) ||
    (subject.kind === "diff" &&
      hasExactOwnKeys(subject, ["kind", "patch", "files"]) &&
      typeof subject.patch === "string" &&
      Array.isArray(subject.files) &&
      subject.files.every((file) => typeof file === "string")) ||
    (subject.kind === "policy" &&
      hasExactOwnKeys(subject, ["kind", "policyId", "rule", "scope"]) &&
      typeof subject.policyId === "string" &&
      typeof subject.rule === "string" &&
      ["request", "turn", "session", "workspace"].includes(subject.scope as string)) ||
    (subject.kind === "tool" &&
      hasExactOwnKeys(subject, ["kind", "definition", "call"]) &&
      isToolDefinition(subject.definition) &&
      isToolCall(subject.call));
  return (
    hasExactOwnKeys(value, ["approvalId", "title", "message", "expiresAt", "subject", "choices"]) &&
    typeof value.approvalId === "string" &&
    typeof value.title === "string" &&
    typeof value.message === "string" &&
    (value.expiresAt === null || isFiniteNumber(value.expiresAt)) &&
    subjectValid &&
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    value.choices.every(
      (choice) => {
        if (
          !isRecord(choice) ||
          !hasExactOwnKeys(
            choice,
            ["choiceId", "label", "action", "scope", "options", "policyPatch", "amendmentSchema"],
            ["choiceId", "label", "action", "scope"],
          )
        ) return false;
        const optionsValid =
          choice.options === undefined ||
          (Array.isArray(choice.options) &&
            choice.options.every(
              (option) =>
                isRecord(option) &&
                hasExactOwnKeys(
                  option,
                  ["optionId", "label", "value", "selectedByDefault"],
                  ["optionId", "label", "value"],
                ) &&
                typeof option.optionId === "string" &&
                typeof option.label === "string" &&
                isJsonValue(option.value) &&
                (option.selectedByDefault === undefined ||
                  typeof option.selectedByDefault === "boolean"),
            ));
        return (
          typeof choice.choiceId === "string" &&
          typeof choice.label === "string" &&
          ["approve", "deny", "cancel", "amend"].includes(choice.action as string) &&
          ["once", "turn", "session", "policy"].includes(choice.scope as string) &&
          optionsValid &&
          (choice.policyPatch === undefined ||
            (isRecord(choice.policyPatch) && isJsonValue(choice.policyPatch))) &&
          (choice.action === "amend"
            ? isJsonSchema(choice.amendmentSchema)
            : choice.amendmentSchema === undefined)
        );
      },
    )
  );
}

function isUserInputPrompt(value: unknown): value is UserInputPrompt {
  return (
    isRecord(value) &&
    hasExactOwnKeys(
      value,
      ["inputId", "title", "message", "expiresAt", "allowCancel", "questions"],
      ["inputId", "title", "expiresAt", "allowCancel", "questions"],
    ) &&
    typeof value.inputId === "string" &&
    typeof value.title === "string" &&
    optionalString(value.message) &&
    (value.expiresAt === null || isFiniteNumber(value.expiresAt)) &&
    typeof value.allowCancel === "boolean" &&
    Array.isArray(value.questions) &&
    value.questions.length > 0 &&
    value.questions.every(
      (question) => {
        if (
          !isRecord(question) ||
          typeof question.questionId !== "string" ||
          typeof question.label !== "string" ||
          typeof question.required !== "boolean"
        ) {
          return false;
        }
        if (question.kind === "text") {
          return (
            hasExactOwnKeys(
              question,
              ["questionId", "kind", "label", "required", "placeholder", "initialValue"],
              ["questionId", "kind", "label", "required"],
            ) &&
            optionalString(question.placeholder) &&
            optionalString(question.initialValue)
          );
        }
        if (question.kind === "editor") {
          return (
            hasExactOwnKeys(
              question,
              ["questionId", "kind", "label", "required", "language", "initialValue"],
              ["questionId", "kind", "label", "required"],
            ) &&
            optionalString(question.language) &&
            optionalString(question.initialValue)
          );
        }
        if (question.kind === "confirm") {
          return (
            hasExactOwnKeys(
              question,
              ["questionId", "kind", "label", "required", "initialValue"],
              ["questionId", "kind", "label", "required"],
            ) &&
            (question.initialValue === undefined || typeof question.initialValue === "boolean")
          );
        }
        return (
          question.kind === "select" &&
          hasExactOwnKeys(
            question,
            ["questionId", "kind", "label", "required", "selection", "options"],
          ) &&
          ["single", "multiple"].includes(question.selection as string) &&
          Array.isArray(question.options) &&
          question.options.length > 0 &&
          question.options.every(
            (option) =>
              isRecord(option) &&
              hasExactOwnKeys(
                option,
                ["optionId", "label", "value", "description"],
                ["optionId", "label", "value"],
              ) &&
              typeof option.optionId === "string" &&
              typeof option.label === "string" &&
              isJsonValue(option.value) &&
              optionalString(option.description),
          )
        );
      },
    )
  );
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(
      value,
      [
        "scope",
        "identity",
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "cacheWriteTokens",
        "totalTokens",
        "cost",
        "provenance",
      ],
      ["scope", "identity", "totalTokens", "provenance"],
    ) ||
    !isRecord(value.identity) ||
    !isRecord(value.provenance)
  ) return false;
  const identity = value.identity;
  const baseIdentity =
    typeof identity.sessionId === "string" && typeof identity.threadId === "string";
  const identityValid =
    baseIdentity &&
    ((value.scope === "message" &&
      hasExactOwnKeys(identity, ["sessionId", "threadId", "turnId", "messageId"]) &&
      typeof identity.turnId === "string" &&
      typeof identity.messageId === "string") ||
      (value.scope === "turn" &&
        hasExactOwnKeys(identity, ["sessionId", "threadId", "turnId"]) &&
        typeof identity.turnId === "string") ||
      (value.scope === "session" && hasExactOwnKeys(identity, ["sessionId", "threadId"])) ||
      (value.scope === "child" &&
        hasExactOwnKeys(identity, ["sessionId", "threadId", "turnId", "child"]) &&
        typeof identity.turnId === "string" &&
        isRecord(identity.child) &&
        hasExactOwnKeys(identity.child, ["sessionId", "threadId", "turnId"]) &&
        typeof identity.child.sessionId === "string" &&
        typeof identity.child.threadId === "string" &&
        typeof identity.child.turnId === "string") ||
      (value.scope === "aggregate" &&
        hasExactOwnKeys(identity, ["sessionId", "threadId", "sourceSessionIds"]) &&
        Array.isArray(identity.sourceSessionIds) &&
        identity.sourceSessionIds.every((id) => typeof id === "string")));
  const provenanceValid =
    (value.provenance.kind === "provider-reported" &&
      hasExactOwnKeys(
        value.provenance,
        ["kind", "authoritative", "reportedAt", "providerRequestId"],
        ["kind", "authoritative", "reportedAt"],
      ) &&
      value.provenance.authoritative === true &&
      isFiniteNumber(value.provenance.reportedAt) &&
      optionalString(value.provenance.providerRequestId)) ||
    (value.provenance.kind === "adapter-estimated" &&
      hasExactOwnKeys(
        value.provenance,
        ["kind", "authoritative", "reportedAt", "estimationMethod"],
      ) &&
      value.provenance.authoritative === false &&
      isFiniteNumber(value.provenance.reportedAt) &&
      typeof value.provenance.estimationMethod === "string") ||
    (value.provenance.kind === "aggregated" &&
      hasExactOwnKeys(
        value.provenance,
        ["kind", "authoritative", "reportedAt", "sourceSessionIds"],
      ) &&
      value.provenance.authoritative === false &&
      isFiniteNumber(value.provenance.reportedAt) &&
      Array.isArray(value.provenance.sourceSessionIds) &&
      value.provenance.sourceSessionIds.every((id) => typeof id === "string"));
  return (
    ["message", "turn", "session", "child", "aggregate"].includes(value.scope as string) &&
    identityValid &&
    optionalNumber(value.inputTokens) &&
    optionalNumber(value.outputTokens) &&
    optionalNumber(value.reasoningTokens) &&
    optionalNumber(value.cachedInputTokens) &&
    optionalNumber(value.cacheWriteTokens) &&
    isFiniteNumber(value.totalTokens) &&
    (value.cost === undefined ||
      (isRecord(value.cost) &&
        hasExactOwnKeys(value.cost, ["amount", "currency"]) &&
        isFiniteNumber(value.cost.amount) &&
        typeof value.cost.currency === "string")) &&
    provenanceValid
  );
}

function isProviderEvent(
  value: unknown,
  providerId: ProviderId,
  binding: ProviderErrorIdentityBinding,
): value is ProviderEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    !isNonnegativeInteger(value.sequence) ||
    !isFiniteNumber(value.occurredAt) ||
    !isSessionReference(value.session) ||
    !optionalString(value.turnId)
  ) {
    return false;
  }
  const eventFields = ["type", "eventId", "sequence", "occurredAt", "session", "turnId"];
  const requiredEventFields = ["type", "eventId", "sequence", "occurredAt", "session"];
  const hasEventFields = (payloadFields: readonly string[]) =>
    hasExactOwnKeys(
      value,
      [...eventFields, ...payloadFields],
      [...requiredEventFields, ...payloadFields],
    );
  switch (value.type) {
    case "session":
      return (
        hasEventFields(["phase"]) &&
        ["starting", "ready", "running", "completed", "interrupted", "cancelled"].includes(
          value.phase as string,
        )
      );
    case "message":
      return hasEventFields(["message"]) && isProviderMessage(value.message) &&
        (value.turnId === undefined || value.message.turnId === value.turnId);
    case "tool":
      return (
        hasExactOwnKeys(
          value,
          [...eventFields, "state", "definition", "call", "result"],
          [
            ...requiredEventFields,
            "state",
            "definition",
            "call",
            ...(["started", "updated"].includes(value.state as string) ? [] : ["result"]),
          ],
        ) &&
        ["started", "updated", "completed", "blocked", "failed"].includes(value.state as string) &&
        isToolDefinition(value.definition) &&
        isToolCall(value.call) &&
        value.definition.name === value.call.toolName &&
        (["started", "updated"].includes(value.state as string)
          ? value.result === undefined
          : isToolResult(value.result, providerId, binding) &&
            value.result.toolCallId === value.call.toolCallId &&
            value.result.toolName === value.call.toolName)
      );
    case "approval_request":
      return hasEventFields(["approval"]) && isApprovalRequest(value.approval);
    case "user_input_request":
      return hasEventFields(["input"]) && isUserInputPrompt(value.input);
    case "usage":
      return hasEventFields(["usage"]) && isUsageRecord(value.usage);
    case "fallback":
      return (
        hasEventFields(["decision"]) &&
        isFallbackDecision(value.decision) &&
        value.decision.visibleEventId === value.eventId &&
        value.session.providerId === value.decision.resolved.providerId
      );
    case "rate_limit":
      return hasEventFields(["rateLimit"]) && isRateLimitStatus(value.rateLimit);
    case "authentication":
      return hasEventFields(["authentication"]) && isAuthenticationStatus(value.authentication);
    case "context_limit":
      return hasEventFields(["context"]) && isContextWindowStatus(value.context);
    case "cancelled":
      return hasEventFields(["cancellationScope"]) &&
        ["request", "session"].includes(value.cancellationScope as string);
    case "error":
      return hasEventFields(["error"]) &&
        isStableProviderErrorWithBinding(value.error, providerId, binding);
    default:
      return false;
  }
}

function isStableProviderError(value: unknown, providerId: ProviderId): value is ProviderAdapterError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasStableBase =
    typeof candidate.code === "string" &&
    stableErrorCodes.has(candidate.code as ProviderAdapterErrorCode) &&
    candidate.providerId === providerId &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.requestId === undefined || typeof candidate.requestId === "string");
  if (!hasStableBase) return false;

  const baseFields = ["code", "providerId", "message", "retryable", "requestId"] as const;
  const requiredBaseFields = ["code", "providerId", "message", "retryable"] as const;
  const hasClosedFields = (
    optionalFields: readonly string[] = [],
    requiredFields: readonly string[] = [],
  ) =>
    hasExactOwnKeys(
      candidate,
      [...baseFields, ...optionalFields],
      [...requiredBaseFields, ...requiredFields],
    );

  const hasOptionalString = (key: string) =>
    candidate[key] === undefined || typeof candidate[key] === "string";
  const hasOptionalNumber = (key: string) =>
    candidate[key] === undefined || isFiniteNumber(candidate[key]);

  switch (candidate.code as ProviderAdapterErrorCode) {
    case "invalid_request":
      return hasClosedFields(["field"]) && hasOptionalString("field");
    case "not_found":
      return (
        hasClosedFields(["resource", "resourceId"], ["resource"]) &&
        ["provider", "account", "model", "session", "message", "approval", "input"].includes(
          candidate.resource as string,
        ) && hasOptionalString("resourceId")
      );
    case "conflict":
      return (
        hasClosedFields(["resource"]) &&
        (candidate.resource === undefined ||
          ["session", "approval", "input"].includes(candidate.resource as string))
      );
    case "operation_unavailable": {
      return (
        hasClosedFields(["operation", "availability"], ["operation", "availability"]) &&
        candidate.retryable === false &&
        isUserVisibleCapabilityText(candidate.message) &&
        isProviderOperationName(candidate.operation) &&
        isUnavailableCapability(candidate.availability)
      );
    }
    case "cancelled":
      return (
        hasClosedFields(["cancellationScope"], ["cancellationScope"]) &&
        candidate.retryable === false &&
        ["request", "session"].includes(candidate.cancellationScope as string)
      );
    case "interrupted":
      return hasClosedFields(["sessionId"]) && candidate.retryable === false && hasOptionalString("sessionId");
    case "authentication_required":
    case "authorization_denied":
      return hasClosedFields(["accountId"]) && candidate.retryable === false && hasOptionalString("accountId");
    case "authentication_expired":
      return (
        hasClosedFields(["accountId", "expiredAt"]) &&
        candidate.retryable === false && hasOptionalString("accountId") && hasOptionalNumber("expiredAt")
      );
    case "rate_limited":
      return (
        hasClosedFields(["retryAfterMs", "rateLimit"]) &&
        candidate.retryable === true &&
        hasOptionalNumber("retryAfterMs") &&
        (candidate.rateLimit === undefined || isRateLimitStatus(candidate.rateLimit))
      );
    case "context_limit_exceeded":
      return (
        hasClosedFields(["sessionId", "contextWindowTokens", "usedTokens"]) &&
        candidate.retryable === false &&
        hasOptionalString("sessionId") &&
        hasOptionalNumber("contextWindowTokens") &&
        hasOptionalNumber("usedTokens")
      );
    case "deadline_exceeded":
      return (
        hasClosedFields(["deadlineAt"], ["deadlineAt"]) &&
        candidate.retryable === true &&
        typeof candidate.deadlineAt === "number"
      );
    case "tool_failure":
      return (
        hasClosedFields(["toolCallId", "toolName", "failureKind"], [
          "toolCallId",
          "toolName",
          "failureKind",
        ]) &&
        candidate.retryable === false &&
        typeof candidate.toolCallId === "string" &&
        typeof candidate.toolName === "string" &&
        ["validation", "execution", "provider", "timeout", "cancelled"].includes(
          candidate.failureKind as string,
        )
      );
    case "approval_denied":
      return (
        hasClosedFields(["approvalId", "choiceId"], ["approvalId", "choiceId"]) &&
        candidate.retryable === false &&
        typeof candidate.approvalId === "string" &&
        typeof candidate.choiceId === "string"
      );
    case "approval_expired":
      return (
        hasClosedFields(["approvalId", "expiredAt"], ["approvalId", "expiredAt"]) &&
        candidate.retryable === false &&
        typeof candidate.approvalId === "string" &&
        isFiniteNumber(candidate.expiredAt)
      );
    case "input_expired":
      return (
        hasClosedFields(["inputId", "expiredAt"], ["inputId", "expiredAt"]) &&
        candidate.retryable === false &&
        typeof candidate.inputId === "string" &&
        isFiniteNumber(candidate.expiredAt)
      );
    case "transport_failure":
      return (
        hasClosedFields(["transport"]) &&
        (candidate.transport === undefined ||
          ["network", "process", "stream", "ipc"].includes(candidate.transport as string))
      );
    case "provider_failure":
      return (
        hasClosedFields(["providerCode", "statusCode"]) &&
        hasOptionalString("providerCode") &&
        hasOptionalNumber("statusCode")
      );
    case "internal":
      return hasClosedFields(["diagnosticId"]) && hasOptionalString("diagnosticId");
  }
}

function isStableProviderErrorWithBinding(
  value: unknown,
  providerId: ProviderId,
  binding: ProviderErrorIdentityBinding,
): value is ProviderAdapterError {
  return (
    isStableProviderError(value, providerId) &&
    value.requestId === binding.requestId &&
    (value.code !== "deadline_exceeded" ||
      (binding.deadlineAt !== undefined && value.deadlineAt === binding.deadlineAt))
  );
}

function isStableProviderErrorForOperation(
  value: unknown,
  providerId: ProviderId,
  operation: ProviderOperationName,
  binding: ProviderErrorIdentityBinding = {},
): value is ProviderAdapterError {
  return (
    isStableProviderErrorWithBinding(value, providerId, binding) &&
    (value.code !== "operation_unavailable" || value.operation === operation)
  );
}

function hasValidFallbackConfirmation(decision: FallbackDecision): boolean {
  const providerChanged = decision.requested.providerId !== decision.resolved.providerId;
  if (decision.confirmation.kind === "user_confirmed") {
    return (
      hasExactOwnKeys(decision.confirmation, [
        "kind",
        "confirmationId",
        "confirmedAt",
        "confirmedBy",
      ]) &&
      decision.confirmation.confirmedBy === "user" &&
      typeof decision.confirmation.confirmationId === "string" &&
      decision.confirmation.confirmationId.length > 0 &&
      Number.isFinite(decision.confirmation.confirmedAt)
    );
  }
  if (!hasExactOwnKeys(decision.confirmation, ["kind", "reason"])) return false;
  if (decision.policy.confirmation === "always") return false;
  if (decision.policy.confirmation === "never") {
    return decision.confirmation.reason === "policy_never";
  }
  return !providerChanged && decision.confirmation.reason === "provider_unchanged";
}

function telemetryResultMatchesKind(
  result: unknown,
  providerId: ProviderId,
  binding: ProviderErrorIdentityBinding,
): boolean {
  if (!isRecord(result) || !isProviderTelemetryKind(result.kind)) return false;
  if (result.state === "error") {
    return (
      hasExactOwnKeys(result, ["kind", "state", "error"]) &&
      isStableProviderErrorWithBinding(result.error, providerId, binding) &&
      result.availability === undefined &&
      result.value === undefined
    );
  }
  if (result.state === "unavailable") {
    return (
      hasExactOwnKeys(result, ["kind", "state", "availability"]) &&
      isUnavailableCapability(result.availability) &&
      result.error === undefined &&
      result.value === undefined
    );
  }
  if (
    result.state !== "value" ||
    !hasExactOwnKeys(result, ["kind", "state", "value"]) ||
    result.availability !== undefined ||
    result.error !== undefined
  ) {
    return false;
  }
  if (result.kind === "authentication") return isAuthenticationStatus(result.value);
  if (result.kind === "rate_limits") return isRateLimitStatus(result.value);
  return result.kind === "context_limits" && isContextWindowStatus(result.value);
}

function isCompleteTelemetrySnapshot(
  value: unknown,
  request: unknown,
  providerId: ProviderId,
  binding: ProviderErrorIdentityBinding,
): value is ProviderTelemetrySnapshot {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(
      value,
      ["providerId", "accountId", "sessionId", "threadId", "capturedAt", "results", "response"],
    ) ||
    !isRecord(request) ||
    !Array.isArray(request.kinds)
  ) return false;
  if (
    value.providerId !== providerId ||
    (typeof request.accountId !== "string" && request.accountId !== null) ||
    (typeof request.sessionId !== "string" && request.sessionId !== null) ||
    (typeof request.threadId !== "string" && request.threadId !== null) ||
    value.accountId !== request.accountId ||
    value.sessionId !== request.sessionId ||
    value.threadId !== request.threadId ||
    !isFiniteNumber(value.capturedAt) ||
    !isProviderResponseMetadata(value.response) ||
    !Array.isArray(value.results)
  ) {
    return false;
  }
  const requestedKinds = request.kinds;
  if (
    requestedKinds.length === 0 ||
    !requestedKinds.every(isProviderTelemetryKind) ||
    new Set(requestedKinds).size !== requestedKinds.length ||
    value.results.length !== requestedKinds.length
  ) {
    return false;
  }
  const results = value.results as ProviderTelemetryResult[];
  return (
    results.every(
      (result) =>
        isRecord(result) &&
        isProviderTelemetryKind(result.kind) &&
        requestedKinds.includes(result.kind) &&
        telemetryResultMatchesKind(result, providerId, binding),
    ) && new Set(results.map((result) => result.kind)).size === results.length
  );
}

function isStructuredOutputOutcome(value: unknown): value is StructuredOutputOutcome {
  if (!isRecord(value)) return false;
  switch (value.state) {
    case "not_requested":
      return hasExactOwnKeys(value, ["state"]);
    case "present":
      return (
        hasExactOwnKeys(value, ["state", "request", "result"]) &&
        isStructuredOutputRequestIdentity(value.request) &&
        isStructuredOutputResult(value.result) &&
        value.result.validation.state === "valid"
      );
    case "refused":
      return (
        hasExactOwnKeys(
          value,
          ["state", "request", "message", "reasonCode"],
          ["state", "request", "message"],
        ) &&
        isStructuredOutputRequestIdentity(value.request) &&
        typeof value.message === "string" &&
        optionalString(value.reasonCode)
      );
    case "unavailable":
      return (
        hasExactOwnKeys(value, ["state", "request", "availability"]) &&
        isStructuredOutputRequestIdentity(value.request) &&
        isUnavailableCapability(value.availability)
      );
    case "invalid":
      return (
        hasExactOwnKeys(value, ["state", "request", "rawText", "issues"]) &&
        isStructuredOutputRequestIdentity(value.request) &&
        typeof value.rawText === "string" &&
        Array.isArray(value.issues) &&
        value.issues.every(
          (issue) =>
            isRecord(issue) &&
            hasExactOwnKeys(issue, ["path", "message"]) &&
            Array.isArray(issue.path) &&
            issue.path.every((part) => typeof part === "string" || isNonnegativeInteger(part)) &&
            typeof issue.message === "string",
        )
      );
    case "incomplete":
      return (
        hasExactOwnKeys(value, ["state", "request", "accumulatedJson"]) &&
        isStructuredOutputRequestIdentity(value.request) &&
        typeof value.accumulatedJson === "string"
      );
    default:
      return false;
  }
}

function isStructuredOutputRequestIdentity(
  value: unknown,
): value is StructuredOutputRequestIdentity {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["schemaName", "schemaHash", "strict"]) &&
    hasStructuredOutputRequestIdentityFields(value)
  );
}

function hasStructuredOutputRequestIdentityFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.schemaName === "string" &&
    value.schemaName.length > 0 &&
    typeof value.schemaHash === "string" &&
    value.schemaHash.length > 0 &&
    typeof value.strict === "boolean"
  );
}

function isStructuredOutputRequest(value: unknown): value is StructuredOutputRequest {
  if (!isRecord(value) || !hasStructuredOutputRequestIdentityFields(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasExactOwnKeys(
      candidate,
      ["schemaName", "schemaHash", "strict", "description", "schema"],
      ["schemaName", "schemaHash", "strict", "schema"],
    ) &&
    optionalString(candidate.description) &&
    isJsonSchema(candidate.schema)
  );
}

function structuredOutputMatchesRequest(
  outcome: StructuredOutputOutcome,
  request: StructuredOutputRequest,
): boolean {
  if (outcome.state === "not_requested") return false;
  return (
    outcome.request.schemaName === request.schemaName &&
    outcome.request.schemaHash === request.schemaHash &&
    outcome.request.strict === request.strict &&
    (outcome.state !== "present" || outcome.result.schemaName === request.schemaName)
  );
}

const MAX_DISCOVERED_PROVIDERS = 256;
const MAX_DISCOVERED_ACCOUNTS = 512;
const MAX_DISCOVERED_MODELS = 2_048;
const MAX_DESCRIPTOR_CHILDREN = 128;
const MAX_IDENTIFIER_UTF16_UNITS = 128;
const MAX_IDENTIFIER_UTF8_BYTES = 256;
const MAX_DISPLAY_NAME_UTF16_UNITS = 256;
const MAX_DISPLAY_NAME_UTF8_BYTES = 512;
const MAX_CAPABILITY_LIMITATIONS = 64;
const MAX_USER_VISIBLE_CAPABILITY_TEXT_UTF16_UNITS = 512;
const MAX_USER_VISIBLE_CAPABILITY_TEXT_UTF8_BYTES = 1_024;
const descriptorUnsafeCharacters = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}|\p{Zl}|\p{Zp}/u;
const utf8Encoder = new TextEncoder();

function isBoundedSafeText(
  value: unknown,
  maximumUtf16Units: number,
  maximumUtf8Bytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumUtf16Units &&
    !descriptorUnsafeCharacters.test(value) &&
    utf8Encoder.encode(value).byteLength <= maximumUtf8Bytes
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedSafeText(value, MAX_IDENTIFIER_UTF16_UNITS, MAX_IDENTIFIER_UTF8_BYTES);
}

function isBoundedDisplayName(value: unknown): value is string {
  return isBoundedSafeText(
    value,
    MAX_DISPLAY_NAME_UTF16_UNITS,
    MAX_DISPLAY_NAME_UTF8_BYTES,
  );
}

function isUserVisibleCapabilityText(value: unknown): value is string {
  return (
    isBoundedSafeText(
      value,
      MAX_USER_VISIBLE_CAPABILITY_TEXT_UTF16_UNITS,
      MAX_USER_VISIBLE_CAPABILITY_TEXT_UTF8_BYTES,
    ) && value.trim().length > 0
  );
}

function hasExactOwnKeys(
  value: Record<PropertyKey, unknown>,
  allowed: readonly PropertyKey[],
  required: readonly PropertyKey[] = allowed,
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length <= allowed.length &&
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isBoundedArray(value: unknown, maximum: number): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= maximum;
}

function isCapabilityAvailability(value: unknown): value is CapabilityAvailability {
  if (!isRecord(value)) return false;
  if (value.state === "unavailable") {
    return (
      hasExactOwnKeys(value, ["state", "reason", "message"], ["state", "reason"]) &&
      isUnavailableCapability(value)
    );
  }
  return (
    value.state === "available" &&
    hasExactOwnKeys(value, ["state", "limitations"], ["state"]) &&
    (value.limitations === undefined ||
      (isBoundedArray(value.limitations, MAX_CAPABILITY_LIMITATIONS) &&
        value.limitations.every(isUserVisibleCapabilityText)))
  );
}

function isProviderDescriptor(value: unknown): value is ProviderDescriptor {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["providerId", "displayName", "adapterVersion"], ["providerId", "displayName"]) &&
    isBoundedIdentifier(value.providerId) &&
    isBoundedDisplayName(value.displayName) &&
    (value.adapterVersion === undefined || isBoundedIdentifier(value.adapterVersion))
  );
}

function isAccountCapabilityReadiness(value: unknown): value is AccountCapabilityReadiness {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["operation", "state", "reason", "message"], ["operation", "state"]) ||
    !isProviderOperationName(value.operation)
  ) {
    return false;
  }
  if (value.state === "ready") return value.reason === undefined && value.message === undefined;
  if (value.state === "requires_authentication" || value.state === "unknown") {
    return (
      value.reason === undefined &&
      (value.message === undefined || isUserVisibleCapabilityText(value.message))
    );
  }
  return (
    value.state === "unavailable" &&
    unavailableReasons.has(value.reason as CapabilityUnavailableReason) &&
    (value.message === undefined || isUserVisibleCapabilityText(value.message))
  );
}

function isAccountDescriptor(value: unknown, providerId: ProviderId): value is AccountDescriptor {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, [
      "accountId",
      "providerId",
      "displayName",
      "authentication",
      "capabilityReadiness",
    ]) &&
    isBoundedIdentifier(value.accountId) &&
    value.providerId === providerId &&
    isBoundedDisplayName(value.displayName) &&
    isAuthenticationStatus(value.authentication) &&
    isBoundedArray(value.capabilityReadiness, MAX_DESCRIPTOR_CHILDREN) &&
    value.capabilityReadiness.every(isAccountCapabilityReadiness)
  );
}

function isProviderSpecificCapability(value: unknown): value is ProviderSpecificCapability {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["availability", "displayName", "description"], ["availability", "displayName"]) &&
    isCapabilityAvailability(value.availability) &&
    isBoundedDisplayName(value.displayName) &&
    (value.description === undefined || isBoundedDisplayName(value.description))
  );
}

function isProviderSpecificCapabilityMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string") &&
    Object.keys(value).length <= MAX_DESCRIPTOR_CHILDREN &&
    Object.values(value).every(isProviderSpecificCapability)
  );
}

function isModelDescriptor(value: unknown, providerId: ProviderId, accountId?: AccountId): value is ModelDescriptor {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, [
      "modelId",
      "providerId",
      "accountId",
      "displayName",
      "capabilities",
      "limits",
      "effort",
    ]) ||
    !isBoundedIdentifier(value.modelId) ||
    value.providerId !== providerId ||
    !isBoundedIdentifier(value.accountId) ||
    (accountId !== undefined && value.accountId !== accountId) ||
    !isBoundedDisplayName(value.displayName) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.limits) ||
    !isRecord(value.effort)
  ) {
    return false;
  }
  const capabilities = value.capabilities;
  if (
    !hasExactOwnKeys(capabilities, ["input", "output", "reasoning", "providerSpecific"]) ||
    !isRecord(capabilities.input) ||
    !hasExactOwnKeys(capabilities.input, ["text", "image", "file"]) ||
    ![capabilities.input.text, capabilities.input.image, capabilities.input.file].every(
      isCapabilityAvailability,
    ) ||
    !isRecord(capabilities.output) ||
    !hasExactOwnKeys(capabilities.output, [
      "text",
      "thinking",
      "refusal",
      "toolCalls",
      "structuredOutput",
    ]) ||
    ![
      capabilities.output.text,
      capabilities.output.thinking,
      capabilities.output.refusal,
      capabilities.output.toolCalls,
      capabilities.output.structuredOutput,
    ].every(isCapabilityAvailability) ||
    !isRecord(capabilities.reasoning) ||
    !hasExactOwnKeys(capabilities.reasoning, ["availability", "modes"]) ||
    !isCapabilityAvailability(capabilities.reasoning.availability) ||
    !isBoundedArray(capabilities.reasoning.modes, MAX_DESCRIPTOR_CHILDREN) ||
    !capabilities.reasoning.modes.every(
      (mode) =>
        isRecord(mode) &&
        hasExactOwnKeys(mode, ["modeId", "displayName", "providerValue"]) &&
        isBoundedIdentifier(mode.modeId) &&
        isBoundedDisplayName(mode.displayName) &&
        isJsonValue(mode.providerValue),
    ) ||
    !isProviderSpecificCapabilityMap(capabilities.providerSpecific)
  ) {
    return false;
  }
  const limits = value.limits;
  if (
    !hasExactOwnKeys(
      limits,
      [
        "contextWindowTokens",
        "maxInputTokens",
        "maxOutputTokens",
        "maxReasoningTokens",
        "maxToolCallsPerTurn",
        "providerSpecific",
      ],
      ["providerSpecific"],
    ) ||
    ![
      limits.contextWindowTokens,
      limits.maxInputTokens,
      limits.maxOutputTokens,
      limits.maxReasoningTokens,
      limits.maxToolCallsPerTurn,
    ].every((limit) => limit === undefined || isNonnegativeInteger(limit)) ||
    !isRecord(limits.providerSpecific) ||
    !isJsonValue(limits.providerSpecific)
  ) {
    return false;
  }
  const effort = value.effort;
  return (
    hasExactOwnKeys(effort, ["availability", "options", "defaultOptionId"], ["availability", "options"]) &&
    isCapabilityAvailability(effort.availability) &&
    isBoundedArray(effort.options, MAX_DESCRIPTOR_CHILDREN) &&
    effort.options.every(
      (option) =>
        isRecord(option) &&
        hasExactOwnKeys(option, ["optionId", "displayName", "providerValue"]) &&
        isBoundedIdentifier(option.optionId) &&
        isBoundedDisplayName(option.displayName) &&
        isJsonValue(option.providerValue),
    ) &&
    optionalString(effort.defaultOptionId) &&
    (effort.defaultOptionId === undefined ||
      effort.options.some(
        (option) => isRecord(option) && option.optionId === effort.defaultOptionId,
      ))
  );
}

function isCapabilityOperationValue(
  value: unknown,
  providerId: ProviderId,
  operation: ProviderOperationName,
): boolean {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, [providerOperationBoundary, "providerId", "capability", "execute"]) &&
    providerOperationRegistrations.has(value) &&
    (value as unknown as EnforcedProviderOperationBoundary)[providerOperationBoundary] === true &&
    value.providerId === providerId &&
    typeof value.execute === "function" &&
    isRecord(value.capability) &&
    hasExactOwnKeys(value.capability, ["operation", "availability"]) &&
    value.capability.operation === operation &&
    isCapabilityAvailability(value.capability.availability)
  );
}

function isProviderAdapterCapabilities(value: unknown): value is ProviderAdapterCapabilities {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, [
      "cancellation",
      "rateLimits",
      "authenticationExpiry",
      "contextLimits",
      "providerSpecific",
    ]) ||
    !isRecord(value.cancellation) ||
    !hasExactOwnKeys(value.cancellation, ["availability", "modes"]) ||
    !isCapabilityAvailability(value.cancellation.availability) ||
    !isBoundedArray(value.cancellation.modes, 2) ||
    !value.cancellation.modes.every((mode) =>
      ["abort-signal", "session-interrupt"].includes(mode as string),
    ) ||
    !isProviderSpecificCapabilityMap(value.providerSpecific)
  ) {
    return false;
  }
  return [value.rateLimits, value.authenticationExpiry, value.contextLimits].every((telemetry) => {
    if (!isRecord(telemetry) || !isCapabilityAvailability(telemetry.availability)) return false;
    if (telemetry.availability.state === "available") {
      return (
        hasExactOwnKeys(telemetry, ["availability", "delivery"]) &&
        ["event-stream", "poll", "response"].includes(telemetry.delivery as string)
      );
    }
    return hasExactOwnKeys(telemetry, ["availability"]);
  });
}

function isProviderAdapterValue(value: unknown, providerId: ProviderId): value is ProviderAdapterV1<ProviderId> {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, [
      "contractVersion",
      "provider",
      "capabilities",
      "errorNormalization",
      "operations",
      "extensions",
    ]) ||
    value.contractVersion !== PROVIDER_ADAPTER_CONTRACT_VERSION ||
    !isProviderDescriptor(value.provider) ||
    value.provider.providerId !== providerId ||
    !isProviderAdapterCapabilities(value.capabilities) ||
    !isRecord(value.errorNormalization) ||
    !hasExactOwnKeys(value.errorNormalization, ["normalize"]) ||
    typeof value.errorNormalization.normalize !== "function" ||
    !isRecord(value.operations) ||
    !hasExactOwnKeys(value.operations, ["discovery", "sessions", "interactions", "telemetry"]) ||
    !isRecord(value.operations.discovery) ||
    !hasExactOwnKeys(value.operations.discovery, ["accounts", "models"]) ||
    !isRecord(value.operations.sessions) ||
    !hasExactOwnKeys(value.operations.sessions, [
      "start",
      "resume",
      "fork",
      "send",
      "submitToolResult",
      "interrupt",
      "events",
    ]) ||
    !isRecord(value.operations.interactions) ||
    !hasExactOwnKeys(value.operations.interactions, ["respondToApproval", "respondToUserInput"]) ||
    !isRecord(value.operations.telemetry) ||
    !hasExactOwnKeys(value.operations.telemetry, ["poll"]) ||
    !isRecord(value.extensions) ||
    Reflect.ownKeys(value.extensions).some((key) => typeof key !== "string") ||
    Object.keys(value.extensions).length > MAX_DESCRIPTOR_CHILDREN
  ) {
    return false;
  }
  const slots: readonly [unknown, ProviderOperationName][] = [
    [value.operations.discovery.accounts, "discover_accounts"],
    [value.operations.discovery.models, "discover_models"],
    [value.operations.sessions.start, "start"],
    [value.operations.sessions.resume, "resume"],
    [value.operations.sessions.fork, "fork"],
    [value.operations.sessions.send, "send"],
    [value.operations.sessions.submitToolResult, "submit_tool_result"],
    [value.operations.sessions.interrupt, "interrupt"],
    [value.operations.sessions.events, "events"],
    [value.operations.interactions.respondToApproval, "respond_to_approval"],
    [value.operations.interactions.respondToUserInput, "respond_to_user_input"],
    [value.operations.telemetry.poll, "poll_telemetry"],
  ];
  return (
    slots.every(([candidate, operation]) =>
      isCapabilityOperationValue(candidate, providerId, operation),
    ) &&
    Object.values(value.extensions).every(
      (candidate) =>
        isRecord(candidate) &&
        isRecord(candidate.capability) &&
        typeof candidate.capability.operation === "string" &&
        candidate.capability.operation.startsWith("extension:") &&
        isCapabilityOperationValue(
          candidate,
          providerId,
          candidate.capability.operation as ProviderOperationName,
        ),
    )
  );
}

function isInterruptTarget(value: unknown): value is InterruptTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "turn") {
    return hasExactOwnKeys(value, ["kind", "turnId"]) && typeof value.turnId === "string";
  }
  if (value.kind === "request") {
    return (
      hasExactOwnKeys(value, ["kind", "turnId", "requestId"]) &&
      typeof value.turnId === "string" &&
      typeof value.requestId === "string"
    );
  }
  return (
    value.kind === "tool_call" &&
    hasExactOwnKeys(value, ["kind", "turnId", "toolCallId"]) &&
    typeof value.turnId === "string" &&
    typeof value.toolCallId === "string"
  );
}

function isSendTurnTarget(value: unknown): value is SendTurnTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "new") {
    return (
      hasExactOwnKeys(value, ["kind", "parentTurnId"], ["kind"]) &&
      optionalString(value.parentTurnId)
    );
  }
  return (
    value.kind === "existing" &&
    hasExactOwnKeys(value, ["kind", "turnId"]) &&
    typeof value.turnId === "string"
  );
}

function isApprovalAmendment(value: unknown): value is ApprovalAmendment {
  if (!isRecord(value)) return false;
  if (value.kind === "command") {
    return (
      hasExactOwnKeys(value, ["kind", "program", "arguments", "cwd"]) &&
      typeof value.program === "string" &&
      isBoundedArray(value.arguments, MAX_DESCRIPTOR_CHILDREN) &&
      value.arguments.every((argument) => typeof argument === "string") &&
      typeof value.cwd === "string"
    );
  }
  if (value.kind === "diff") {
    return (
      hasExactOwnKeys(value, ["kind", "patch", "files"]) &&
      typeof value.patch === "string" &&
      isBoundedArray(value.files, MAX_DESCRIPTOR_CHILDREN) &&
      value.files.every((file) => typeof file === "string")
    );
  }
  if (value.kind === "policy") {
    return (
      hasExactOwnKeys(value, ["kind", "policyPatch"]) &&
      isRecord(value.policyPatch) &&
      isJsonValue(value.policyPatch)
    );
  }
  return (
    value.kind === "tool" &&
    hasExactOwnKeys(value, ["kind", "arguments"]) &&
    isRecord(value.arguments) &&
    isJsonValue(value.arguments)
  );
}

function isCoreOperationSuccess(
  operation: CoreProviderOperationName,
  value: unknown,
  request: unknown,
  providerId: ProviderId,
): boolean {
  const requestRecord = isRecord(request) ? request : undefined;
  switch (operation) {
    case "discover_providers":
      return (
        isBoundedArray(value, MAX_DISCOVERED_PROVIDERS) &&
        value.every(isProviderDescriptor) &&
        new Set(value.map((descriptor) => descriptor.providerId)).size === value.length
      );
    case "resolve_adapter":
      return (
        requestRecord !== undefined &&
        typeof requestRecord.providerId === "string" &&
        isProviderAdapterValue(value, requestRecord.providerId)
      );
    case "discover_accounts":
      return (
        isBoundedArray(value, MAX_DISCOVERED_ACCOUNTS) &&
        value.every((account) => isAccountDescriptor(account, providerId)) &&
        new Set(value.map((account) => account.accountId)).size === value.length
      );
    case "discover_models": {
      const requestedAccount = requestRecord?.accountId;
      return (
        (requestedAccount === undefined || typeof requestedAccount === "string") &&
        isBoundedArray(value, MAX_DISCOVERED_MODELS) &&
        value.every((model) =>
          isModelDescriptor(model, providerId, requestedAccount as string | undefined),
        ) &&
        new Set(value.map((model) => `${model.accountId}\u0000${model.modelId}`)).size === value.length
      );
    }
    case "submit_tool_result":
      return (
        requestRecord !== undefined &&
        isRecord(requestRecord.result) &&
        isRecord(value) &&
        hasExactOwnKeys(value, ["accepted", "toolCallId", "state"]) &&
        typeof value.accepted === "boolean" &&
        value.toolCallId === requestRecord.toolCallId &&
        value.state === requestRecord.result.state &&
        ["success", "error", "cancel"].includes(value.state as string)
      );
    case "interrupt":
      return (
        requestRecord !== undefined &&
        isInterruptTarget(requestRecord.target) &&
        isRecord(value) &&
        hasExactOwnKeys(value, ["interrupted", "turnId", "target"]) &&
        typeof value.interrupted === "boolean" &&
        value.turnId === requestRecord.target.turnId &&
        isInterruptTarget(value.target) &&
        jsonEquivalent(value.target, requestRecord.target)
      );
    case "respond_to_approval":
      return (
        requestRecord !== undefined &&
        isRecord(value) &&
        hasExactOwnKeys(
          value,
          [
            "approvalId",
            "choiceId",
            "action",
            "selectedOptionIds",
            "amendment",
            "appliedPolicyId",
          ],
          ["approvalId", "choiceId", "action"],
        ) &&
        value.approvalId === requestRecord.approvalId &&
        value.choiceId === requestRecord.choiceId &&
        value.action === requestRecord.action &&
        ["approve", "deny", "cancel", "amend"].includes(value.action as string) &&
        (value.selectedOptionIds === undefined ||
          (isBoundedArray(value.selectedOptionIds, MAX_DESCRIPTOR_CHILDREN) &&
            value.selectedOptionIds.every((id) => typeof id === "string"))) &&
        jsonEquivalent(value.selectedOptionIds, requestRecord.selectedOptionIds) &&
        (value.action === "amend"
          ? isApprovalAmendment(value.amendment) &&
            jsonEquivalent(value.amendment, requestRecord.amendment)
          : value.amendment === undefined) &&
        optionalString(value.appliedPolicyId)
      );
    case "respond_to_user_input":
      return (
        requestRecord !== undefined &&
        isRecord(value) &&
        hasExactOwnKeys(value, ["inputId", "accepted", "action"]) &&
        value.inputId === requestRecord.inputId &&
        typeof value.accepted === "boolean" &&
        value.action === (requestRecord.action === "submit" ? "submitted" : "cancelled")
      );
    case "start":
    case "resume":
    case "fork":
    case "send":
    case "events":
    case "poll_telemetry":
      return true;
  }
}

interface DetachedBoundarySnapshot<T> {
  readonly value: T;
  readonly originForClone: WeakMap<object, object>;
}

interface DetachBoundaryOptions {
  readonly preserveAbortSignals?: boolean;
  readonly wrapProviderOperations?: boolean;
  readonly functionReplacements?: ReadonlyMap<Function, Function>;
}

function detachBoundaryValue<T>(
  value: T,
  options: DetachBoundaryOptions = {},
): DetachedBoundarySnapshot<T> {
  const clones = new WeakMap<object, object>();
  const originForClone = new WeakMap<object, object>();
  let nodes = 0;
  const detach = (candidate: unknown, depth: number): unknown => {
    if (typeof candidate === "function") {
      const replacement = options.functionReplacements?.get(candidate);
      if (replacement !== undefined) return replacement;
      throw new TypeError("Provider result contains executable or non-data state.");
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      typeof candidate === "undefined"
    ) {
      return candidate;
    }
    if (typeof candidate === "symbol" || typeof candidate === "bigint") {
      throw new TypeError("Provider result contains executable or non-data state.");
    }
    if (typeof candidate !== "object" || depth > 64 || ++nodes > 16_384) {
      throw new TypeError("Provider result exceeds the stable boundary limits.");
    }
    if (options.wrapProviderOperations === true && providerOperationRegistrations.has(candidate)) {
      const previous = clones.get(candidate);
      if (previous !== undefined) return previous;
      const operation = candidate as unknown as {
        readonly [providerOperationBoundary]: true;
        readonly providerId: ProviderId;
        readonly capability: OperationCapability;
        readonly execute: (request: unknown) => unknown;
      };
      const executeProvider = operation.execute;
      const execute = Object.freeze((request: unknown) =>
        Reflect.apply(executeProvider, undefined, [request]),
      );
      const wrapper = Object.freeze({
        [providerOperationBoundary]: true as const,
        providerId: operation.providerId,
        capability: operation.capability,
        execute,
      });
      clones.set(candidate, wrapper);
      originForClone.set(wrapper, candidate);
      providerOperationRegistrations.add(wrapper);
      return wrapper;
    }
    if (providerEventStreamRegistrations.has(candidate)) return candidate;
    if (
      options.preserveAbortSignals === true &&
      typeof AbortSignal !== "undefined" &&
      candidate instanceof AbortSignal
    ) {
      return candidate;
    }
    const previous = clones.get(candidate);
    if (previous !== undefined) return previous;
    if (Array.isArray(candidate)) {
      const length = candidate.length;
      if (!isNonnegativeInteger(length) || length > 4_096) {
        throw new TypeError("Provider result array exceeds the stable boundary limits.");
      }
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.length !== length + 1 ||
        !keys.includes("length") ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && (!/^\d+$/.test(key) || Number(key) >= length)),
        )
      ) {
        throw new TypeError("Provider result array contains non-closed properties.");
      }
      const clone: unknown[] = new Array(length);
      clones.set(candidate, clone);
      originForClone.set(clone, candidate);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(candidate, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError("Provider result arrays require enumerable data entries.");
        }
        clone[index] = detach(descriptor.value, depth + 1);
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Provider result contains an unsupported object.");
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > 256) {
      throw new TypeError("Provider result object exceeds the stable boundary limits.");
    }
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("Provider result objects require string data keys.");
    }
    const clone: Record<PropertyKey, unknown> = {};
    clones.set(candidate, clone);
    originForClone.set(clone, candidate);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Provider result objects require enumerable data properties.");
      }
      Object.defineProperty(clone, key, {
        value: detach(descriptor.value, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(clone);
  };
  return { value: detach(value, 0) as T, originForClone };
}

function originalBoundaryObject<T extends object>(
  value: T,
  originForClone: WeakMap<object, object>,
): T {
  return (originForClone.get(value) ?? value) as T;
}

function detachProviderOperationResult<T>(
  result: T,
  operation: ProviderOperationName,
  request: unknown,
): DetachedBoundarySnapshot<T> {
  if (
    operation !== "resolve_adapter" ||
    !isRecord(result) ||
    !hasExactOwnKeys(result, ["kind", "value", "fallbackDecisions"]) ||
    result.kind !== "success" ||
    !Array.isArray(result.fallbackDecisions) ||
    result.fallbackDecisions.length !== 0 ||
    !isRecord(request) ||
    typeof request.providerId !== "string" ||
    !isProviderAdapterValue(result.value, request.providerId)
  ) {
    return detachBoundaryValue(result);
  }
  const adapter = result.value;
  const normalization = adapter.errorNormalization;
  const normalizeProviderError = normalization.normalize;
  const normalize = Object.freeze((input: ProviderErrorNormalizationInput) =>
    Reflect.apply(normalizeProviderError, normalization, [input]) as ProviderAdapterError,
  );
  return detachBoundaryValue(result, {
    wrapProviderOperations: true,
    functionReplacements: new Map([[normalizeProviderError, normalize]]),
  });
}

function isStableProviderResult<T>(
  value: unknown,
  providerId: ProviderId,
  operation: ProviderOperationName,
  request: unknown,
  errorBinding: ProviderErrorIdentityBinding,
  eventEvidence: ProviderEventEvidence<ProviderId>,
  resultValidator: ((value: unknown, request: unknown) => boolean) | undefined,
  originForClone: WeakMap<object, object>,
): value is ProviderAdapterResult<T> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProviderAdapterResult<T>>;
  if (
    !hasExactOwnKeys(
      value as Record<PropertyKey, unknown>,
      candidate.kind === "success"
        ? ["kind", "value", "fallbackDecisions"]
        : ["kind", "error", "fallbackDecisions"],
    ) ||
    !Array.isArray(candidate.fallbackDecisions)
  ) {
    return false;
  }
  const requestRecord = isRecord(request) ? request : undefined;
  const evidenceRegistration = providerEventEvidenceRegistration(eventEvidence);
  if (evidenceRegistration?.providerId !== providerId) return false;
  const hasTargetPolicy =
    requestRecord !== undefined &&
    isExecutionTarget(requestRecord.target) &&
    isFallbackPolicy(requestRecord.fallback);
  for (const decision of candidate.fallbackDecisions) {
    if (!isFallbackDecision(decision) || !hasValidFallbackConfirmation(decision)) return false;
    const event = evidenceRegistration.fallbackEvents.get(
      originalBoundaryObject(decision, originForClone),
    );
    if (event === undefined || !hasTargetPolicy) return false;
    if (
      validateTargetResolutionUnsafe(
        {
          adapterProviderId: providerId,
          requestedTarget: requestRecord.target as ExecutionTarget,
          policy: requestRecord.fallback as FallbackPolicy,
          resolution: {
            kind: "fallback",
            requested: decision.requested,
            resolved: decision.resolved,
            decision,
          },
          eventEvidence,
        },
        event,
      ).kind !== "success"
    ) {
      return false;
    }
  }

  if (candidate.kind === "error") {
    return isStableProviderErrorForOperation(candidate.error, providerId, operation, errorBinding);
  }
  if (candidate.kind !== "success" || !("value" in candidate)) return false;

  if (["start", "resume", "fork", "send"].includes(operation)) {
    if (!hasTargetPolicy || !isRecord(candidate.value) || !isTargetResolution(candidate.value.target)) {
      return false;
    }
    if (
      !hasExactOwnKeys(
        candidate.value,
        operation === "send"
          ? ["messageId", "turnId", "target", "structuredOutput"]
          : ["session", "target"],
      )
    ) {
      return false;
    }
    const resolution = candidate.value.target;
    if (resolution.kind === "exact") {
      if (candidate.fallbackDecisions.length !== 0) return false;
      if (
        validateTargetResolutionUnsafe(
          {
            adapterProviderId: providerId,
            requestedTarget: requestRecord.target as ExecutionTarget,
            policy: requestRecord.fallback as FallbackPolicy,
            resolution,
            eventEvidence,
          },
          undefined,
        ).kind !== "success"
      ) {
        return false;
      }
    } else {
      const visibleEvent = evidenceRegistration.fallbackEvents.get(
        originalBoundaryObject(resolution.decision, originForClone),
      );
      if (
        candidate.fallbackDecisions.length === 0 ||
        candidate.fallbackDecisions[candidate.fallbackDecisions.length - 1] !== resolution.decision ||
        visibleEvent === undefined ||
        validateTargetResolutionUnsafe(
          {
            adapterProviderId: providerId,
            requestedTarget: requestRecord.target as ExecutionTarget,
            policy: requestRecord.fallback as FallbackPolicy,
            resolution,
            eventEvidence,
          },
          visibleEvent,
        ).kind !== "success"
      ) {
        return false;
      }
    }
    const resolvedTarget =
      resolution.kind === "exact" ? resolution.target : resolution.resolved;
    if (operation === "send") {
      if (
        typeof candidate.value.messageId !== "string" ||
        typeof candidate.value.turnId !== "string" ||
        typeof requestRecord.sessionId !== "string" ||
        typeof requestRecord.threadId !== "string" ||
        !isSendTurnTarget(requestRecord.turn) ||
        (requestRecord.turn.kind === "existing" &&
          candidate.value.turnId !== requestRecord.turn.turnId)
      ) {
        return false;
      }
    } else {
      if (!isSessionReference(candidate.value.session)) return false;
      const session = candidate.value.session;
      if (
        session.providerId !== resolvedTarget.providerId ||
        (resolvedTarget.accountId !== undefined && session.accountId !== resolvedTarget.accountId) ||
        session.modelId !== resolvedTarget.modelId ||
        (operation === "resume" &&
          (session.sessionId !== requestRecord.sessionId ||
            session.threadId !== requestRecord.threadId))
      ) {
        return false;
      }
    }
  } else if (candidate.fallbackDecisions.length !== 0) {
    return false;
  }

  if (operation === "send") {
    if (!isRecord(candidate.value) || !isStructuredOutputOutcome(candidate.value.structuredOutput)) {
      return false;
    }
    const requestedOutput = isRecord(requestRecord?.execution)
      ? requestRecord.execution.structuredOutput
      : undefined;
    if (requestedOutput === undefined) {
      if (candidate.value.structuredOutput.state !== "not_requested") return false;
    } else if (
      !isStructuredOutputRequest(requestedOutput) ||
      !structuredOutputMatchesRequest(candidate.value.structuredOutput, requestedOutput)
    ) {
      return false;
    }
  }
  if (operation === "poll_telemetry") {
    return isCompleteTelemetrySnapshot(candidate.value, request, providerId, errorBinding);
  }
  if (operation === "events") {
    const registration = isRecord(candidate.value)
      ? providerEventStreamRegistrations.get(candidate.value)
      : undefined;
    if (registration === undefined) return false;
    if (registration.eventEvidenceRegistration !== evidenceRegistration) return false;
    const stream = candidate.value as unknown as ProviderEventStream;
    return (
      isRecord(request) &&
      isBoundedIdentifier(request.accountId) &&
      typeof request.sessionId === "string" &&
      typeof request.threadId === "string" &&
      (typeof request.turnId === "string" || request.turnId === null) &&
      registration.providerId === providerId &&
      registration.accountId === request.accountId &&
      isProviderEventStreamContext(registration.context) &&
      registration.context.sessionId === request.sessionId &&
      registration.context.threadId === request.threadId &&
      registration.context.turnId === request.turnId &&
      registration.context.afterEventId === request.afterEventId &&
      registration.context.requestId === request.requestId &&
      registration.context.deadlineAt === request.deadlineAt &&
      stream[providerEventStreamBoundary] === true &&
      stream.providerId === registration.providerId &&
      stream.context === registration.context &&
      typeof stream.close === "function" &&
      stream[Symbol.asyncIterator] === registration.iterator
    );
  }
  if (operation.startsWith("extension:")) {
    return resultValidator !== undefined && resultValidator(candidate.value, request);
  }
  return isCoreOperationSuccess(operation as CoreProviderOperationName, candidate.value, request, providerId);
}

function internalBoundaryError(
  providerId: ProviderId,
  requestId?: RequestId,
): InternalProviderAdapterError {
  return {
    code: "internal",
    providerId,
    ...(requestId === undefined ? {} : { requestId }),
    message: "The provider adapter failed inside its error boundary.",
    retryable: false,
  };
}

function stableBoundaryFailure(
  providerId: ProviderId,
  operation: ProviderOperationName,
  error: unknown,
  binding: ProviderErrorIdentityBinding = {},
): ProviderAdapterFailure {
  try {
    const snapshot = detachBoundaryValue({
      kind: "error" as const,
      error,
      fallbackDecisions: [] as FallbackDecision[],
    });
    if (isStableProviderErrorForOperation(snapshot.value.error, providerId, operation, binding)) {
      return snapshot.value as ProviderAdapterFailure;
    }
  } catch {
    // Fall through to the stable internal error below.
  }
  return Object.freeze({
    kind: "error" as const,
    error: Object.freeze(internalBoundaryError(providerId, binding.requestId)),
    fallbackDecisions: Object.freeze([] as FallbackDecision[]),
  });
}

function validateOperationIdentity(
  providerId: unknown,
  operation: unknown,
): asserts operation is ProviderOperationName {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new TypeError("Provider operations require a non-empty provider id.");
  }
  if (!isProviderOperationName(operation)) {
    throw new TypeError("Provider operations require a stable operation name.");
  }
}

function freezeAvailableCapability(value: unknown): AvailableCapability {
  if (value === undefined) return Object.freeze({ state: "available" as const });
  if (!isRecord(value)) {
    throw new TypeError("Supported operations require valid availability metadata.");
  }
  const state = value.state;
  const limitations = value.limitations;
  if (
    !hasExactOwnKeys(value, ["state", "limitations"], ["state"]) ||
    state !== "available" ||
    (limitations !== undefined && !Array.isArray(limitations))
  ) {
    throw new TypeError("Supported operations require valid availability metadata.");
  }
  let detachedLimitations: readonly string[] | undefined;
  if (limitations !== undefined) {
    const limitationCount = limitations.length;
    if (!isNonnegativeInteger(limitationCount) || limitationCount > MAX_CAPABILITY_LIMITATIONS) {
      throw new TypeError("Supported operation limitations require valid array bounds.");
    }
    const candidate: unknown[] = new Array(limitationCount);
    for (let index = 0; index < limitationCount; index += 1) {
      candidate[index] = limitations[index];
    }
    if (
      !candidate.every(
        (limitation) =>
          isUserVisibleCapabilityText(limitation),
      )
    ) {
      throw new TypeError("Supported operation limitations must be display-safe strings.");
    }
    detachedLimitations = Object.freeze(candidate as string[]);
  }
  return Object.freeze({
    state: "available" as const,
    ...(detachedLimitations === undefined ? {} : { limitations: detachedLimitations }),
  });
}

function freezeUnavailableCapability(value: unknown): UnavailableCapability {
  if (!isRecord(value)) {
    throw new TypeError("Unavailable operations require valid availability metadata.");
  }
  const state = value.state;
  const reason = value.reason;
  const message = value.message;
  if (
    !hasExactOwnKeys(value, ["state", "reason", "message"], ["state", "reason"]) ||
    state !== "unavailable" ||
    !unavailableReasons.has(reason as CapabilityUnavailableReason) ||
    (message !== undefined && !isUserVisibleCapabilityText(message))
  ) {
    throw new TypeError("Unavailable operations require valid availability metadata.");
  }
  return Object.freeze({
    state: "unavailable" as const,
    reason: reason as CapabilityUnavailableReason,
    ...(message === undefined ? {} : { message: message as string }),
  });
}

/**
 * The sole construction path for a supported operation. It contains synchronous
 * throws, rejected thenables, malformed Results, and failures in the provider's
 * own normalizer, so callers always receive a fulfilled stable Result.
 */
export function createProviderOperation<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
  TResult,
>(
  options: CreateProviderOperationOptions<TProviderId, TOperation, TRequest, TResult>,
): SupportedCapabilityOperation<TProviderId, TOperation, TRequest, TResult> {
  const providerId = options.providerId;
  const operation = options.operation;
  const availabilityOption = options.availability;
  const eventEvidence = options.eventEvidence;
  const eventEvidenceRegistration = providerEventEvidenceRegistration(eventEvidence);
  const errorNormalization = options.errorNormalization;
  const contextForRequest = options.context;
  const resultValidator = options.resultValidator;
  const executeProvider = options.execute;
  validateOperationIdentity(providerId, operation);
  const availability = freezeAvailableCapability(availabilityOption);
  const capability = Object.freeze({ operation, availability });

  const providerOperation = Object.freeze({
    [providerOperationBoundary]: true as const,
    providerId,
    capability,
    execute: async (request: TRequest): ProviderAdapterPromise<TResult> => {
      const baseContext: ProviderErrorNormalizationContext = {
        providerId,
        operation,
      };
      let requestSnapshot: DetachedBoundarySnapshot<TRequest>;
      try {
        requestSnapshot = detachBoundaryValue(request, { preserveAbortSignals: true });
      } catch (cause) {
        try {
          const error = errorNormalization.normalize({ cause, context: baseContext });
          return stableBoundaryFailure(providerId, operation, error);
        } catch {
          return stableBoundaryFailure(providerId, operation, internalBoundaryError(providerId));
        }
      }
      const stableRequest = requestSnapshot.value;
      const requestBinding = providerErrorIdentityBinding(stableRequest);
      let errorBinding = requestBinding;
      let context: ProviderErrorNormalizationContext = Object.freeze({
        ...baseContext,
        ...requestBinding,
      });
      try {
        context = Object.freeze({
          ...baseContext,
          ...contextForRequest?.(stableRequest),
          ...requestBinding,
          ...baseContext,
        });
        errorBinding = providerErrorIdentityBinding(context);
      } catch (cause) {
        try {
          const error = errorNormalization.normalize({ cause, context });
          return stableBoundaryFailure(providerId, operation, error, errorBinding);
        } catch {
          return stableBoundaryFailure(
            providerId,
            operation,
            internalBoundaryError(providerId, errorBinding.requestId),
            errorBinding,
          );
        }
      }

      try {
        if (eventEvidenceRegistration?.providerId !== providerId) {
          throw new TypeError("Event evidence provider does not match the operation provider.");
        }
        const result: unknown = await executeProvider(stableRequest);
        const snapshot = detachProviderOperationResult(result, operation, stableRequest);
        if (
          !isStableProviderResult<TResult>(
            snapshot.value,
            providerId,
            operation,
            stableRequest,
            errorBinding,
            eventEvidence,
            resultValidator as ((value: unknown, request: unknown) => boolean) | undefined,
            snapshot.originForClone,
          )
        ) {
          throw new TypeError("Provider operation returned a malformed Result.");
        }
        return snapshot.value;
      } catch (cause) {
        try {
          const error = errorNormalization.normalize({ cause, context });
          return stableBoundaryFailure(providerId, operation, error, errorBinding);
        } catch {
          return stableBoundaryFailure(
            providerId,
            operation,
            internalBoundaryError(providerId, errorBinding.requestId),
            errorBinding,
          );
        }
      }
    },
  });
  providerOperationRegistrations.add(providerOperation);
  return providerOperation;
}

export interface CreateUnavailableProviderOperationOptions<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
> {
  readonly providerId: TProviderId;
  readonly operation: TOperation;
  readonly availability: UnavailableCapability;
  readonly message?: string;
}

/** Creates a callable unavailable operation with a non-rejecting stable error. */
export function createUnavailableProviderOperation<
  TProviderId extends ProviderId,
  TOperation extends ProviderOperationName,
  TRequest,
>(
  options: CreateUnavailableProviderOperationOptions<TProviderId, TOperation>,
): UnavailableCapabilityOperation<TProviderId, TOperation, TRequest> {
  const providerId = options.providerId;
  const operation = options.operation;
  const availabilityOption = options.availability;
  const messageOption = options.message;
  validateOperationIdentity(providerId, operation);
  const availability = freezeUnavailableCapability(availabilityOption);
  const capability = Object.freeze({ operation, availability });
  const message = messageOption ?? `Operation ${operation} is unavailable.`;
  if (!isUserVisibleCapabilityText(message)) {
    throw new TypeError("Unavailable operation messages must be bounded display-safe strings.");
  }

  const providerOperation = Object.freeze({
    [providerOperationBoundary]: true as const,
    providerId,
    capability,
    execute: async (request: TRequest): Promise<ProviderAdapterUnavailableResult> => {
      let binding: ProviderErrorIdentityBinding = Object.freeze({});
      try {
        binding = providerErrorIdentityBinding(
          detachBoundaryValue(request, { preserveAbortSignals: true }).value,
        );
      } catch {
        return stableBoundaryFailure(
          providerId,
          operation,
          internalBoundaryError(providerId),
        ) as ProviderAdapterUnavailableResult;
      }
      return stableBoundaryFailure(
        providerId,
        operation,
        {
          code: "operation_unavailable",
          providerId,
          ...(binding.requestId === undefined ? {} : { requestId: binding.requestId }),
          message,
          retryable: false,
          operation,
          availability,
        },
        binding,
      ) as ProviderAdapterUnavailableResult;
    },
  });
  providerOperationRegistrations.add(providerOperation);
  return providerOperation;
}

export interface CreateProviderEventStreamOptions<TProviderId extends ProviderId> {
  readonly providerId: TProviderId;
  readonly accountId: AccountId;
  readonly eventEvidence: ProviderEventEvidence<TProviderId>;
  readonly errorNormalization: ProviderErrorNormalization;
  readonly context: ProviderEventStreamContext;
  readonly events: AsyncIterable<ProviderEvent>;
  readonly close: () => void | PromiseLike<void>;
}

function normalizeBoundaryFailure(
  providerId: ProviderId,
  errorNormalization: ProviderErrorNormalization,
  cause: unknown,
  context: ProviderErrorNormalizationContext,
): ProviderAdapterFailure {
  const binding = providerErrorIdentityBinding(context);
  try {
    const error = errorNormalization.normalize({ cause, context });
    return stableBoundaryFailure(providerId, context.operation, error, binding);
  } catch {
    return stableBoundaryFailure(
      providerId,
      context.operation,
      internalBoundaryError(providerId, context.requestId),
      binding,
    );
  }
}

function providerEventMatchesStreamContext(
  event: ProviderEvent,
  providerId: ProviderId,
  accountId: AccountId,
  context: ProviderEventStreamContext,
): boolean {
  if (
    !(
      event.session.providerId === providerId &&
      event.session.accountId === accountId &&
      event.session.sessionId === context.sessionId &&
      event.session.threadId === context.threadId &&
      (context.turnId === null || event.turnId === context.turnId)
    )
  ) {
    return false;
  }
  if (event.type !== "usage") return true;
  if (
    event.usage.identity.sessionId !== event.session.sessionId ||
    event.usage.identity.threadId !== event.session.threadId
  ) {
    return false;
  }
  return !("turnId" in event.usage.identity) || event.usage.identity.turnId === event.turnId;
}

function isProviderEventStreamContext(value: unknown): value is ProviderEventStreamContext {
  return (
    isRecord(value) &&
    hasExactOwnKeys(
      value,
      ["sessionId", "threadId", "turnId", "afterEventId", "requestId", "deadlineAt"],
      ["sessionId", "threadId", "turnId"],
    ) &&
    typeof value.sessionId === "string" &&
    typeof value.threadId === "string" &&
    (typeof value.turnId === "string" || value.turnId === null) &&
    optionalString(value.afterEventId) &&
    optionalString(value.requestId) &&
    (value.deadlineAt === undefined || isFiniteNumber(value.deadlineAt))
  );
}

/** Wraps event iteration and closure so neither secondary execution path can reject. */
export function createProviderEventStream<TProviderId extends ProviderId>(
  options: CreateProviderEventStreamOptions<TProviderId>,
): ProviderEventStream<TProviderId> {
  const providerId = options.providerId;
  const accountId = options.accountId;
  const eventEvidence = options.eventEvidence;
  const eventEvidenceRegistration = providerEventEvidenceRegistration(eventEvidence);
  const errorNormalization = options.errorNormalization;
  const contextOption = options.context;
  const events = options.events;
  const closeProvider = options.close;
  if (!isBoundedIdentifier(providerId) || !isBoundedIdentifier(accountId)) {
    throw new TypeError("Provider event streams require bounded provider and account ids.");
  }
  const streamContext = Object.freeze({
    sessionId: contextOption.sessionId,
    threadId: contextOption.threadId,
    turnId: contextOption.turnId,
    ...(contextOption.afterEventId === undefined
      ? {}
      : { afterEventId: contextOption.afterEventId }),
    ...(contextOption.requestId === undefined ? {} : { requestId: contextOption.requestId }),
    ...(contextOption.deadlineAt === undefined ? {} : { deadlineAt: contextOption.deadlineAt }),
  });
  const context: ProviderErrorNormalizationContext = Object.freeze({
    sessionId: streamContext.sessionId,
    threadId: streamContext.threadId,
    ...(streamContext.turnId === null ? {} : { turnId: streamContext.turnId }),
    requestId: streamContext.requestId,
    deadlineAt: streamContext.deadlineAt,
    providerId,
    operation: "events",
  });
  const errorBinding = providerErrorIdentityBinding(streamContext);
  const close = async (): ProviderAdapterPromise<void> => {
    try {
      await closeProvider();
      return Object.freeze({
        kind: "success" as const,
        value: undefined,
        fallbackDecisions: Object.freeze([] as FallbackDecision[]),
      });
    } catch (cause) {
      return normalizeBoundaryFailure(providerId, errorNormalization, cause, context);
    }
  };
  const seenEventIds = new Set<EventId>();
  let previousSequence: number | undefined;
  const stream = Object.freeze({
    [providerEventStreamBoundary]: true as const,
    providerId,
    context: streamContext,
    close,
    async *[Symbol.asyncIterator]() {
      try {
        if (eventEvidenceRegistration?.providerId !== providerId) {
          throw new TypeError("Event evidence provider does not match the stream provider.");
        }
        for await (const adapterEvent of events) {
          const event = detachBoundaryValue(adapterEvent).value;
          if (
            !isProviderEvent(event, providerId, errorBinding) ||
            !providerEventMatchesStreamContext(event, providerId, accountId, streamContext)
          ) {
            throw new TypeError("Provider stream emitted a malformed event.");
          }
          if (
            event.eventId === streamContext.afterEventId ||
            seenEventIds.has(event.eventId) ||
            (previousSequence !== undefined && event.sequence <= previousSequence) ||
            seenEventIds.size >= 65_536
          ) {
            throw new TypeError("Provider stream replayed or reordered an event.");
          }
          seenEventIds.add(event.eventId);
          previousSequence = event.sequence;
          if (event.type === "fallback") {
            const visibleEvent: FallbackVisibilityEvent = {
              type: "fallback",
              eventId: event.eventId,
              providerId: event.session.providerId,
              decision: event.decision,
            };
            const validation = validateTargetResolutionUnsafe(
              {
                adapterProviderId: providerId,
                requestedTarget: event.decision.requested,
                policy: event.decision.policy,
                resolution: {
                  kind: "fallback",
                  requested: event.decision.requested,
                  resolved: event.decision.resolved,
                  decision: event.decision,
                },
                eventEvidence,
              },
              visibleEvent,
            );
            if (validation.kind === "error") {
              throw new TypeError("Provider stream emitted an invalid fallback event.");
            }
            if (
              isRecord(adapterEvent) &&
              adapterEvent.type === "fallback" &&
              isRecord(adapterEvent.decision)
            ) {
              eventEvidenceRegistration.fallbackEvents.set(adapterEvent.decision, visibleEvent);
            }
            eventEvidenceRegistration.fallbackEvents.set(event.decision, visibleEvent);
          }
          yield Object.freeze({
            kind: "success" as const,
            value: event,
            fallbackDecisions: Object.freeze([] as FallbackDecision[]),
          });
        }
      } catch (cause) {
        yield normalizeBoundaryFailure(providerId, errorNormalization, cause, context);
      }
    },
  });
  providerEventStreamRegistrations.set(
    stream,
    Object.freeze({
      providerId,
      accountId,
      eventEvidenceRegistration,
      context: streamContext,
      iterator: stream[Symbol.asyncIterator],
    }),
  );
  return stream;
}

export interface FallbackVisibilityEvent {
  readonly type: "fallback";
  readonly eventId: EventId;
  /** The provider bound to the event's session after resolution. */
  readonly providerId: ProviderId;
  readonly decision: FallbackDecision;
}

export interface TargetResolutionValidationInput {
  readonly adapterProviderId: ProviderId;
  readonly requestedTarget: ExecutionTarget;
  readonly policy: FallbackPolicy;
  readonly resolution: TargetResolution;
  readonly eventEvidence: ProviderEventEvidence<ProviderId>;
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquivalent(entry, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    jsonEquivalent(leftKeys, rightKeys) &&
    leftKeys.every((key) => jsonEquivalent(leftRecord[key], rightRecord[key]))
  );
}

function invalidTargetResolution(providerId: ProviderId, message: string): ProviderAdapterFailure {
  return {
    kind: "error",
    error: {
      code: "invalid_request",
      providerId,
      message,
      retryable: false,
      field: "targetResolution",
    },
    fallbackDecisions: [],
  };
}

function validateTargetResolutionUnsafe(
  input: TargetResolutionValidationInput,
  event: FallbackVisibilityEvent | undefined,
): ProviderAdapterResult<TargetResolution> {
  if (
    !isExecutionTarget(input.requestedTarget) ||
    !isFallbackPolicy(input.policy) ||
    !isTargetResolution(input.resolution)
  ) {
    return invalidTargetResolution(input.adapterProviderId, "The target resolution is malformed.");
  }
  if (input.requestedTarget.providerId !== input.adapterProviderId) {
    return invalidTargetResolution(input.adapterProviderId, "The requested provider does not match the adapter.");
  }

  if (input.resolution.kind === "exact") {
    if (!jsonEquivalent(input.resolution.target, input.requestedTarget) || event !== undefined) {
      return invalidTargetResolution(
        input.adapterProviderId,
        "An exact resolution must equal the requested target and must not emit a fallback event.",
      );
    }
    return { kind: "success", value: input.resolution, fallbackDecisions: [] };
  }

  if (input.policy.mode !== "allow" || event === undefined) {
    return invalidTargetResolution(
      input.adapterProviderId,
      "A fallback requires an allow policy and a visible fallback event.",
    );
  }

  const policy = input.policy;
  const resolution = input.resolution;
  const { decision } = resolution;
  if (
    !isFallbackDecision(decision) ||
    !hasValidFallbackConfirmation(decision) ||
    !jsonEquivalent(resolution.requested, input.requestedTarget) ||
    !jsonEquivalent(decision.requested, input.requestedTarget) ||
    !jsonEquivalent(decision.resolved, resolution.resolved) ||
    !jsonEquivalent(decision.policy, policy) ||
    !jsonEquivalent(event.decision, decision) ||
    event.type !== "fallback" ||
    decision.visibleEventId !== event.eventId ||
    event.providerId !== resolution.resolved.providerId
  ) {
    return invalidTargetResolution(
      input.adapterProviderId,
      "Fallback policy, targets, provider, decision, and visible event must be consistent.",
    );
  }

  const changedScopes: FallbackScope[] = [];
  if (input.requestedTarget.providerId !== resolution.resolved.providerId) changedScopes.push("provider");
  if (input.requestedTarget.accountId !== resolution.resolved.accountId) changedScopes.push("account");
  if (input.requestedTarget.modelId !== resolution.resolved.modelId) changedScopes.push("model");
  if (changedScopes.length === 0 || changedScopes.some((scope) => !policy.scopes.includes(scope))) {
    return invalidTargetResolution(
      input.adapterProviderId,
      "Every changed target dimension must be permitted by the fallback policy.",
    );
  }
  if (
    policy.allowedTargets !== undefined &&
    !policy.allowedTargets.some((target) => jsonEquivalent(target, resolution.resolved))
  ) {
    return invalidTargetResolution(input.adapterProviderId, "The resolved target is not in the policy allowlist.");
  }

  return {
    kind: "success",
    value: input.resolution,
    fallbackDecisions: [decision],
  };
}

/**
 * Enforces that every changed target is policy-authorized and visibly recorded.
 * Malformed or hostile runtime values are contained as stable validation errors.
 */
export function validateTargetResolution(
  input: TargetResolutionValidationInput,
): ProviderAdapterResult<TargetResolution> {
  let providerId: ProviderId = "unknown";
  try {
    if (typeof input.adapterProviderId === "string") providerId = input.adapterProviderId;
    const evidenceRegistration = providerEventEvidenceRegistration(input.eventEvidence);
    if (evidenceRegistration?.providerId !== providerId) {
      return invalidTargetResolution(providerId, "The event evidence provider does not match the adapter.");
    }
    const event =
      input.resolution.kind === "fallback"
        ? evidenceRegistration.fallbackEvents.get(input.resolution.decision)
        : undefined;
    return validateTargetResolutionUnsafe(input, event);
  } catch {
    return invalidTargetResolution(providerId, "The target resolution could not be validated.");
  }
}

export interface ProviderAdapterOperations<TProviderId extends ProviderId> {
  readonly discovery: {
    readonly accounts: ProviderCapabilityOperation<
      TProviderId,
      "discover_accounts",
      DiscoverAccountsRequest,
      readonly AccountDescriptor[]
    >;
    readonly models: ProviderCapabilityOperation<
      TProviderId,
      "discover_models",
      DiscoverModelsRequest,
      readonly ModelDescriptor[]
    >;
  };
  readonly sessions: {
    readonly start: ProviderCapabilityOperation<TProviderId, "start", StartSessionRequest, SessionOpened>;
    readonly resume: ProviderCapabilityOperation<TProviderId, "resume", ResumeSessionRequest, SessionOpened>;
    readonly fork: ProviderCapabilityOperation<TProviderId, "fork", ForkSessionRequest, SessionOpened>;
    readonly send: ProviderCapabilityOperation<TProviderId, "send", SendMessageRequest, SendMessageResult>;
    readonly submitToolResult: ProviderCapabilityOperation<
      TProviderId,
      "submit_tool_result",
      SubmitToolResultRequest,
      SubmitToolResultResponse
    >;
    readonly interrupt: ProviderCapabilityOperation<
      TProviderId,
      "interrupt",
      InterruptSessionRequest,
      InterruptSessionResult
    >;
    readonly events: ProviderCapabilityOperation<
      TProviderId,
      "events",
      SubscribeSessionEventsRequest,
      ProviderEventStream<TProviderId>
    >;
  };
  readonly interactions: {
    readonly respondToApproval: ProviderCapabilityOperation<
      TProviderId,
      "respond_to_approval",
      RespondToApprovalRequest,
      ApprovalResponseResult
    >;
    readonly respondToUserInput: ProviderCapabilityOperation<
      TProviderId,
      "respond_to_user_input",
      RespondToUserInputRequest,
      UserInputResponseResult
    >;
  };
  readonly telemetry: {
    readonly poll: ProviderCapabilityOperation<
      TProviderId,
      "poll_telemetry",
      PollTelemetryRequest,
      ProviderTelemetrySnapshot
    >;
  };
}

export type ProviderExtensionOperations<TProviderId extends ProviderId> = Readonly<
  Record<
    string,
    ProviderCapabilityOperation<TProviderId, `extension:${string}`, never, unknown>
  >
>;

/**
 * `TExtensions` deliberately retains each provider's own operation types rather
 * than flattening them into a least-common-denominator interface.
 */
export interface ProviderAdapterV1<
  TProviderId extends ProviderId,
  TExtensions extends ProviderExtensionOperations<TProviderId> = ProviderExtensionOperations<TProviderId>,
> {
  readonly contractVersion: ProviderAdapterContractVersion;
  readonly provider: ProviderDescriptor<TProviderId>;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly errorNormalization: ProviderErrorNormalization;
  readonly operations: ProviderAdapterOperations<TProviderId>;
  readonly extensions: TExtensions;
}

/** Provider discovery is separate because an adapter represents one provider. */
export interface ProviderAdapterCatalogV1 {
  readonly contractVersion: ProviderAdapterContractVersion;
  readonly errorNormalization: ProviderErrorNormalization;
  readonly operations: {
    readonly discoverProviders: ProviderCapabilityOperation<
      ProviderId,
      "discover_providers",
      DiscoverProvidersRequest,
      readonly ProviderDescriptor[]
    >;
    readonly resolveAdapter: ProviderCapabilityOperation<
      ProviderId,
      "resolve_adapter",
      ResolveProviderAdapterRequest,
      ProviderAdapterV1<ProviderId>
    >;
  };
}

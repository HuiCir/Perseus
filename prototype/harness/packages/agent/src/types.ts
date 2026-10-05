import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tools explicitly declaring parallel execution overlap; other tools preserve
 *   sequential batch boundaries. Result events stay in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<
	AssistantMessage["content"][number],
	{ type: "toolCall" }
>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export type SpeculativeActionMode = "exact" | "brief";

export type SpeculativeBriefStatus =
	| "useful_evidence"
	| "grounded_contradiction"
	| "no_evidence"
	| "retrieval_failure";

/** One grounded information delta extracted from an open-ended speculative read. */
export interface SpeculativeEvidenceItem {
	fact: string;
	/** A short verbatim fragment from the tool result that supports the fact. */
	support?: string;
	/** Source title, URL, record identifier, or other provenance present in the result. */
	source?: string;
}

/** Structured SE output. Only positive evidence and grounded contradictions are injectable. */
export interface SpeculativeBriefSummary {
	status: SpeculativeBriefStatus;
	evidence: SpeculativeEvidenceItem[];
}

/** One tool call proposed by a fast speculative policy. */
export interface SpeculativeActionCandidate {
	/** Exact futures may replace an identical Actor call; briefs never do. */
	mode?: SpeculativeActionMode;
	toolName: string;
	arguments: Record<string, unknown>;
	confidence?: number;
	rationale?: string;
	/** The evidence question a brief candidate is intended to explore. */
	objective?: string;
	/** Identifies calls predicted as one coherent Actor tool-call frontier. */
	draftId?: string;
	/** Stable source order within a coherent frontier. */
	draftIndex?: number;
}

/** Completed semantic evidence made visible for exactly one Actor request. */
export interface SpeculativeContextBrief {
	sourceRequestIndex: number;
	activationRequestIndex: number;
	/** Runtime-selected request boundary after checking the current context delta. */
	deliveryRequestIndex?: number;
	/** Mainline request active when the supporting tool execution completed. */
	observedRequestIndex?: number;
	turnId: string;
	toolName: string;
	speculativeArguments: Record<string, unknown>;
	actorArguments: Record<string, unknown>[];
	objective?: string;
	confidence?: number;
	status: Extract<
		SpeculativeBriefStatus,
		"useful_evidence" | "grounded_contradiction"
	>;
	evidence: SpeculativeEvidenceItem[];
	brief: string;
}

export interface SpeculativeBriefSummaryContext {
	requestIndex: number;
	turnId: string;
	candidate: SpeculativeActionCandidate;
	/** Original user instructions at launch, not model-invented relevance or a history dump. */
	taskInstructions?: string[];
	actorArguments: Record<string, unknown>[];
	result: AgentToolResult<any>;
	isError: boolean;
	signal?: AbortSignal;
}

/** A canonical Actor demand that missed every ready exact future. */
export interface SpeculativeExactMissContext {
	requestIndex: number;
	turnId: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** One finalized authoritative tool call observed by the speculative control plane. */
export interface SpeculativeAuthoritativeResultContext {
	requestIndex: number;
	turnId: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	executionMode: "parallel" | "exclusive";
	isError: boolean;
}

/** Input visible to the speculative policy at the same instant as the Actor. */
export interface SpeculativeActionsBeginContext {
	context: AgentContext;
	actorModel: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Stable authoritative session identity used only for provider cache affinity. */
	sessionId?: string;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	streamFn: StreamFn;
	signal?: AbortSignal;
	requestIndex: number;
	/** Changes only when authoritative observations or user input change, not on a timer. */
	progressRevision?: number;
	/** Worker-only lossless observation dictionary; never rewrites Actor history. */
	summarizeObservations?: boolean;
	/** Runtime-owned preparation, before action-domain routing; not an execution or model call. */
	prepareCandidate?: (candidate: SpeculativeActionCandidate) => SpeculativeActionCandidate;
	/** Runtime-owned acquisition. Only background workers await this, never the Actor. */
	executeCandidate?: (candidate: SpeculativeActionCandidate, signal?: AbortSignal) => Promise<{
		result: AgentToolResult<any>; isError: boolean;
	}>;
	/** Progress relevant to refreshing a still-running worker, not unrelated read traffic. */
	toolProgressRevision?: (toolName: string) => number;
	/** True only for successfully completed, still-valid authoritative actions. */
	isCandidateCovered?: (candidate: SpeculativeActionCandidate) => boolean;
}

/** A prediction request starts immediately and resolves without blocking the Actor. */
export interface SpeculativeActionsPrediction {
	id: string;
	candidates: Promise<SpeculativeActionCandidate[]>;
	/** Optional independently resolving frontiers. The agent consumes each batch as soon as it is ready. */
	candidateBatches?: AsyncIterable<SpeculativeActionCandidate[]>;
	cancel?: () => void;
}

export interface SpeculativeActionTraceEvent {
	event: string;
	requestIndex: number;
	turnId?: string;
	toolName?: string;
	arguments?: Record<string, unknown>;
	confidence?: number;
	[key: string]: unknown;
}

export interface SpeculativeActionsController {
  /** No-swarm retains native tools/history but serializes the authoritative ReAct loop. */
  readonly acquisitionPolicy?: import("./se-schedule.ts").AcquisitionPolicy;
	/** Refresh derived metadata without dispatching any worker. */
	observeFrontier?(context: AgentContext, requestIndex: number): void;
	beginTurn(
		input: SpeculativeActionsBeginContext,
	): SpeculativeActionsPrediction | undefined;
	isEligibleTool(toolName: string): boolean;
	/** Whether an identical candidate call may satisfy the authoritative Actor call. */
	isExactTool?(toolName: string): boolean;
	isBriefTool?(toolName: string): boolean;
	/** Refines semantic eligibility without classifying an entire meta-tool as SE. */
	isBriefInvocation?(toolName: string, args: unknown): boolean;
	summarizeBrief?(
		input: SpeculativeBriefSummaryContext,
	): Promise<SpeculativeBriefSummary | undefined>;
	publishBrief?(brief: SpeculativeContextBrief): void;
	consumeBriefs?(requestIndex: number): SpeculativeContextBrief[];
	/** Clear queued evidence when the runtime's task/tool scope is reset. */
	reset?(): void;
	/** Runtime-only feedback used to arm an on-demand semantic frontier. */
	observeExactMiss?(input: SpeculativeExactMissContext): void;
	/** Runtime-only feedback used to arm an on-demand write-side frontier. */
	observeAuthoritativeResult?(
		input: SpeculativeAuthoritativeResultContext,
	): void;
	/** Actual pre-execution feedback; never injected into the Actor conversation. */
	observeSpeculativeResult?(input: {
		requestIndex: number;
		toolName: string;
		arguments: Record<string, unknown>;
		result: AgentToolResult<any>;
		isError: boolean;
	}): void;
	record(event: SpeculativeActionTraceEvent): void;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;

	/** Optional exact-future and semantic-evidence speculation around the serial Actor call. */
	speculativeActions?: SpeculativeActionsController;

	/** A host-owned retry sequence may retain pending SE on an Actor error.
	 * The host must end the speculative run when it stops retrying. */
	shouldRetainSpeculationForRetry?: (message: AssistantMessage) => boolean;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
	) => boolean | Promise<boolean>;

	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) =>
		| AgentLoopTurnUpdate
		| undefined
		| Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": dynamically classified safe calls use a bounded rolling pool; exclusive calls
	 *   form barriers, and finalization plus tool-result artifacts stay in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Legacy caller compatibility. The lightweight 0.7 dispatcher does not impose
	 * a concurrency cap or perform invocation safety classification.
	 */
	maxParallelToolCalls?: number;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by selected model families. Use model thinking-level metadata
 * from @earendil-works/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Extended by applications through declaration merging.
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage =
	| Message
	| CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/** Optional tool-originated error flag. Throwing remains the preferred failure path. */
	isError?: boolean;
	/** A completed read observation, including a nonzero tool exit; never makes an error eligible for takeover. */
	readObservation?: "completed";
	/** Tool-owned freshness check for mutable observations; used only by the runtime, never sent to the model. */
	isCurrent?: (signal?: AbortSignal) => Promise<boolean>;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/**
 * Optional tool-owned contract used by PERSEUS to discover speculative capabilities.
 * The caller declares the core argument fields used for EX/SE head matching.
 */
export interface ToolSpeculativeCapabilities {
	/** Matching head. Omit for complete arguments. */
	headFields?: string[];
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = any> = (
	partialResult: AgentToolResult<T>,
) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<
	TParameters extends TSchema = TSchema,
	TDetails = any,
> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Create an independent native execution environment. Never fall back to authoritative execution. */
	openAcquisition?: (id: string, signal: AbortSignal) => Promise<{
		execute: AgentTool<TParameters, TDetails>["execute"];
		close: () => Promise<void>;
		provenance: { kind: "independent_work_copy"; scopeId: string; authoritative: false;
			snapshotStartedAt: number; snapshotFinishedAt: number };
	}>;
	/** Trusted action identity. Omit to require all normalized arguments to match. */
	speculativeHead?: (args: Static<TParameters>) => unknown;
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** Enforced read-only view used only by SE. No fallback to execute is allowed. */
	executeReadOnly?: AgentTool<TParameters, TDetails>["execute"];
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
	/** Tool-owned speculative execution capabilities consumed by the PERSEUS registry. */
	speculativeCapabilities?: ToolSpeculativeCapabilities;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: AgentMessage;
			toolResults: ToolResultMessage[];
	  }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| {
			type: "message_update";
			message: AgentMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: any;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: any;
			partialResult: any;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
	  };
